import { afterEach, describe, expect, test } from "bun:test"
import plugin from "../../src/index"
import { resolveEndpoints } from "../../src/address"
import { catalogStorageKey, connectionFingerprint, mergeCatalog } from "../../src/catalog-cache"
import { RESPONSES_PACKAGE } from "../../src/connection"
import { createFakeHost, type FakeHost } from "../support/fake-ctx"
import { startMockCpa } from "../support/mock-cpa.mjs"

const API_KEY = "sk-fake-cliproxyapi-0123456789"

const models = [
  {
    slug: "gpt-5.2-codex",
    display_name: "GPT-5.2 Codex",
    context_window: 272_000,
    max_output_tokens: 128_000,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
  },
  { slug: "hidden-model", visibility: "hide" },
]

type Setup = (ctx: unknown) => Promise<void>
const setup: Setup = async (ctx) => {
  await plugin.setup(ctx as Parameters<typeof plugin.setup>[0])
}

let mock: Awaited<ReturnType<typeof startMockCpa>> | undefined
let priceMock: Awaited<ReturnType<typeof startMockCpa>> | undefined
let host: FakeHost | undefined

afterEach(async () => {
  host?.restoreConsole()
  host = undefined
  await mock?.close()
  mock = undefined
  await priceMock?.close()
  priceMock = undefined
})

describe("plugin setup", () => {
  test("exports a v2 plugin definition with no v1 entry", () => {
    const definition = plugin as unknown as Record<string, unknown>
    expect(typeof definition.id).toBe("string")
    expect(typeof definition.setup).toBe("function")
    expect("server" in definition).toBe(false)
    expect("effect" in definition).toBe(false)
  })

  test("registers the CPA key method, stores the explicit key once and binds the catalog to that connection", async () => {
    mock = await startMockCpa({ models })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })

    await setup(host.ctx)
    host.restoreConsole()

    const integration = host.integrations.find((entry) => entry.id === "cliproxyapi")
    expect(integration?.name).toBe("CLIProxyAPI")
    expect(integration?.methods).toEqual([
      {
        type: "key",
        label: "CLIProxyAPI API key",
        form: [
          {
            type: "string",
            key: "baseURL",
            title: "Address",
            description: "CPA address, including any reverse proxy subpath",
            placeholder: "http://127.0.0.1:8317",
            required: true,
          },
        ],
      },
    ])

    expect(host.connectCalls).toHaveLength(1)
    expect(host.connectCalls[0]?.key).toBe(API_KEY)
    expect(host.connectCalls[0]?.answer).toEqual({ baseURL: mock.url })

    const provider = host.providers[0] as {
      info: Record<string, unknown>
      models: { id: string; modelID: string; enabled: boolean; capabilities: unknown }[]
      sourceConnection: unknown
    }
    expect(provider.info.activation).toBe("enabled")
    expect(provider.info.integrationID).toBe("cliproxyapi")
    expect(provider.info.package).toBe(RESPONSES_PACKAGE)
    expect(provider.info.settings).toEqual({ baseURL: `${mock.url}/v1` })
    expect(provider.models.map((model) => model.id)).toEqual(["gpt-5.2-codex", "hidden-model"])
    expect(provider.models.map((model) => model.modelID)).toEqual(["gpt-5.2-codex", "hidden-model"])
    expect(provider.models.map((model) => model.enabled)).toEqual([true, false])
    expect(provider.models[0]?.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
    expect(provider.sourceConnection).toEqual({ type: "credential", id: host.credentials[0]?.id, label: host.credentials[0]?.id, method: "key" })

    // The directory is read once, with the enhanced client_version and the bearer key.
    const directoryRequest = mock.requests[0]
    expect(directoryRequest?.method).toBe("GET")
    expect(directoryRequest?.path).toBe("/v1/models")
    expect(directoryRequest?.query.client_version).toStartWith("opencode2-cliproxyapi-provider/")
    expect(directoryRequest?.headers.authorization).toBe(`Bearer ${API_KEY}`)
  })

  test("reuses the stored credential instead of writing another one", async () => {
    mock = await startMockCpa({ models })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })

    await setup(host.ctx)
    await setup(host.ctx)
    host.restoreConsole()

    expect(host.connectCalls).toHaveLength(1)
    expect(host.credentials).toHaveLength(1)
    // The provider is registered once per provider id; the second setup replaces it.
    expect(host.providers).toHaveLength(1)
  })

  test("never writes the key into logs or provider settings", async () => {
    mock = await startMockCpa({ models })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })

    await setup(host.ctx)
    host.restoreConsole()

    const logs = host.logs.join("\n")
    expect(logs).toContain("registered 2 models")
    expect(logs).not.toContain(API_KEY)
    expect(logs).not.toContain("sk-fake")
    expect(JSON.stringify(host.providers)).not.toContain(API_KEY)
    expect(JSON.stringify(host.providers)).not.toContain("apiKey")
    // The persisted directory cache carries a fingerprint, never the key.
    const stored = JSON.stringify([...host.storage.values()])
    expect(stored).not.toContain(API_KEY)
    expect(stored).not.toContain("sk-fake")
    expect(stored).toContain("modelsURL")
  })

  test("refuses an unsupported host version and a missing interface", async () => {
    host = createFakeHost({ version: "1.18.29" })
    await setup(host.ctx)
    host.restoreConsole()
    expect(host.providers).toHaveLength(0)
    expect(host.logs.join("\n")).toContain("refusing to load")
    expect(host.logs.join("\n")).toContain("older than the supported")

    host = createFakeHost({ omit: ["provider.transform"] })
    await setup(host.ctx)
    host.restoreConsole()
    expect(host.providers).toHaveLength(0)
    expect(host.logs.join("\n")).toContain("context.provider.transform is not a function")
  })

  test("refuses to register models without a key", async () => {
    host = createFakeHost({ options: { modelsDev: false } })
    await setup(host.ctx)
    host.restoreConsole()
    expect(host.providers).toHaveLength(0)
    expect(host.logs.join("\n")).toContain("CLIPROXYAPI_API_KEY")
  })

  test("keeps a broken directory distinct from an empty one", async () => {
    mock = await startMockCpa({ directory: { status: 503, body: { error: "upstream down" } } })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host.ctx)
    host.restoreConsole()
    expect(host.providers).toHaveLength(0)
    expect(host.logs.join("\n")).toContain("connection saved but not verified")
    expect(host.logs.join("\n")).toContain("503")
    expect(host.logs.join("\n")).not.toContain(API_KEY)

    await mock.close()
    mock = await startMockCpa({ models: [] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host.ctx)
    host.restoreConsole()
    expect(host.providers).toHaveLength(1)
    expect((host.providers[0] as { models: unknown[] }).models).toEqual([])
    expect(host.logs.join("\n")).toContain("empty directory")
  })

  test("refuses a directory body that is not a catalog", async () => {
    mock = await startMockCpa({ directory: { raw: "<html>proxy</html>", contentType: "text/html" } })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host.ctx)
    host.restoreConsole()
    expect(host.providers).toHaveLength(0)
    expect(host.logs.join("\n")).toContain("connection saved but not verified")
  })

  test("accepts a plain OpenAI listing when the enhanced directory is not served", async () => {
    mock = await startMockCpa({ directory: { body: { object: "list", data: [{ id: "plain-model" }] } } })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host.ctx)
    host.restoreConsole()
    const provider = host.providers[0] as { models: { id: string; capabilities: unknown }[] }
    expect(provider.models.map((model) => model.id)).toEqual(["plain-model"])
    expect(provider.models[0]?.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
  })

  test("reports an unusable address without registering", async () => {
    host = createFakeHost({ options: { baseURL: "ftp://cpa.test", apiKey: API_KEY, modelsDev: false } })
    await setup(host.ctx)
    host.restoreConsole()
    expect(host.providers).toHaveLength(0)
    expect(host.logs.join("\n")).toContain("must use http or https")
  })

  test("leaves Fast off by default and only injects priority for a declared-capable model", async () => {
    mock = await startMockCpa({
      models: [
        { slug: "capable-model", service_tiers: ["priority"], supported_reasoning_levels: [{ effort: "high" }] },
        { slug: "plain-model" },
        // Only `additional_speed_tiers`: the reference plugin does not treat it as capability.
        { slug: "speed-only-model", additional_speed_tiers: ["priority"] },
      ],
    })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host.ctx)
    host.restoreConsole()

    const provider = host.providers[0] as {
      models: { id: string; settings?: Record<string, unknown>; variants: { id: string; settings: unknown }[] }[]
    }
    expect(provider.models.map((model) => model.settings)).toEqual([undefined, undefined, undefined])
    // Fast never changes the reasoning variants, even when it applies.
    expect(provider.models[0]?.variants).toEqual([{ id: "high", settings: { reasoningEffort: "high" } }])

    const snapshot = await status(host)
    expect(snapshot.fastEnabled).toBe(false)
    expect(snapshot.fastEffectiveModels).toBe(0)
  })

  test("applies a stored Fast preference to capable models only", async () => {
    mock = await startMockCpa({
      models: [
        { slug: "capable-model", service_tiers: [{ id: "priority" }] },
        { slug: "plain-model" },
        { slug: "speed-only-model", additional_speed_tiers: ["priority"] },
      ],
    })
    host = createFakeHost({
      options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false },
      storage: { "cliproxyapi.fast.cliproxyapi": true },
    })
    await setup(host.ctx)
    host.restoreConsole()

    const provider = host.providers[0] as { models: { id: string; settings?: Record<string, unknown> }[] }
    expect(provider.models.map((model) => model.settings)).toEqual([
      { serviceTier: "priority" },
      undefined,
      undefined,
    ])
    const snapshot = await status(host)
    expect(snapshot.fastEnabled).toBe(true)
    expect(snapshot.fastEffectiveModels).toBe(1)
  })

  test("setFast persists the preference, reports it and refuses a non-boolean", async () => {
    mock = await startMockCpa({ models: [{ slug: "capable-model", service_tiers: ["priority"] }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host.ctx)
    host.restoreConsole()

    const handlers = host.rpcRegistrations[0]?.handlers as {
      setFast: (input: unknown) => Promise<{ ok: boolean; message?: string; snapshot: { fastEnabled: boolean; fastEffectiveModels: number } }>
    }
    const enabled = await handlers.setFast({ enabled: true })
    expect(enabled.ok).toBe(true)
    expect(enabled.snapshot.fastEnabled).toBe(true)
    expect(host.storage.get("cliproxyapi.fast.cliproxyapi")).toBe(true)
    expect(host.rpcEvents.at(-1)).toEqual({ name: "changed", data: expect.objectContaining({ fastEnabled: true }) })

    // The registry is rebuilt at the next location boot, so the effective count
    // still describes what is registered right now.
    expect(enabled.snapshot.fastEffectiveModels).toBe(0)

    const disabled = await handlers.setFast({ enabled: false })
    expect(disabled.snapshot.fastEnabled).toBe(false)
    expect(host.storage.get("cliproxyapi.fast.cliproxyapi")).toBe(false)

    const invalid = await handlers.setFast({ enabled: "yes" })
    expect(invalid.ok).toBe(false)
    expect(invalid.message).toContain("boolean")
  })

  test("attaches a models.dev price estimate without inventing one", async () => {
    mock = await startMockCpa({ models: [{ slug: "gpt-5.2" }, { slug: "unpriced-model" }] })
    priceMock = await startMockCpa({
      directory: {
        status: 200,
        body: {
          openai: { models: { "gpt-5.2": { cost: { input: 1.25, output: 10, cache_read: 0.125 } } } },
        },
      },
    })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDevURL: `${priceMock.url}/v1/models` } })
    await setup(host.ctx)
    host.restoreConsole()

    const provider = host.providers[0] as { models: { id: string; cost: unknown[] }[] }
    expect(provider.models.map((model) => model.cost)).toEqual([
      [{ input: 1.25, output: 10, cache: { read: 0.125, write: 0 } }],
      [],
    ])
    const snapshot = await status(host)
    expect(snapshot.costModels).toBe(1)
    // The estimate is labelled, never presented as a CPA bill.
    expect(host.logs.join("\n")).toContain("prices 1")
  })

  test("registers models without a price when models.dev cannot be read", async () => {
    mock = await startMockCpa({ models: [{ slug: "gpt-5.2" }] })
    host = createFakeHost({
      options: { baseURL: mock.url, apiKey: API_KEY, modelsDevURL: "http://127.0.0.1:1/api.json", modelsDevTimeoutMs: 500 },
    })
    await setup(host.ctx)
    host.restoreConsole()

    const provider = host.providers[0] as { models: { cost: unknown[] }[] }
    expect(provider.models).toHaveLength(1)
    expect(provider.models[0]?.cost).toEqual([])
    expect(host.logs.join("\n")).toContain("models.dev price estimate unavailable")
  })

  test("a cached directory keeps its variants, Fast parameter and price across a refresh rebind", async () => {
    mock = await startMockCpa({
      models: [{ slug: "capable-model", service_tiers: ["priority"], supported_reasoning_levels: [{ effort: "high" }] }],
    })
    priceMock = await startMockCpa({
      directory: { status: 200, body: { smoke: { models: { "capable-model": { cost: { input: 2, output: 4 } } } } } },
    })

    const endpoints = resolveEndpoints(mock.url)
    const fingerprint = connectionFingerprint(endpoints.baseURL, API_KEY)
    const record = mergeCatalog({
      entries: [{ id: "capable-model", serviceTiers: ["priority"], reasoningLevels: ["high"] }],
      baseURL: endpoints.baseURL,
      modelsURL: endpoints.modelsURL,
      fingerprint,
      now: 1_700_000_000_000,
    })
    host = createFakeHost({
      options: { baseURL: mock.url, apiKey: API_KEY, modelsDevURL: `${priceMock.url}/v1/models` },
      storage: { [catalogStorageKey(fingerprint)]: record, "cliproxyapi.fast.cliproxyapi": true },
    })
    await setup(host.ctx)
    host.restoreConsole()

    const bound = () =>
      host!.providers[0] as {
        models: { settings?: Record<string, unknown>; variants: { id: string; settings: unknown }[]; cost: unknown[] }[]
      }
    const assertMapped = () => {
      expect(bound().models[0]?.variants).toEqual([{ id: "high", settings: { reasoningEffort: "high" } }])
      expect(bound().models[0]?.settings).toEqual({ serviceTier: "priority" })
      expect(bound().models[0]?.cost).toEqual([{ input: 2, output: 4, cache: { read: 0, write: 0 } }])
    }

    // Fast start from the persisted record: the cached models carry the same
    // parameters a live read would produce.
    assertMapped()
    expect(await status(host)).toMatchObject({
      catalogFromCache: true,
      fastEnabled: true,
      fastEffectiveModels: 1,
      costModels: 1,
    })

    // A manual refresh rebinds the provider; Fast and price state must survive it.
    const handlers = host.rpcRegistrations[0]?.handlers as { refresh: () => Promise<Record<string, unknown>> }
    const refreshed = await handlers.refresh()
    expect(refreshed).toMatchObject({ ok: true })
    assertMapped()
    expect(await status(host)).toMatchObject({
      catalogFromCache: false,
      fastEnabled: true,
      fastEffectiveModels: 1,
      costModels: 1,
    })
  })
})

/** Read the connection snapshot through the registered RPC, as a client would. */
async function status(host: FakeHost) {
  const handlers = host.rpcRegistrations[0]?.handlers as { status: () => Promise<Record<string, unknown>> }
  return handlers.status()
}
