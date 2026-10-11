import { afterEach, describe, expect, test } from "bun:test"
import plugin from "../../src/index"
import { createFakeHost, type FakeHost } from "../support/fake-ctx"
import { startMockCpa } from "../support/mock-cpa.mjs"

const API_KEY = "sk-fake-rpc-0123456789abcdef"

interface Snapshot {
  location: string
  providerID: string
  integrationID: string
  address?: string
  addressSource?: string
  keySource?: string
  keyHint: string
  keySaved: boolean
  verified: string
  verifyKind?: string
  verifyMessage?: string
  catalogModels?: number
  catalogFetchedAt?: number
  catalogStaleModels?: number
  catalogStaleIds?: string[]
  catalogFromCache?: boolean
  generation: number
  updatedAt: number
}

interface Result {
  ok: boolean
  kind: string
  message?: string
  models?: number
  snapshot: Snapshot
}

type Handlers = {
  status: (input: unknown) => Promise<Snapshot>
  verify: (input: unknown) => Promise<Result>
  connect: (input: unknown) => Promise<Result>
  refresh: (input: unknown) => Promise<Result>
}

let host: FakeHost | undefined
let mock: Awaited<ReturnType<typeof startMockCpa>> | undefined

afterEach(async () => {
  host?.restoreConsole()
  host = undefined
  await mock?.close()
  mock = undefined
})

const setup = async (ctx: unknown) => plugin.setup(ctx as Parameters<typeof plugin.setup>[0])

function handlersOf(target: FakeHost): Handlers {
  // A second setup (a simulated restart) registers again; use the newest one.
  const registration = target.rpcRegistrations.at(-1)
  if (!registration) throw new Error("the plugin registered no RPC")
  return registration.handlers as Handlers
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe("CPA connection RPC", () => {
  test("status reports the active connection and never the key", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }, { slug: "b" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY }, location: "/work/one" })
    await setup(host.ctx)
    host.restoreConsole()

    const status = await handlersOf(host).status!({})
    expect(status).toMatchObject({
      location: "/work/one",
      providerID: "cliproxyapi",
      address: mock.url,
      addressSource: "options",
      keySource: "options",
      keyHint: `(redacted, ${API_KEY.length} chars)`,
      keySaved: true,
      verified: "ok",
      verifyKind: "ok",
      catalogModels: 2,
    })
    expect(JSON.stringify(status)).not.toContain(API_KEY)
    expect(JSON.stringify(status)).not.toContain("sk-fake")
  })

  test("status separates a saved credential from a verified connection", async () => {
    mock = await startMockCpa({ directory: { status: 401, body: { error: "bad key" } } })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()

    const status = await handlersOf(host).status!({})
    expect(status.keySaved).toBe(true)
    expect(status.verified).toBe("failed")
    expect(status.verifyKind).toBe("auth")
    expect(status.catalogModels).toBeUndefined()
  })

  test("verify observes a correct key, 401, an unreachable host, an empty directory and a broken body", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const handlers = handlersOf(host)
    const before = await handlers.status!({})
    const connectsBefore = host.connectCalls.length

    expect(await handlers.verify!({ address: mock.url, key: API_KEY })).toMatchObject({ ok: true, kind: "ok", models: 1 })

    await mock.close()
    mock = await startMockCpa({ directory: { status: 401, body: { error: "bad key" } } })
    expect(await handlers.verify!({ address: mock.url, key: "sk-fake-wrong" })).toMatchObject({ ok: false, kind: "auth" })

    await mock.close()
    mock = await startMockCpa({ directory: { status: 503, body: { error: "down" } } })
    expect(await handlers.verify!({ address: mock.url, key: API_KEY })).toMatchObject({ ok: false, kind: "unreachable" })

    await mock.close()
    mock = await startMockCpa({ models: [] })
    expect(await handlers.verify!({ address: mock.url, key: API_KEY })).toMatchObject({ ok: true, kind: "empty", models: 0 })

    await mock.close()
    mock = await startMockCpa({ directory: { raw: "<html>proxy</html>", contentType: "text/html" } })
    expect(await handlers.verify!({ address: mock.url, key: API_KEY })).toMatchObject({ ok: false, kind: "format" })

    expect(await handlers.verify!({ address: "ftp://cpa.test", key: API_KEY })).toMatchObject({
      ok: false,
      kind: "address",
    })

    // A failed probe never touches the active connection or the credential store.
    expect(await handlers.status!({})).toEqual(before)
    expect(host.connectCalls).toHaveLength(connectsBefore)
  })

  test("connect verifies first, then saves through the native key method and rebinds the directory", async () => {
    mock = await startMockCpa({ models: [{ slug: "old-model" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const firstProvider = host.providers[0] as { models: { id: string }[] }

    await mock.close()
    mock = await startMockCpa({ models: [{ slug: "new-model" }] })
    const newKey = "sk-fake-switched-9876543210"
    const result = await handlersOf(host).connect!({ address: mock.url, key: newKey })

    expect(result.ok).toBe(true)
    expect(result.kind).toBe("ok")
    expect(result.snapshot.address).toBe(mock.url)
    expect(result.snapshot.addressSource).toBe("wizard")
    expect(result.snapshot.keySource).toBe("wizard")
    expect(result.snapshot.keyHint).toBe(`(redacted, ${newKey.length} chars)`)
    expect(result.snapshot.verified).toBe("ok")

    expect(host.connectCalls.map((call) => call.key)).toEqual([API_KEY, newKey])
    expect(host.connectCalls[1]?.answer).toEqual({ baseURL: mock.url })

    // The provider record is replaced, so the old directory cannot leak through.
    expect(host.providers).toHaveLength(1)
    const provider = host.providers[0] as { models: { id: string }[]; info: { settings: unknown } }
    expect(firstProvider.models.map((model) => model.id)).toEqual(["old-model"])
    expect(provider.models.map((model) => model.id)).toEqual(["new-model"])
    expect(provider.info.settings).toEqual({ baseURL: `${mock.url}/v1` })

    // The directory request for the new connection carried the new pair.
    const directory = mock.requests.find((request) => request.method === "GET")
    expect(directory?.headers.authorization).toBe(`Bearer ${newKey}`)

    // Every committed change is published for subscribers.
    expect(host.rpcEvents.at(-1)?.name).toBe("changed")
    expect((host.rpcEvents.at(-1)?.data as { address?: string }).address).toBe(mock.url)
  })

  test("a failed connect saves nothing and leaves the active connection intact", async () => {
    mock = await startMockCpa({ models: [{ slug: "kept-model" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const before = await handlersOf(host).status!({})
    const connectsBefore = host.connectCalls.length

    await mock.close()
    mock = await startMockCpa({ directory: { status: 401, body: { error: "bad key" } } })
    const result = await handlersOf(host).connect!({ address: mock.url, key: "sk-fake-bad" })

    expect(result.ok).toBe(false)
    expect(result.kind).toBe("auth")
    expect(host.connectCalls).toHaveLength(connectsBefore)
    expect(await handlersOf(host).status!({})).toEqual(before)
    expect((host.providers[0] as { models: { id: string }[] }).models.map((model) => model.id)).toEqual(["kept-model"])
  })

  test("a stale connect cannot overwrite the connection chosen after it", async () => {
    mock = await startMockCpa({
      directory: (request) => {
        if (request.headers.authorization === "Bearer sk-fake-slow") {
          return new Promise((resolve) => {
            setTimeout(() => resolve({ status: 200, body: { models: [{ slug: "slow-model" }] } }), 400)
          })
        }
        return { status: 200, body: { models: [{ slug: "fast-model" }] } }
      },
    })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()

    const handlers = handlersOf(host)
    const slow = handlers.connect!({ address: mock.url, key: "sk-fake-slow" })
    await sleep(50)
    const fast = await handlers.connect!({ address: mock.url, key: "sk-fake-fast" })
    const stale = await slow

    expect(fast.ok).toBe(true)
    expect(stale.ok).toBe(false)
    expect(stale.message).toContain("nothing was saved")
    expect(host.connectCalls.map((call) => call.key)).toEqual([API_KEY, "sk-fake-fast"])
    expect((host.providers[0] as { models: { id: string }[] }).models.map((model) => model.id)).toEqual(["fast-model"])
    expect((await handlers.status!({})).address).toBe(mock.url)
    expect((await handlers.status!({})).keyHint).toBe("(redacted, 12 chars)")
  })

  test("a successful connect clears an earlier verification failure", async () => {
    mock = await startMockCpa({ directory: { status: 401, body: { error: "bad key" } } })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const failed = await handlersOf(host).status!({})
    expect(failed.verified).toBe("failed")
    expect(failed.verifyMessage).toBeDefined()

    await mock.close()
    mock = await startMockCpa({ models: [{ slug: "recovered-model" }] })
    const result = await handlersOf(host).connect!({ address: mock.url, key: "sk-fake-recovered" })
    expect(result.ok).toBe(true)
    expect(result.snapshot.verified).toBe("ok")
    expect(result.snapshot.verifyMessage).toBeUndefined()
  })

  test("keeps a second integration and provider id isolated", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({
      options: { baseURL: mock.url, apiKey: API_KEY, providerID: "acme-cpa", integrationID: "acme-cpa" },
      location: "/work/two",
    })
    await setup(host.ctx)
    host.restoreConsole()

    const status = await handlersOf(host).status!({})
    expect(status.providerID).toBe("acme-cpa")
    expect(status.integrationID).toBe("acme-cpa")
    expect(status.location).toBe("/work/two")
    expect(host.connectCalls[0]?.integrationID).toBe("acme-cpa")
    expect((host.providers[0] as { info: { integrationID: string } }).info.integrationID).toBe("acme-cpa")
  })
})

describe("CPA catalog refresh, cache and stale RPC", () => {
  test("manual refresh re-reads the directory and reports the new model count", async () => {
    let reply: { status?: number; body?: unknown } = { status: 200, body: { models: [{ slug: "a" }] } }
    mock = await startMockCpa({ directory: () => reply })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const handlers = handlersOf(host)

    const before = await handlers.status!({})
    expect(before.catalogModels).toBe(1)
    expect(before.catalogFromCache).toBe(false)
    expect(before.catalogFetchedAt).toBeGreaterThan(0)

    reply = { status: 200, body: { models: [{ slug: "a" }, { slug: "b" }] } }
    const refreshed = await handlers.refresh!({})
    expect(refreshed).toMatchObject({ ok: true, kind: "ok", models: 2 })
    const status = await handlers.status!({})
    expect(status.catalogModels).toBe(2)
    expect(status.catalogStaleModels).toBe(0)
    expect(status.verified).toBe("ok")
    expect(status.catalogFetchedAt).toBeGreaterThanOrEqual(before.catalogFetchedAt!)
    expect((host.providers[0] as { models: { id: string }[] }).models.map((m) => m.id)).toEqual(["a", "b"])
  })

  test("a failed refresh keeps the last directory and reports the failure", async () => {
    let reply: { status?: number; body?: unknown } = { status: 200, body: { models: [{ slug: "kept" }] } }
    mock = await startMockCpa({ directory: () => reply })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const handlers = handlersOf(host)
    const before = await handlers.status!({})

    reply = { status: 503, body: { error: "upstream down" } }
    const failed = await handlers.refresh!({})
    expect(failed).toMatchObject({ ok: false, kind: "unreachable" })

    const after = await handlers.status!({})
    expect(after.catalogModels).toBe(1)
    expect(after.catalogFetchedAt).toBe(before.catalogFetchedAt)
    expect(after.verified).toBe("failed")
    expect(after.verifyKind).toBe("unreachable")
    expect((host.providers[0] as { models: { id: string }[] }).models.map((m) => m.id)).toEqual(["kept"])
  })

  test("an empty directory is a success that stales the previous models", async () => {
    let reply: { status?: number; body?: unknown } = { status: 200, body: { models: [{ slug: "kept" }] } }
    mock = await startMockCpa({ directory: () => reply })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const handlers = handlersOf(host)

    reply = { status: 200, body: { models: [] } }
    const emptied = await handlers.refresh!({})
    expect(emptied).toMatchObject({ ok: true, kind: "empty" })

    const status = await handlers.status!({})
    expect(status.verified).toBe("ok")
    expect(status.catalogModels).toBe(1)
    expect(status.catalogStaleModels).toBe(1)
    expect(status.catalogStaleIds).toEqual(["kept"])
    // A retained model stays registered and selectable; the warning is separate.
    const model = (host.providers[0] as { models: { id: string; status: string; enabled: boolean }[] }).models[0]
    expect(model?.status).toBe("active")
    expect(model?.enabled).toBe(true)
  })

  test("a restart serves a matching cache immediately and refreshes in the background", async () => {
    let reply: { status?: number; body?: unknown } | (() => Promise<{ status?: number; body?: unknown }>) = {
      status: 200,
      body: { models: [{ slug: "cached-a" }, { slug: "cached-b" }] },
    }
    mock = await startMockCpa({ directory: () => (typeof reply === "function" ? reply() : reply) })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    expect((await handlersOf(host).status!({})).catalogModels).toBe(2)

    // The second setup stands for a restart: the directory now fails, but the
    // matching cache must still register its models before the refresh lands.
    reply = () => new Promise((resolve) => setTimeout(() => resolve({ status: 503, body: { error: "down" } }), 300))
    await setup(host.ctx)
    host.restoreConsole()
    const handlers = handlersOf(host)

    const immediate = await handlers.status!({})
    expect(immediate.catalogModels).toBe(2)
    expect(immediate.catalogFromCache).toBe(true)
    expect((host.providers[0] as { models: { id: string }[] }).models.map((m) => m.id)).toEqual([
      "cached-a",
      "cached-b",
    ])

    await sleep(500)
    const settled = await handlers.status!({})
    // The failed refresh kept the cached models, so they are still cache-served.
    expect(settled.catalogModels).toBe(2)
    expect(settled.catalogFromCache).toBe(true)
    expect(settled.verified).toBe("failed")
  })

  test("does not serve one credential's cached directory to another", async () => {
    let reply: { status?: number; body?: unknown } = { status: 200, body: { models: [{ slug: "alpha-only" }] } }
    mock = await startMockCpa({ directory: () => reply })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const handlers = handlersOf(host)

    reply = { status: 200, body: { models: [{ slug: "beta-only" }] } }
    const switched = await handlers.connect!({ address: mock.url, key: "sk-fake-beta-key" })
    expect(switched.ok).toBe(true)
    expect((host.providers[0] as { models: { id: string }[] }).models.map((m) => m.id)).toEqual(["beta-only"])

    // Each credential has its own record, and no record holds key material.
    const stored = JSON.stringify([...host.storage.values()])
    expect(stored).not.toContain(API_KEY)
    expect(stored).not.toContain("sk-fake-beta-key")
    expect(host.storage.size).toBe(2)
  })

  test("warns once when a request selects a model retained as stale", async () => {
    let reply: { status?: number; body?: unknown } = {
      status: 200,
      body: { models: [{ slug: "kept" }, { slug: "gone" }] },
    }
    mock = await startMockCpa({ directory: () => reply })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY } })
    await setup(host.ctx)
    host.restoreConsole()
    const handlers = handlersOf(host)

    reply = { status: 200, body: { models: [{ slug: "kept" }] } }
    await handlers.refresh!({})
    expect((await handlers.status!({})).catalogStaleModels).toBe(1)

    const hook = host.sessionHooks.find((entry) => entry.name === "model.request")
    expect(hook).toBeDefined()
    const before = host.rpcEvents.length

    hook!.handler({ model: { id: "gone", providerID: "cliproxyapi" } })
    expect(host.rpcEvents.at(-1)).toMatchObject({ name: "stale", data: { modelID: "gone" } })

    // The same stale selection is only announced once, and fresh models never are.
    hook!.handler({ model: { id: "gone", providerID: "cliproxyapi" } })
    hook!.handler({ model: { id: "kept", providerID: "cliproxyapi" } })
    expect(host.rpcEvents.length).toBe(before + 1)
  })
})
