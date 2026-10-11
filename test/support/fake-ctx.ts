// Minimal OpenCode host double for the registration unit tests.
//
// It implements only what the plugin's setup touches and records every
// registration, so the test can assert on what the plugin asked the host to do.
// It is deliberately not a substitute for the real host run in
// scripts/host-smoke.mjs.

export interface FakeCredential {
  id: string
  integrationID: string
  active: boolean
  value: { type: "key"; key: string; configuration?: Record<string, string> }
}

export interface FakeHost {
  ctx: Record<string, unknown>
  integrations: { id: string; name: string; methods: unknown[] }[]
  credentials: FakeCredential[]
  providers: Record<string, unknown>[]
  connectCalls: { integrationID: string; key: string; answer?: Record<string, string> }[]
  rpcRegistrations: { definition: { id: string; methods: Record<string, unknown> }; handlers: Record<string, unknown> }[]
  rpcEvents: { name: string; data: unknown }[]
  storageValues: Map<string, unknown>
  logs: string[]
  restoreConsole: () => void
}

function deletePath(target: Record<string, unknown>, path: string) {
  const keys = path.split(".")
  let cursor: Record<string, unknown> = target
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>
  delete cursor[keys[keys.length - 1] as string]
}

export function createFakeHost(options: {
  version?: string
  options?: Record<string, unknown>
  omit?: string[]
  credentials?: FakeCredential[]
  location?: string
  storage?: Record<string, unknown>
} = {}): FakeHost {
  const integrations: FakeHost["integrations"] = []
  const credentials: FakeCredential[] = options.credentials ?? []
  const providers: Record<string, unknown>[] = []
  const connectCalls: FakeHost["connectCalls"] = []
  const rpcRegistrations: FakeHost["rpcRegistrations"] = []
  const rpcEvents: FakeHost["rpcEvents"] = []
  const storageValues = new Map<string, unknown>(Object.entries(options.storage ?? {}))
  const logs: string[] = []

  let nextCredential = credentials.length + 1

  const ctx: Record<string, unknown> = {
    app: { name: "opencode", version: options.version ?? "2.0.26", channel: "latest" },
    location: { directory: options.location ?? "/fake/location" },
    options: options.options ?? {},
    rpc: {
      register: async (
        definition: { id: string; methods: Record<string, unknown> },
        handlers: Record<string, unknown>,
      ) => {
        const events = {
          emit: async (name: string, data: unknown) => {
            rpcEvents.push({ name, data })
          },
        }
        rpcRegistrations.push({ definition, handlers })
        return { dispose: async () => undefined, events }
      },
    },
    storage: {
      get: async (key: string) => storageValues.get(key),
      set: async (key: string, value: unknown) => {
        storageValues.set(key, value)
      },
      remove: async (key: string) => {
        storageValues.delete(key)
      },
      scan: async (input: { prefix: string }) => ({
        entries: [...storageValues.entries()]
          .filter(([key]) => key.startsWith(input.prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        const editor = {
          list: () => integrations,
          get: (id: string) => integrations.find((entry) => entry.id === id),
          update: (id: string, update: (integration: { id: string; name: string }) => void) => {
            let integration = integrations.find((entry) => entry.id === id)
            if (!integration) {
              integration = { id, name: id, methods: [] }
              integrations.push(integration)
            }
            update(integration as { id: string; name: string })
          },
          remove: (id: string) => {
            const index = integrations.findIndex((entry) => entry.id === id)
            if (index >= 0) integrations.splice(index, 1)
          },
          method: {
            list: (integrationID: string) => integrations.find((entry) => entry.id === integrationID)?.methods ?? [],
            update: (registration: { integrationID: string; method: unknown }) => {
              let integration = integrations.find((entry) => entry.id === registration.integrationID)
              if (!integration) {
                integration = { id: registration.integrationID, name: registration.integrationID, methods: [] }
                integrations.push(integration)
              }
              integration.methods.push(registration.method)
            },
            remove: () => undefined,
          },
        }
        callback(editor)
        return { dispose: async () => undefined }
      },
      connect: {
        key: async (input: { integrationID: string; key: string; answer?: Record<string, string> }) => {
          connectCalls.push(input)
          for (const credential of credentials) credential.active = false
          credentials.push({
            id: `cred_${nextCredential++}`,
            integrationID: input.integrationID,
            active: true,
            value: { type: "key", key: input.key, configuration: input.answer },
          })
        },
      },
      connection: {
        active: async (integrationID: string) => {
          const credential = credentials.find((entry) => entry.integrationID === integrationID && entry.active)
          return credential ? { type: "credential", id: credential.id, label: credential.id, method: "key" } : undefined
        },
        resolve: async (connection: { id?: string }) => {
          return credentials.find((entry) => entry.id === connection.id)?.value
        },
      },
    },
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        const editor = {
          list: () => providers,
          get: (providerID: string) =>
            providers.find((entry) => (entry.provider as { id?: string } | undefined)?.id === providerID),
          add: (input: Record<string, unknown>) => {
            const id = (input.info as { id?: string } | undefined)?.id
            const index = providers.findIndex((entry) => (entry.info as { id?: string } | undefined)?.id === id)
            if (index >= 0) providers.splice(index, 1, input)
            else providers.push(input)
          },
          update: () => undefined,
          remove: () => undefined,
          models: { set: () => undefined, update: () => undefined, remove: () => undefined },
        }
        callback(editor)
        return { dispose: async () => undefined }
      },
    },
  }

  for (const path of options.omit ?? []) deletePath(ctx, path)

  const originals = { log: console.log, warn: console.warn, error: console.error }
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      logs.push(`${level} ${args.map((value) => String(value)).join(" ")}`)
    }
  console.log = record("log") as typeof console.log
  console.warn = record("warn") as typeof console.warn
  console.error = record("error") as typeof console.error

  return {
    ctx,
    integrations,
    credentials,
    providers,
    connectCalls,
    rpcRegistrations,
    rpcEvents,
    storageValues,
    logs,
    restoreConsole: () => {
      console.log = originals.log
      console.warn = originals.warn
      console.error = originals.error
    },
  }
}
