/**
 * OpenCode v2 CLIProxyAPI provider plugin.
 *
 * Explicit or interactive address and key -> enhanced CPA directory -> OpenCode
 * model registration -> native Responses runtime. Credentials stay in OpenCode's
 * own store; the plugin never keeps a key of its own, never logs one, and
 * exposes the connection through a small RPC so a TUI or another client can
 * read a snapshot, verify a candidate pair, refresh the directory and switch
 * connection without talking to CPA itself.
 *
 * The directory is cached per connection: a restart that finds a matching cache
 * registers its models immediately and then refreshes in the background, while a
 * failed refresh keeps the last good models instead of emptying the provider.
 *
 * Runtime parameters follow the same rule as the connection: the directory
 * declares what a model supports, the plugin maps it onto v2 model settings
 * (reasoning variants, the Fast `serviceTier`), and OpenCode's runtime does the
 * serialization. No HTTP body hook is registered, so the transport choice is
 * never altered by the plugin.
 */

import { Model, Plugin, Provider } from "@opencode/plugin"
import { DEFAULT_BASE_URL, AddressError, resolveEndpoints } from "./address"
import { fastEffectiveCount, toModelInfo, type CatalogEntry } from "./catalog"
import { connectionFingerprint, countStale, staleIds, type CatalogRecord } from "./catalog-cache"
import { CatalogService, type CatalogIdentity } from "./catalog-service"
import { createStorageCatalogStore, type CatalogStore, type StorageLike } from "./catalog-store"
import {
  planConnection,
  readCredential,
  readExplicitConfig,
  redactKey,
  type ConnectionPlan,
  type ExplicitConfig,
} from "./connection"
import { matchModelCost, toModelCost, type ModelsDevCatalog } from "./cost"
import { fastStorageKey, readFastPreference, writeFastPreference } from "./fast"
import { PLUGIN_ID, describeIssues, inspectHost } from "./host"
import { DEFAULT_MODELS_DEV_URL, fetchModelsDevCatalog } from "./models-dev"
import { CpaRpc } from "./rpc"
import { ConnectionState, connectionUpdate, verifyConnection, type ConnectionUpdate } from "./state"

/** The host context this plugin registers against. */
type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

/** An active CPA connection as the host reports it. */
type ActiveConnection = Awaited<ReturnType<Context["integration"]["connection"]["active"]>>

/** The registered CPA RPC, narrowed to what this plugin emits. */
interface CpaRegistration {
  readonly events: {
    readonly emit: (name: "changed" | "stale", data: Readonly<Record<string, unknown>>) => Promise<void>
  }
  readonly dispose: () => Promise<void>
}

/** Register (or rename) the CPA integration and its native key + address form. */
async function registerIntegration(
  ctx: Context,
  explicit: ExplicitConfig,
  integrationID: ExplicitConfig["integrationID"],
): Promise<void> {
  await ctx.integration.transform((editor) => {
    editor.update(integrationID, (integration) => {
      integration.name = explicit.providerName
    })
    editor.method.update({
      integrationID,
      method: {
        type: "key",
        label: `${explicit.providerName} API key`,
        form: [
          {
            type: "string",
            key: "baseURL",
            title: "Address",
            description: "CPA address, including any reverse proxy subpath",
            placeholder: DEFAULT_BASE_URL,
            required: true,
          },
        ],
      },
    })
  })
}

/** Bind a directory's models to the connection that produced them. */
async function bindProvider(
  ctx: Context,
  input: {
    providerID: Provider.ID
    providerName: string
    integrationID: ExplicitConfig["integrationID"]
    packageID: string
    baseURL: string
    models: readonly Model.Info[]
    sourceConnection?: ActiveConnection
  },
): Promise<void> {
  await ctx.provider.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(input.providerID),
        name: input.providerName,
        activation: "enabled",
        integrationID: input.integrationID,
        package: input.packageID,
        settings: { baseURL: input.baseURL },
      },
      models: input.models,
      ...(input.sourceConnection ? { sourceConnection: input.sourceConnection } : {}),
    })
  })
}

function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readBoolean(input: unknown, key: string): boolean | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "boolean" ? value : undefined
}

/**
 * Load the models.dev price catalog. It is a supplement: a failure is reported
 * once and the models are registered without a price estimate.
 */
async function loadCostCatalog(explicit: ExplicitConfig): Promise<{ catalog?: ModelsDevCatalog }> {
  if (explicit.modelsDev === false) return {}
  const result = await fetchModelsDevCatalog({
    url: explicit.modelsDevURL ?? DEFAULT_MODELS_DEV_URL,
    ...(explicit.modelsDevTimeoutMs !== undefined ? { timeoutMs: explicit.modelsDevTimeoutMs } : {}),
  })
  if (!result.ok) {
    console.warn(`[${PLUGIN_ID}] models.dev price estimate unavailable: ${result.message}`)
    return {}
  }
  return { catalog: result.catalog }
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    try {
      return await setupConnection(ctx)
    } catch (error) {
      // A plugin that cannot complete setup must say so once, clearly, instead
      // of leaving an empty model list behind.
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error(`[${PLUGIN_ID}] setup failed: ${detail}`)
      throw error
    }
  },
})

async function setupConnection(ctx: Context) {
  const report = inspectHost({ version: ctx.app?.version, ctx })
  if (!report.ok) {
    console.error(`[${PLUGIN_ID}] refusing to load: ${describeIssues(report.issues)}`)
    return
  }

  const explicit = readExplicitConfig(ctx.options)
  const providerID = Provider.ID.make(explicit.providerID)
  const integrationID = explicit.integrationID
  const location = String(ctx.location?.directory ?? "")

  await registerIntegration(ctx, explicit, integrationID)

  const activeConnection = await ctx.integration.connection.active(integrationID)
  const activeCredential = activeConnection
    ? readCredential(activeConnection, await ctx.integration.connection.resolve(activeConnection))
    : undefined

  // Fast is a durable, provider-scoped preference. It decides whether a model
  // that declares service tiers is asked for priority; it never changes the
  // reasoning variant.
  const fastKey = fastStorageKey(String(providerID))
  let fastEnabled = await readFastPreference(ctx.storage, fastKey)

  const state = new ConnectionState({
    location,
    providerID: String(providerID),
    integrationID: String(integrationID),
    keyHint: activeCredential ? redactKey(activeCredential.key) : "(none)",
    keySaved: activeCredential !== undefined,
    verified: "unknown",
    fastEnabled,
    fastEffectiveModels: 0,
  })

  // Price is a supplement, never a gate: the lookup runs beside the directory
  // request, and a failure only means the models carry no price estimate.
  const costPromise = loadCostCatalog(explicit)
  let costCatalog: ModelsDevCatalog | undefined

  let registration: CpaRegistration | undefined
  // Setup commits state without announcing it: the location is still booting,
  // so there are no subscribers, and awaiting the event bus here would hold up
  // model registration. Announcements start once setup has finished.
  let announce = false
  const publish = async (update: ConnectionUpdate, generation: number): Promise<void> => {
    if (!state.commit(generation, update)) return
    if (!announce) return
    await registration?.events.emit("changed", state.read())
  }

  const costFor = (entry: CatalogEntry): Model.Info["cost"] | undefined => {
    if (!costCatalog) return undefined
    const cost = matchModelCost(entry.id, costCatalog, fastEnabled)
    return cost ? toModelCost(cost) : undefined
  }

  /**
   * Map a cached directory onto model definitions. Stale models stay selectable;
   * Fast and prices follow the preference in force when the models are bound.
   */
  const modelsForRecord = async (record: CatalogRecord): Promise<Model.Info[]> => {
    costCatalog ??= (await costPromise).catalog
    return record.models.map((state) => toModelInfo(providerID, state.entry, { fast: fastEnabled, cost: costFor }))
  }

  /** How the registered models carry the Fast parameter and the price estimate. */
  const recordStats = (record: CatalogRecord, models: readonly Model.Info[]) => ({
    fastEffectiveModels: fastEffectiveCount(
      record.models.map((state) => state.entry),
      fastEnabled,
    ),
    costModels: models.filter((model) => (model.cost?.length ?? 0) > 0).length,
  })

  const store: CatalogStore = createStorageCatalogStore(ctx.storage as unknown as StorageLike)

  // A stale model is warned about once per selection, not on every request.
  let notifiedStale: string | undefined
  const service = new CatalogService({
    store,
    read: ({ identity, signal }) =>
      verifyConnection({
        address: identity.address,
        apiKey: identity.key,
        ...(explicit.catalogTimeoutMs !== undefined ? { timeoutMs: explicit.catalogTimeoutMs } : {}),
        signal,
      }),
    ...(explicit.catalogStaleTtlMs !== undefined ? { staleTtlMs: explicit.catalogStaleTtlMs } : {}),
    onCommit: async ({ generation, record, kind }) => {
      const models = await modelsForRecord(record)
      const connection = await ctx.integration.connection.active(integrationID)
      await bindProvider(ctx, {
        providerID,
        providerName: explicit.providerName,
        integrationID,
        packageID: explicit.package,
        baseURL: record.baseURL,
        models,
        ...(connection ? { sourceConnection: connection } : {}),
      })
      await publish(
        {
          catalogModels: models.length,
          catalogFetchedAt: record.fetchedAt,
          catalogStaleModels: countStale(record),
          catalogStaleIds: staleIds(record),
          catalogFromCache: false,
          verified: "ok",
          verifyKind: kind,
          verifyMessage: undefined,
          ...recordStats(record, models),
        },
        generation,
      )
      if (notifiedStale !== undefined && !service.isStale(notifiedStale)) notifiedStale = undefined
    },
    onFailure: async ({ generation, kind, message }) => {
      // The directory is kept as it was; only the connection verdict changes.
      await publish({ verified: "failed", verifyKind: kind, verifyMessage: message }, generation)
    },
  })

  registration = await ctx.rpc.register(CpaRpc, {
    // Read-only snapshot; a status reader never triggers a CPA request.
    status: async () => state.read(),

    // Probe an address/key pair. Nothing is saved and the active connection is
    // left exactly as it was, so a failed attempt cannot damage it.
    verify: async (input) => {
      const address = readString(input, "address")
      if (!address) {
        return { ok: false, kind: "address", message: "an address is required", snapshot: state.read() }
      }
      let key = readString(input, "key")
      if (!key) {
        const connection = await ctx.integration.connection.active(integrationID)
        const credential = connection
          ? readCredential(connection, await ctx.integration.connection.resolve(connection))
          : undefined
        key = credential?.key
      }
      if (!key) {
        return {
          ok: false,
          kind: "auth",
          message: "no API key is available to verify; connect this integration first",
          snapshot: state.read(),
        }
      }
      const outcome = await verifyConnection({
        address,
        apiKey: key,
        ...(explicit.catalogTimeoutMs !== undefined ? { timeoutMs: explicit.catalogTimeoutMs } : {}),
      })
      return {
        ok: outcome.ok,
        kind: outcome.kind,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
        models: outcome.entries.length,
        snapshot: state.read(),
      }
    },

    // Re-read the active connection's directory, bypassing the cache. A failed
    // read leaves the served models untouched.
    refresh: async () => {
      if (!service.ready) {
        return {
          ok: false,
          kind: "address",
          message: "no CPA connection is active; connect this integration first",
          snapshot: state.read(),
        }
      }
      const outcome = await service.refresh({ generation: state.generation, mode: "manual" })
      const record = service.current()
      return {
        ok: outcome.ok,
        kind: outcome.kind,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
        ...(record ? { models: record.models.length } : {}),
        snapshot: state.read(),
      }
    },

    // Verify first, then save through the native key method. A stale attempt
    // that lost a race with a newer connection change saves nothing.
    connect: async (input) => {
      const address = readString(input, "address")
      const key = readString(input, "key")
      if (!address || !key) {
        return {
          ok: false,
          kind: "address",
          message: "an address and an API key are both required",
          snapshot: state.read(),
        }
      }
      let endpoints
      try {
        endpoints = resolveEndpoints(address)
      } catch (error) {
        const detail = error instanceof AddressError ? error.message : String(error)
        return { ok: false, kind: "address", message: detail, snapshot: state.read() }
      }

      const generation = state.begin()
      const identity: CatalogIdentity = {
        address,
        key,
        baseURL: endpoints.baseURL,
        modelsURL: endpoints.modelsURL,
        fingerprint: connectionFingerprint(endpoints.baseURL, key),
      }
      // Applied synchronously, so a refresh for the previous connection can no
      // longer commit even while this one is still being verified.
      await service.activate(identity, generation)

      const outcome = await verifyConnection({
        address,
        apiKey: key,
        ...(explicit.catalogTimeoutMs !== undefined ? { timeoutMs: explicit.catalogTimeoutMs } : {}),
      })
      if (!state.isCurrent(generation)) {
        return {
          ok: false,
          kind: "unreachable",
          message: "the connection changed while this pair was being verified; nothing was saved",
          snapshot: state.read(),
        }
      }
      if (!outcome.ok) {
        return {
          ok: false,
          kind: outcome.kind,
          ...(outcome.message !== undefined ? { message: outcome.message } : {}),
          snapshot: state.read(),
        }
      }

      await ctx.integration.connect.key({ integrationID, key, answer: { baseURL: address } })
      // Commits the merged catalog (fresh plus any stale models of this
      // connection) and rebinds the provider.
      await service.applyRead({ generation, entries: outcome.entries, kind: outcome.kind })
      await publish(
        connectionUpdate({
          address,
          addressSource: "wizard",
          keySource: "wizard",
          key,
          keySaved: true,
          verified: "ok",
          verifyKind: outcome.kind,
        }),
        generation,
      )
      return {
        ok: true,
        kind: outcome.kind,
        models: service.current()?.models.length ?? outcome.entries.length,
        snapshot: state.read(),
      }
    },

    // Persist the Fast preference. The registered models only change when the
    // host rebuilds the provider registry, which is a location reload (or a
    // service restart); the snapshot keeps preference and effective state apart.
    setFast: async (input) => {
      const enabled = readBoolean(input, "enabled")
      if (enabled === undefined) {
        return { ok: false, message: "enabled must be a boolean", snapshot: state.read() }
      }
      if (enabled !== fastEnabled) {
        fastEnabled = enabled
        try {
          await writeFastPreference(ctx.storage, fastKey, enabled)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          console.warn(`[${PLUGIN_ID}] could not persist the Fast preference: ${detail}`)
        }
        state.patch({ fastEnabled })
        await registration?.events.emit("changed", state.read())
      }
      return { ok: true, snapshot: state.read() }
    },
  })

  // Warn once when a request actually selects a model retained as stale, so the
  // user is not told the upstream is still serving it.
  const staleHook = await ctx.session.hook(
    "model.request",
    (input) => {
      const modelID = String(input.model.id)
      if (!service.isStale(modelID) || notifiedStale === modelID) return
      notifiedStale = modelID
      void registration?.events.emit("stale", { modelID })
    },
    { providerID },
  )

  const cleanup = async () => {
    service.dispose()
    await staleHook?.dispose()
    await registration?.dispose()
  }

  // Initial connection from explicit configuration or the stored credential.
  const planned = planConnection({ explicit, active: activeCredential })
  const generation = state.begin()
  if (!planned.ok) {
    state.commit(generation, {
      keyHint: activeCredential ? redactKey(activeCredential.key) : "(none)",
      keySaved: activeCredential !== undefined,
      verified: "unknown",
      verifyMessage: planned.reason,
    })
    console.error(`[${PLUGIN_ID}] not registering models: ${planned.reason}`)
    return cleanup
  }
  const plan: ConnectionPlan = planned.plan

  if (plan.store) {
    await ctx.integration.connect.key({
      integrationID,
      key: plan.key,
      answer: { baseURL: plan.address },
    })
  }

  let endpoints
  try {
    endpoints = resolveEndpoints(plan.address)
  } catch (error) {
    const detail = error instanceof AddressError ? error.message : String(error)
    state.commit(
      generation,
      connectionUpdate({
        address: plan.address,
        addressSource: plan.addressSource,
        keySource: plan.keySource,
        key: plan.key,
        keySaved: true,
        verified: "failed",
        verifyKind: "address",
        verifyMessage: detail,
      }),
    )
    console.error(`[${PLUGIN_ID}] not registering models: ${detail}`)
    return cleanup
  }

  const identity: CatalogIdentity = {
    address: plan.address,
    key: plan.key,
    baseURL: endpoints.baseURL,
    modelsURL: endpoints.modelsURL,
    fingerprint: connectionFingerprint(endpoints.baseURL, plan.key),
  }
  const cached = await service.activate(identity, generation)
  if (!state.isCurrent(generation)) return cleanup

  const sourceConnection = plan.store
    ? ((await ctx.integration.connection.active(integrationID)) ?? activeConnection)
    : activeConnection

  if (cached) {
    // Fast start: register the cached directory, then refresh in the background.
    const models = await modelsForRecord(cached)
    await bindProvider(ctx, {
      providerID,
      providerName: explicit.providerName,
      integrationID,
      packageID: explicit.package,
      baseURL: cached.baseURL,
      models,
      ...(sourceConnection ? { sourceConnection } : {}),
    })
    state.commit(generation, {
      address: plan.address,
      addressSource: plan.addressSource,
      keySource: plan.keySource,
      keyHint: redactKey(plan.key),
      keySaved: true,
      verified: "unknown",
      catalogModels: models.length,
      catalogFetchedAt: cached.fetchedAt,
      catalogStaleModels: countStale(cached),
      catalogStaleIds: staleIds(cached),
      catalogFromCache: true,
      ...recordStats(cached, models),
    })
    announce = true
    console.log(
      `[${PLUGIN_ID}] serving ${models.length} cached models for ${cached.modelsURL} ` +
        `(connection ${plan.mode}, key ${redactKey(plan.key)}, fast ${fastEnabled ? "on" : "off"}, ` +
        `prices ${state.read().costModels ?? 0}); refreshing in the background`,
    )
    void service.refresh({ generation, mode: "background" }).catch((error) => {
      console.error(`[${PLUGIN_ID}] background refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return cleanup
  }

  const outcome = await service.refresh({ generation, mode: "initial" })
  if (!state.isCurrent(generation)) return cleanup
  if (!outcome.committed) {
    // The credential is saved even though the directory could not be read; the
    // snapshot must still say so instead of looking unconfigured.
    state.commit(generation, {
      address: plan.address,
      addressSource: plan.addressSource,
      keySource: plan.keySource,
      keyHint: redactKey(plan.key),
      keySaved: true,
    })
    const detail = outcome.message ?? outcome.kind
    console.error(`[${PLUGIN_ID}] connection saved but not verified at ${endpoints.modelsURL} (${detail})`)
    return cleanup
  }

  const record = service.current()
  announce = true
  state.commit(generation, {
    address: plan.address,
    addressSource: plan.addressSource,
    keySource: plan.keySource,
    keyHint: redactKey(plan.key),
    keySaved: true,
  })
  if (!record || record.models.length === 0) {
    console.warn(`[${PLUGIN_ID}] ${endpoints.modelsURL} returned an empty directory; no models are selectable`)
  }
  console.log(
    `[${PLUGIN_ID}] registered ${record?.models.length ?? 0} models from ${endpoints.modelsURL} ` +
      `(connection ${plan.mode}, key ${redactKey(plan.key)}, address from ${plan.addressSource}, ` +
      `fast ${fastEnabled ? "on" : "off"}, prices ${state.read().costModels ?? 0})`,
  )

  return cleanup
}
