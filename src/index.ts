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
import { ContinuationReset, SOCKET_HEADER } from "./continuation"
import { PauseGate } from "./pause"
import { CpaRpc } from "./rpc"
import { SessionStatsTracker, type SessionEventLike } from "./stats"
import { ConnectionState, connectionUpdate, verifyConnection, type ConnectionUpdate } from "./state"
import { directoryPrefersWebSocket, planCompaction, planTransport, type CompactionPolicy, type TransportPolicy } from "./transport"

/** The host context this plugin registers against. */
type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

/** An active CPA connection as the host reports it. */
type ActiveConnection = Awaited<ReturnType<Context["integration"]["connection"]["active"]>>

/** The registered CPA RPC, narrowed to what this plugin emits. */
interface CpaRegistration {
  readonly events: {
    readonly emit: (
      name: "changed" | "stale" | "pause.changed" | "stats.changed",
      data: Readonly<Record<string, unknown>>,
    ) => Promise<void>
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

/** The directory inventory bound to one CPA connection. */
interface ProviderBinding {
  readonly providerID: Provider.ID
  readonly providerName: string
  readonly integrationID: ExplicitConfig["integrationID"]
  readonly packageID: string
  readonly transport: TransportPolicy["transport"]
  readonly compaction: CompactionPolicy["type"]
  readonly baseURL: string
  readonly models: readonly Model.Info[]
  readonly sourceConnection?: ActiveConnection
}

interface ProviderBinder {
  /** Replace the bound directory and rebuild the registry that resolves it. */
  bind(input: ProviderBinding): Promise<void>
  dispose(): Promise<void>
}

/**
 * Keep one provider transform registered and republish the current binding.
 *
 * The host replays the registered callback on every registry rebuild, so the
 * callback has to read the *current* binding: registering a fresh transform per
 * refresh would leave the stale captured inventory in place, and a `reload()`
 * would replay that stale inventory. `bind` also calls `provider.reload()`, which
 * is the public way to carry a changed binding into the registry.
 */
async function createProviderBinder(ctx: Context): Promise<ProviderBinder> {
  let binding: ProviderBinding | undefined
  const registration = await ctx.provider.transform((editor) => {
    if (!binding) return
    editor.add({
      info: {
        ...Provider.Info.empty(binding.providerID),
        name: binding.providerName,
        activation: "enabled",
        integrationID: binding.integrationID,
        package: binding.packageID,
        // The transport is an explicit provider setting: the host falls back to
        // HTTP/SSE with a warning when the chosen package has no WS channel.
        settings: {
          baseURL: binding.baseURL,
          transport: binding.transport,
          compaction: { type: binding.compaction },
        },
      },
      models: binding.models,
      ...(binding.sourceConnection ? { sourceConnection: binding.sourceConnection } : {}),
    })
  })
  return {
    async bind(input) {
      binding = input
      await ctx.provider.reload()
    },
    dispose: () => registration.dispose(),
  }
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

  /** One transport decision per directory read; the host selects transport per provider. */
  const policyFor = (entries: readonly CatalogEntry[]): TransportPolicy =>
    planTransport({
      preference: explicit.transport,
      directoryPrefersWebSocket: directoryPrefersWebSocket(entries),
      httpPackage: explicit.package,
      websocketPackage: explicit.websocketPackage,
      ...(explicit.transportInvalid !== undefined ? { invalidPreference: explicit.transportInvalid } : {}),
    })

  /** Native compaction is only declared when the chosen runtime package exposes it. */
  const compactionFor = (policy: TransportPolicy): CompactionPolicy =>
    planCompaction({
      preference: explicit.compaction,
      package: policy.package,
      ...(explicit.compactionInvalid !== undefined ? { invalidPreference: explicit.compactionInvalid } : {}),
    })

  // Session stats are aggregated per session id; the pause gate is per location.
  // A paused model call waits on a promise, so cancelling the session or
  // unloading the plugin ends the wait without leaving a timer behind.
  const stats = new SessionStatsTracker()
  const pause = new PauseGate({
    onWaitStart: (sessionID) => stats.notePauseStart(sessionID),
    onWaitEnd: (sessionID) => stats.notePauseEnd(sessionID),
  })

  await registerIntegration(ctx, explicit, integrationID)

  // The provider transform is registered once and always reads the current
  // binding, so a rebuild after a connection change republishes the new
  // directory instead of replaying a stale captured inventory.
  const binder = await createProviderBinder(ctx)

  // A summary must drop CPA's server-side continuation state. The handshake
  // hook is the public way to make the host open a fresh socket for the next
  // turn; it is registered for every transport and only fires for WebSocket
  // requests, so an HTTP connection is untouched.
  const continuation = new ContinuationReset()
  const compactionHook = await ctx.session.hook(
    "compaction",
    (input) => {
      continuation.markCompacted(input.sessionID)
    },
    { providerID: String(providerID) },
  )
  const handshakeHook = await ctx.session.hook(
    "experimental.ws.handshake",
    (input) => {
      input.headers = { ...input.headers, [SOCKET_HEADER]: continuation.socketGeneration(input.sessionID) }
    },
    { providerID: String(providerID) },
  )
  // Native compaction keeps the socket: the checkpoint request itself is a frame
  // on it, so the pre-compaction state has to be dropped on the frame *after*
  // that request. The trigger marker is the host's own request control.
  const sendHook = await ctx.session.hook(
    "experimental.ws.send",
    (input) => {
      if (input.frame.includes("compaction_trigger")) continuation.markCompacted(input.sessionID)
    },
    { providerID: String(providerID) },
  )

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
  // Interactive connects verify before they touch anything, and only one commit
  // may be in flight at a time: a later connect supersedes an earlier one and
  // the earlier one must not save its credential after the later one committed.
  let connectQueue: Promise<unknown> = Promise.resolve()
  const withConnectLock = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = connectQueue.then(task, task)
    connectQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
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
      // The transport is a property of the directory this record came from, so a
      // cached record restores the same decision a fresh read would have made.
      const policy = policyFor(record.models.map((state) => state.entry))
      const compaction = compactionFor(policy)
      const connection = await ctx.integration.connection.active(integrationID)
      await binder.bind({
        providerID,
        providerName: explicit.providerName,
        integrationID,
        packageID: policy.package,
        transport: policy.transport,
        compaction: compaction.type,
        baseURL: record.baseURL,
        models,
        ...(connection ? { sourceConnection: connection } : {}),
      })
      if (policy.note) console.warn(`[${PLUGIN_ID}] transport: ${policy.note}`)
      if (compaction.note) console.warn(`[${PLUGIN_ID}] compaction: ${compaction.note}`)
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
          transport: policy.transport,
          transportSource: policy.source,
          directoryPrefersWebSocket: policy.directoryPrefersWebSocket,
          transportNote: policy.note,
          compaction: compaction.type,
          compactionNote: compaction.note,
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

      // Reserving the generation here (not inside the lock) means a later
      // connect immediately supersedes an earlier one that is still verifying.
      // The service adopts it too, so a candidate that never verifies leaves the
      // active connection refreshable under the new generation.
      const generation = state.begin()
      service.adoptGeneration(generation)
      const identity: CatalogIdentity = {
        address,
        key,
        baseURL: endpoints.baseURL,
        modelsURL: endpoints.modelsURL,
        fingerprint: connectionFingerprint(endpoints.baseURL, key),
      }

      return withConnectLock(async () => {
        const changed = {
          ok: false as const,
          kind: "unreachable" as const,
          message: "the connection changed while this pair was being verified; nothing was saved",
          snapshot: state.read(),
        }
        if (!state.isCurrent(generation)) return changed

        // The candidate is verified before the active connection is touched, so
        // a failed attempt leaves the service, its cache and the credential
        // exactly as they were.
        const outcome = await verifyConnection({
          address,
          apiKey: key,
          ...(explicit.catalogTimeoutMs !== undefined ? { timeoutMs: explicit.catalogTimeoutMs } : {}),
        })
        if (!state.isCurrent(generation)) return changed
        if (!outcome.ok) {
          return {
            ok: false as const,
            kind: outcome.kind,
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
            snapshot: state.read(),
          }
        }

        // Verified: bind the service to this pair and commit it as one unit.
        // Activating invalidates any in-flight read of the previous connection.
        await service.activate(identity, generation)
        if (!state.isCurrent(generation)) return changed
        await ctx.integration.connect.key({ integrationID, key, answer: { baseURL: address } })
        if (!state.isCurrent(generation)) return changed
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
      })
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

    // Pause and resume are server-side: the gate holds the next model call, and
    // the resume never waits on a model call itself.
    pause: async () => {
      const next = pause.pause()
      await registration?.events.emit("pause.changed", next)
      return next
    },
    resume: async () => {
      const next = pause.resume()
      await registration?.events.emit("pause.changed", next)
      return next
    },
    pauseState: async () => pause.read(),

    // Stats read from the server's own aggregate; an unknown session is an
    // absent field, never a fabricated zero-filled one.
    stats: async (input) => {
      const sessionID = readString(input, "sessionID")
      const value = sessionID ? stats.read(sessionID) : undefined
      return value ? { stats: value } : {}
    },
    sessions: async () => ({ sessions: stats.list() }),
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

  // Gate this provider's model calls. The host filters by providerID, so no
  // other provider's requests reach this hook. The host interrupts the call's
  // fiber on cancel, which is what ends the wait.
  const hook = await ctx.session.hook(
    "model.request",
    async (input) => {
      await pause.wait(String(input.sessionID))
    },
    { providerID: String(providerID) },
  )

  // Session events feed the stats and release the waits of a cancelled session.
  // `location.shutdown` is the host's unload signal for this generation: the
  // host does not settle an in-flight hook by itself, so end the held waits and
  // stop the stream here instead of leaving them to a cleanup the host does not
  // call on a live reload.
  const subscription = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
        const type = (event as { type?: string }).type
        if (type === "location.shutdown") {
          pause.close()
          subscription.abort()
          break
        }
        const observed = stats.observe(event as SessionEventLike)
        if (!observed) continue
        if (type === "session.execution.interrupted") {
          pause.cancel(observed.sessionID)
        }
        if (observed.boundary) {
          const snapshot = stats.read(observed.sessionID)
          if (snapshot) await registration?.events.emit("stats.changed", snapshot)
        }
      }
    } catch {
      // The event stream ends with the location; there is nothing to report.
    }
  })()

  const cleanup = async () => {
    subscription.abort()
    pause.releaseAll()
    service.dispose()
    await binder.dispose()
    await hook.dispose()
    await staleHook?.dispose()
    await registration?.dispose()
    await compactionHook.dispose()
    await handshakeHook.dispose()
    await sendHook.dispose()
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
    // The cached directory carries the transport metadata too, so a restored
    // model selects the same transport it would after a fresh read.
    const policy = policyFor(cached.models.map((state) => state.entry))
    const compaction = compactionFor(policy)
    await binder.bind({
      providerID,
      providerName: explicit.providerName,
      integrationID,
      packageID: policy.package,
      transport: policy.transport,
      compaction: compaction.type,
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
      transport: policy.transport,
      transportSource: policy.source,
      directoryPrefersWebSocket: policy.directoryPrefersWebSocket,
      transportNote: policy.note,
      compaction: compaction.type,
      compactionNote: compaction.note,
      ...recordStats(cached, models),
    })
    announce = true
    if (policy.note) console.warn(`[${PLUGIN_ID}] transport: ${policy.note}`)
    if (compaction.note) console.warn(`[${PLUGIN_ID}] compaction: ${compaction.note}`)
    console.log(
      `[${PLUGIN_ID}] serving ${models.length} cached models for ${cached.modelsURL} ` +
        `(connection ${plan.mode}, key ${redactKey(plan.key)}, transport ${policy.transport}, ` +
        `fast ${fastEnabled ? "on" : "off"}, ` +
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
    // A failed read still reports the transport of whatever directory is being
    // served, so a cached connection keeps its decision visible. The failure
    // verdict itself was already published by the service's failure callback.
    const failedPolicy = policyFor(service.current()?.models.map((entry) => entry.entry) ?? [])
    const failedCompaction = compactionFor(failedPolicy)
    state.commit(generation, {
      address: plan.address,
      addressSource: plan.addressSource,
      keySource: plan.keySource,
      keyHint: redactKey(plan.key),
      keySaved: true,
      transport: failedPolicy.transport,
      transportSource: failedPolicy.source,
      directoryPrefersWebSocket: failedPolicy.directoryPrefersWebSocket,
      transportNote: failedPolicy.note,
      compaction: failedCompaction.type,
      compactionNote: failedCompaction.note,
    })
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
      `transport ${state.read().transport ?? "http"}, ` +
      `fast ${fastEnabled ? "on" : "off"}, prices ${state.read().costModels ?? 0})`,
  )

  return cleanup
}
