/**
 * OpenCode v2 CLIProxyAPI provider plugin.
 *
 * Explicit or interactive address and key -> enhanced CPA directory -> OpenCode
 * model registration -> native Responses runtime. Credentials stay in OpenCode's
 * own store; the plugin never keeps a key of its own, never logs one, and
 * exposes the connection through a small RPC so a TUI or another client can
 * read a snapshot, verify a candidate pair and switch connection without
 * talking to CPA itself.
 */

import { Plugin, Provider } from "@opencode/plugin"
import { DEFAULT_BASE_URL, AddressError, resolveEndpoints } from "./address"
import { toModelInfos } from "./catalog"
import {
  planConnection,
  readCredential,
  readExplicitConfig,
  redactKey,
  type ConnectionPlan,
  type ExplicitConfig,
} from "./connection"
import { PLUGIN_ID, describeIssues, inspectHost } from "./host"
import { CpaRpc } from "./rpc"
import { ConnectionState, connectionUpdate, verifyConnection, type ConnectionUpdate } from "./state"

/** The host context this plugin registers against. */
type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

/** The registered CPA RPC, narrowed to what this plugin emits. */
interface CpaRegistration {
  readonly events: {
    readonly emit: (name: "changed", data: Readonly<Record<string, unknown>>) => Promise<void>
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

/** Bind the directory's models to the connection that produced them. */
async function bindProvider(
  ctx: Context,
  input: {
    providerID: Provider.ID
    providerName: string
    integrationID: ExplicitConfig["integrationID"]
    packageID: string
    baseURL: string
    models: ReturnType<typeof toModelInfos>
    sourceConnection?: Awaited<ReturnType<Context["integration"]["connection"]["active"]>>
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

  const state = new ConnectionState({
    location,
    providerID: String(providerID),
    integrationID: String(integrationID),
    keyHint: activeCredential ? redactKey(activeCredential.key) : "(none)",
    keySaved: activeCredential !== undefined,
    verified: "unknown",
  })

  let registration: CpaRegistration | undefined
  const publish = async (update: ConnectionUpdate, generation: number): Promise<void> => {
    if (!state.commit(generation, update)) return
    await registration?.events.emit("changed", state.read())
  }

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
      const generation = state.begin()
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
      const connection = await ctx.integration.connection.active(integrationID)
      const endpoints = resolveEndpoints(address)
      await bindProvider(ctx, {
        providerID,
        providerName: explicit.providerName,
        integrationID,
        packageID: explicit.package,
        baseURL: endpoints.baseURL,
        models: toModelInfos(providerID, outcome.entries),
        ...(connection ? { sourceConnection: connection } : {}),
      })
      await publish(
        connectionUpdate({
          address,
          addressSource: "wizard",
          keySource: "wizard",
          key,
          keySaved: true,
          verified: "ok",
          verifyKind: outcome.kind,
          catalogModels: outcome.entries.length,
        }),
        generation,
      )
      return {
        ok: true,
        kind: outcome.kind,
        models: outcome.entries.length,
        snapshot: state.read(),
      }
    },
  })

  const cleanup = async () => {
    await registration?.dispose()
  }

  // Initial connection from explicit configuration or the stored credential.
  // The state is committed here but not published: the location is still
  // booting, so there are no subscribers yet, and awaiting the event bus here
  // would hold up model registration.
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

  const outcome = await verifyConnection({
    address: plan.address,
    apiKey: plan.key,
    ...(explicit.catalogTimeoutMs !== undefined ? { timeoutMs: explicit.catalogTimeoutMs } : {}),
  })
  if (!state.isCurrent(generation)) {
    return cleanup
  }
  if (!outcome.ok) {
    const detail = outcome.message ?? outcome.kind
    state.commit(
      generation,
      connectionUpdate({
        address: plan.address,
        addressSource: plan.addressSource,
        keySource: plan.keySource,
        key: plan.key,
        keySaved: true,
        verified: "failed",
        verifyKind: outcome.kind,
        verifyMessage: detail,
      }),
    )
    console.error(`[${PLUGIN_ID}] connection saved but not verified at ${endpoints.modelsURL} (${detail})`)
    return cleanup
  }

  const models = toModelInfos(providerID, outcome.entries)
  const sourceConnection = plan.store
    ? ((await ctx.integration.connection.active(integrationID)) ?? activeConnection)
    : activeConnection
  await bindProvider(ctx, {
    providerID,
    providerName: explicit.providerName,
    integrationID,
    packageID: explicit.package,
    baseURL: endpoints.baseURL,
    models,
    ...(sourceConnection ? { sourceConnection } : {}),
  })
  state.commit(
    generation,
    connectionUpdate({
      address: plan.address,
      addressSource: plan.addressSource,
      keySource: plan.keySource,
      key: plan.key,
      keySaved: true,
      verified: "ok",
      verifyKind: outcome.kind,
      catalogModels: models.length,
    }),
  )

  if (models.length === 0) {
    console.warn(`[${PLUGIN_ID}] ${endpoints.modelsURL} returned an empty directory; no models are selectable`)
  }
  console.log(
    `[${PLUGIN_ID}] registered ${models.length} models from ${endpoints.modelsURL} ` +
      `(connection ${plan.mode}, key ${redactKey(plan.key)}, address from ${plan.addressSource})`,
  )

  return cleanup
}
