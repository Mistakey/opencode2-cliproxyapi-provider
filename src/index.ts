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
  bind(input: ProviderBinding): Promise<{ pending: boolean }>
  /** The runtime has compiled the current binding at location boot. */
  markApplied(): void
  dispose(): Promise<void>
}

/**
 * Stable identity of what the runtime must compile: everything that changes a
 * request (address, package, transport, per-model settings/variants/limits).
 * Used to tell a real directory change from a refresh that found the same one.
 */
function bindingSignature(input: ProviderBinding): string {
  return JSON.stringify({
    providerID: String(input.providerID),
    providerName: input.providerName,
    integrationID: String(input.integrationID),
    packageID: input.packageID,
    transport: input.transport,
    compaction: input.compaction,
    baseURL: input.baseURL,
    sourceConnection: input.sourceConnection ? JSON.stringify(input.sourceConnection) : null,
    models: input.models
      .map((model) => ({
        id: String(model.modelID),
        enabled: model.enabled,
        settings: model.settings ?? null,
        variants: (model.variants ?? []).map((variant) => ({ id: String(variant.id), settings: variant.settings })),
        limit: model.limit ?? null,
        capabilities: model.capabilities ?? null,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  })
}

/**
 * Priority model ids per provider, shared by every plugin instance in this
 * process. OpenCode can run a global and a location instance for the same
 * provider, and the request hook may live on a different instance than the RPC
 * that saved the directory. The registry hangs off `globalThis` under a symbol
 * so it is shared even when the host loads the plugin as two module instances.
 * Keeping the saved set in memory lets the hook see the newest saved directory
 * without reading the cache, so a cache read or write failure can never change
 * a wire parameter.
 */
const SAVED_PRIORITY_KEY = Symbol.for("opencode2-cliproxyapi-provider.saved-priority")
const savedPriorityByProvider: Map<string, ReadonlySet<string>> = (() => {
  const globalState = globalThis as unknown as { [SAVED_PRIORITY_KEY]?: Map<string, ReadonlySet<string>> }
  globalState[SAVED_PRIORITY_KEY] ??= new Map()
  return globalState[SAVED_PRIORITY_KEY]
})()
const EMPTY_PRIORITY: ReadonlySet<string> = new Set()

/**
 * Keep one provider transform registered and republish the current binding.
 *
 * The host replays the registered callback on every registry rebuild, so the
 * callback has to read the *current* binding: registering a fresh transform per
 * refresh would leave the stale captured inventory in place, and a `reload()`
 * would replay that stale inventory. `bind` also calls `provider.reload()`, which
 * is the public way to carry a changed binding into the registry.
 *
 * The runtime only compiles that registry at location boot, so `bind` reports
 * whether the new binding differs from the one the boot compile picked up: that
 * is the machine-readable boundary a headless caller acts on with a location
 * reload, and it is why a refresh that found the same directory is not pending.
 */
async function createProviderBinder(ctx: Context): Promise<ProviderBinder> {
  let binding: ProviderBinding | undefined
  let appliedSignature: string | undefined
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
      return {
        pending: appliedSignature !== undefined && bindingSignature(input) !== appliedSignature,
      }
    },
    markApplied() {
      if (binding) appliedSignature = bindingSignature(binding)
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
    applied: true,
    reloadRequired: false,
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
  // One Fast change at a time: the preference write and the rebind are ordered,
  // so two overlapping toggles cannot leave the saved preference and the
  // effective setting disagreeing.
  let fastChangeInProgress = false
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

  // The Fast effect the runtime actually has compiled. A live rebind changes the
  // registered models but not the compiled ones, so this only moves when the
  // binding is applied (at boot) or a bind found the same directory again.
  let appliedFastEffectiveModels = 0
  // Model ids the compiled binding currently asks for priority. Used to refuse a
  // new dispatch that would send a tier the saved directory has withdrawn.
  let appliedPriorityModels = new Set<string>()

  const priorityModels = (models: readonly Model.Info[]): Set<string> =>
    new Set(
      models
        .filter((model) => (model.settings as { serviceTier?: string } | undefined)?.serviceTier !== undefined)
        .map((model) => String(model.modelID)),
    )

  /**
   * Model ids the newest saved directory and preference currently ask for
   * priority, for this connection, as committed by any instance of this
   * process. The cache is only a startup optimization, so this never reads
   * storage.
   */
  const savedPriorityModels = (): ReadonlySet<string> => {
    const fingerprint = service.current()?.fingerprint
    if (!fingerprint) return EMPTY_PRIORITY
    return savedPriorityByProvider.get(`${String(providerID)}\n${fingerprint}`) ?? EMPTY_PRIORITY
  }

  /**
   * Resolve the host's active credential for a record and check it is the one the
   * record belongs to. A refresh that read the previous connection must not bind
   * its directory to a credential the user has since saved for another pair.
   */
  const activeConnectionFor = async (
    record: CatalogRecord,
  ): Promise<{ connection: ActiveConnection | undefined; matches: boolean }> => {
    const connection = await ctx.integration.connection.active(integrationID)
    if (!connection) return { connection: undefined, matches: true }
    const credential = readCredential(connection, await ctx.integration.connection.resolve(connection))
    if (!credential?.baseURL) return { connection, matches: true }
    try {
      const endpoints = resolveEndpoints(credential.baseURL)
      return { connection, matches: connectionFingerprint(endpoints.baseURL, credential.key) === record.fingerprint }
    } catch {
      return { connection, matches: false }
    }
  }

  /**
   * Publish one directory as the provider binding.
   *
   * Returns whether the runtime still needs a location reload before it
   * dispatches this binding; the caller puts that in the snapshot so a headless
   * client can act on it instead of trusting the visible model list. Returns
   * `undefined` when the commit lost ownership or the record does not belong to
   * the active credential, in which case nothing is published.
   */
  const applyBinding = async (
    record: CatalogRecord,
  ): Promise<
    | {
        pending: boolean
        models: Model.Info[]
        policy: TransportPolicy
        compaction: CompactionPolicy
      }
    | undefined
  > => {
    const models = await modelsForRecord(record)
    // The transport is a property of the directory this record came from, so a
    // cached record restores the same decision a fresh read would have made.
    const policy = policyFor(record.models.map((state) => state.entry))
    const compaction = compactionFor(policy)
    const { connection, matches } = await activeConnectionFor(record)
    // A connection change while this bind was being prepared invalidates it.
    if (!matches) return undefined
    const priority = priorityModels(models)
    // The newest saved directory and preference for this connection, visible to
    // every instance's request hook. A pending bind leaves the compiled applied
    // set alone; the saved set always follows the newest commit.
    savedPriorityByProvider.set(`${String(providerID)}\n${record.fingerprint}`, fastEnabled ? priority : EMPTY_PRIORITY)
    const bound = await binder.bind({
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
    if (!bound.pending) {
      appliedFastEffectiveModels = recordStats(record, models).fastEffectiveModels
      appliedPriorityModels = priority
    }
    if (policy.note) console.warn(`[${PLUGIN_ID}] transport: ${policy.note}`)
    if (compaction.note) console.warn(`[${PLUGIN_ID}] compaction: ${compaction.note}`)
    return { pending: bound.pending, models, policy, compaction }
  }

  const store: CatalogStore = createStorageCatalogStore(ctx.storage as unknown as StorageLike)

  // A stale model is warned about once per selection, not on every request.
  let notifiedStale: string | undefined
  // Set when the location unloads. A connect that already saved its key must not
  // claim it became active after the plugin was disposed.
  let disposed = false
  // Candidate order for interactive connects. The native save is the point of no
  // return, so a later candidate only supersedes an earlier one that has not
  // saved yet.
  let connectSeq = 0
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
      const applied = await applyBinding(record)
      if (!applied) return
      const { pending, models, policy, compaction } = applied
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
          applied: !pending,
          reloadRequired: pending,
          fastEffectiveModels: appliedFastEffectiveModels,
          costModels: recordStats(record, models).costModels,
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

    // Probe an explicit address/key pair. Nothing is saved and the active
    // connection is left exactly as it was, so a failed attempt cannot damage
    // it. Both halves are required: the active credential is never borrowed, so
    // a missing or blank key is refused before any request leaves the plugin.
    verify: async (input) => {
      const address = readString(input, "address")
      if (!address) {
        return { ok: false, kind: "address", message: "an address is required", snapshot: state.read() }
      }
      const key = readString(input, "key")
      if (!key) {
        return {
          ok: false,
          kind: "auth",
          message: "an API key is required to verify; nothing was sent",
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

      // Candidate order decides supersession: a later connect stops an earlier
      // one that has not saved yet. The native save itself is the point of no
      // return and is never undone.
      const candidate = ++connectSeq
      const identity: CatalogIdentity = {
        address,
        key,
        baseURL: endpoints.baseURL,
        modelsURL: endpoints.modelsURL,
        fingerprint: connectionFingerprint(endpoints.baseURL, key),
      }

      return withConnectLock(async () => {
        const superseded = {
          ok: false as const,
          kind: "unreachable" as const,
          message: "the connection changed while this pair was being verified; nothing was saved",
          snapshot: state.read(),
        }
        if (candidate !== connectSeq) return superseded

        // The candidate is verified before the active connection is touched, so
        // a failed attempt leaves the service, its cache and the credential
        // exactly as they were.
        const outcome = await verifyConnection({
          address,
          apiKey: key,
          ...(explicit.catalogTimeoutMs !== undefined ? { timeoutMs: explicit.catalogTimeoutMs } : {}),
        })
        if (candidate !== connectSeq) return superseded
        if (!outcome.ok) {
          return {
            ok: false as const,
            kind: outcome.kind,
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
            snapshot: state.read(),
          }
        }

        // Saving through the native key method is the commit point. Once it
        // resolves the host's active credential is this pair, so the plugin must
        // adopt it even if a later candidate has since been requested; otherwise
        // the credential store, the served directory and the snapshot would
        // disagree. A save that fails leaves the previous connection untouched.
        try {
          await ctx.integration.connect.key({ integrationID, key, answer: { baseURL: address } })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return {
            ok: false as const,
            kind: "unreachable" as const,
            message: `the API key could not be saved: ${detail}`,
            snapshot: state.read(),
          }
        }
        if (disposed) {
          return {
            ok: false as const,
            kind: "unreachable" as const,
            message: "the plugin unloaded after this key was saved; the saved key is not active",
            snapshot: state.read(),
          }
        }

        // Claim a fresh generation so an in-flight refresh of the previous
        // connection is invalidated; activating drops any read of it and makes
        // this pair the identity the service commits under.
        const generation = state.begin()
        await service.activate(identity, generation)
        await service.applyRead({ generation, entries: outcome.entries, kind: outcome.kind })
        if (disposed) {
          return {
            ok: false as const,
            kind: "unreachable" as const,
            message: "the plugin unloaded after this key was saved; the saved key is not active",
            snapshot: state.read(),
          }
        }
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

    // Persist the Fast preference. Rebinding publishes the new per-model
    // settings, but the runtime keeps the previous ones until a location reload,
    // so the snapshot reports that boundary instead of claiming the new
    // preference is effective.
    setFast: async (input) => {
      const enabled = readBoolean(input, "enabled")
      if (enabled === undefined) {
        return { ok: false, message: "enabled must be a boolean", snapshot: state.read() }
      }
      if (fastChangeInProgress) {
        return { ok: false, message: "a Fast change is already in progress", snapshot: state.read() }
      }
      if (enabled !== fastEnabled) {
        fastChangeInProgress = true
        try {
          fastEnabled = enabled
          try {
            await writeFastPreference(ctx.storage, fastKey, enabled)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            console.warn(`[${PLUGIN_ID}] could not persist the Fast preference: ${detail}`)
          }
          const applied = await service.rebind((record) => applyBinding(record))
          if (applied) {
            const { pending } = applied
            await publish(
              {
                fastEnabled,
                applied: !pending,
                reloadRequired: pending,
                fastEffectiveModels: appliedFastEffectiveModels,
              },
              state.generation,
            )
          } else {
            state.patch({ fastEnabled })
            await registration?.events.emit("changed", state.read())
          }
        } finally {
          fastChangeInProgress = false
        }
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
      // The runtime dispatches the directory it compiled at boot. When the saved
      // directory has withdrawn a model's service tier, a new request would
      // still carry the withdrawn priority until the location reloads. Refuse
      // that new dispatch rather than send a parameter the directory no longer
      // declares; a request already in flight passed this hook and is untouched.
      // The check reads the in-memory saved directory only.
      const modelID = (input as { model?: { id?: unknown } }).model?.id
      if (typeof modelID === "string" && appliedPriorityModels.has(modelID) && !savedPriorityModels().has(modelID)) {
        throw new Error(
          `CLIProxyAPI: the saved directory no longer declares the service tier for '${modelID}', ` +
            `but the running runtime still asks for it. Reload the location before using this model.`,
        )
      }
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
    disposed = true
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

  if (cached) {
    // Fast start: register the cached directory, then refresh in the background.
    const applied = await applyBinding(cached)
    if (!applied) {
      console.error(
        `[${PLUGIN_ID}] not registering models: the active credential does not match the cached connection`,
      )
      return cleanup
    }
    const { pending, models, policy, compaction } = applied
    // This bind is the one the boot compile picks up, so the runtime has it.
    binder.markApplied()
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
      applied: !pending,
      reloadRequired: pending,
      fastEffectiveModels: appliedFastEffectiveModels,
      costModels: recordStats(cached, models).costModels,
    })
    announce = true
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
  // The initial read is the binding the boot compile picks up.
  binder.markApplied()
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
