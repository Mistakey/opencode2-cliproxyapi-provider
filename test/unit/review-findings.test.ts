// Regressions for the independent review's F01–F06 (fixed).
//
// Each test names the failure the review proved on the pre-fix tree and asserts
// the behaviour the fix must hold: a connection is a pair, a failed connect does
// not touch the active one, the last read issued is the last commit written, and
// the stats follow the authoritative server.

import { afterEach, describe, expect, test } from "bun:test"
import { planConnection, readExplicitConfig, ENV_API_KEY, ENV_BASE_URL } from "../../src/connection"
import { CatalogService } from "../../src/catalog-service"
import { createMemoryCatalogStore } from "../../src/catalog-store"
import { SessionStatsTracker } from "../../src/stats"
import { createConnectionView } from "../../src/tui-connection"
import plugin from "../../src/index"
import { createFakeHost, type FakeHost } from "../support/fake-ctx"
import { startMockCpa } from "../support/mock-cpa.mjs"

const A_KEY = "sk-fake-review-a"

describe("F01 a connection is an address and a key together", () => {
  const active = { connection: { type: "credential" as const, id: "cred_1" }, key: A_KEY, baseURL: "http://127.0.0.1:9001" }

  test("a configured address does not borrow a key stored for a different address", () => {
    const explicit = readExplicitConfig({ baseURL: "http://127.0.0.1:9002" }, {})
    expect(explicit.apiKey).toBeUndefined()
    const plan = planConnection({ explicit, active })
    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toContain(ENV_API_KEY)
  })

  test("an option address is not paired with an environment key", () => {
    const explicit = readExplicitConfig(
      { baseURL: "http://127.0.0.1:9002" },
      { [ENV_BASE_URL]: "http://127.0.0.1:9001", [ENV_API_KEY]: A_KEY },
    )
    expect(explicit.sources).toEqual({ baseURL: "options" })
    expect(explicit.apiKey).toBeUndefined()
    expect(planConnection({ explicit }).ok).toBe(false)
  })

  test("a configured address that matches the stored credential reuses its key", () => {
    const explicit = readExplicitConfig({ baseURL: "http://127.0.0.1:9001" }, {})
    const plan = planConnection({ explicit, active })
    expect(plan.ok === true && plan.plan).toMatchObject({
      key: A_KEY,
      address: "http://127.0.0.1:9001",
      store: false,
      keySource: "stored",
    })
  })
})

describe("F02 a failed connect leaves the active connection untouched", () => {
  let host: FakeHost | undefined
  let a: Awaited<ReturnType<typeof startMockCpa>> | undefined
  let b: Awaited<ReturnType<typeof startMockCpa>> | undefined

  afterEach(async () => {
    host?.restoreConsole()
    host = undefined
    await a?.close()
    await b?.close()
    a = undefined
    b = undefined
  })

  test("a rejected candidate does not rebind the directory or the credential", async () => {
    a = await startMockCpa({ models: [{ slug: "a-only" }] })
    b = await startMockCpa({ directory: { status: 401, body: { error: "bad" } } })
    host = createFakeHost({ options: { baseURL: a.url, apiKey: A_KEY, modelsDev: false } })
    await plugin.setup(host.ctx as unknown as Parameters<typeof plugin.setup>[0])
    host.restoreConsole()

    const handlers = host.rpcRegistrations[0]!.handlers as {
      connect: (input: unknown) => Promise<{ ok: boolean }>
      refresh: () => Promise<{ ok: boolean }>
      status: () => Promise<Record<string, unknown>>
    }
    const failed = await handlers.connect({ address: b!.url, key: "sk-fake-B" })
    expect(failed.ok).toBe(false)
    expect((await handlers.status()).address).toBe(a!.url)

    // The failed candidate must not have become the service identity: the next
    // refresh still reads A and binds A's directory to A's credential.
    const refreshed = await handlers.refresh()
    expect(refreshed.ok).toBe(true)
    const provider = host.providers[0] as {
      info: { settings: { baseURL: string } }
      models: { id: string }[]
      sourceConnection?: unknown
    }
    expect(provider.info.settings.baseURL).toBe(`${a!.url}/v1`)
    expect(provider.models.map((model) => model.id)).toEqual(["a-only"])
    expect(host.credentials.find((credential) => credential.active)?.value.key).toBe(A_KEY)
  })
})

describe("F03 a live rebind rebuilds the provider registry", () => {
  let host: FakeHost | undefined
  let mock: Awaited<ReturnType<typeof startMockCpa>> | undefined

  afterEach(async () => {
    host?.restoreConsole()
    host = undefined
    await mock?.close()
    mock = undefined
  })

  test("a refresh republishes the directory through provider.reload", async () => {
    let entries = [{ slug: "first" }]
    mock = await startMockCpa({ directory: () => ({ body: { models: entries } }) })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: A_KEY, modelsDev: false } })
    await plugin.setup(host.ctx as unknown as Parameters<typeof plugin.setup>[0])
    host.restoreConsole()

    const before = host.providerReloads()
    const handlers = host.rpcRegistrations[0]!.handlers as { refresh: () => Promise<{ ok: boolean }> }
    entries = [{ slug: "second" }]
    expect(await handlers.refresh()).toMatchObject({ ok: true })
    const provider = host.providers[0] as { models: { id: string }[] }
    // The fresh model is published; the previous one is retained as stale.
    expect(provider.models[0]?.id).toBe("second")
    expect(provider.models.map((model) => model.id)).toContain("first")
    expect(host.providerReloads()).toBeGreaterThan(before)
  })
})

describe("F04 an older refresh cannot overwrite a newer one", () => {
  const deferred = () => {
    let done!: (value?: unknown) => void
    const promise = new Promise<unknown>((resolve) => (done = resolve))
    return { promise, done }
  }

  test("the last read issued is the last commit written", async () => {
    const barrier = deferred()
    const entered = deferred()
    let reads = 0
    let saves = 0
    const commits: string[] = []
    const store = createMemoryCatalogStore()
    const service = new CatalogService({
      store: {
        load: store.load,
        save: async (record) => {
          if (++saves === 1) {
            entered.done()
            await barrier.promise
          }
          await store.save(record)
        },
      },
      read: async () => ({ ok: true, kind: "ok", entries: [{ id: ++reads === 1 ? "old" : "new" }] }),
      onCommit: (commit) => {
        commits.push(commit.record.models[0]!.entry.id)
      },
      onFailure: () => undefined,
    })
    await service.activate(
      {
        address: "http://127.0.0.1:1",
        key: "sk-fake",
        baseURL: "http://127.0.0.1:1/v1",
        modelsURL: "http://127.0.0.1:1/v1/models",
        fingerprint: "fake",
      },
      1,
    )
    const older = service.refresh({ generation: 1, mode: "manual" })
    await entered.promise
    // The newer read is issued while the older storage write is still pending.
    const newer = service.refresh({ generation: 1, mode: "manual" })
    barrier.done()
    const olderOutcome = await older
    await newer
    expect(commits).toEqual(["new"])
    expect(olderOutcome.committed).toBe(false)
    expect((await store.load("fake"))?.models[0]?.entry.id).toBe("new")
    service.dispose()
  })
})

describe("F05 a pause wait open at an interruption is part of that turn", () => {
  test("an interrupted turn subtracts the wait it was holding", () => {
    let now = 1000
    const tracker = new SessionStatsTracker({ now: () => now })
    tracker.observe({ type: "session.execution.started", created: 1000, data: { sessionID: "s" } })
    now = 1200
    tracker.notePauseStart("s")
    now = 3200
    tracker.observe({ type: "session.execution.interrupted", created: 3200, data: { sessionID: "s" } })
    tracker.notePauseEnd("s")
    const lastTurn = tracker.read("s")?.lastTurn
    expect(lastTurn?.pausedMs).toBe(2000)
    expect(lastTurn?.effectiveMs).toBe(200)
  })
})

describe("F06 the TUI drops stats the server no longer knows", () => {
  test("an authoritative absence clears the cached stats", async () => {
    let result: unknown = {
      stats: {
        sessionID: "s",
        turns: 1,
        running: false,
        steps: 1,
        retries: 0,
        effectiveMs: 1000,
        tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    }
    const rpc = { stats: async () => result, events: { on: () => () => undefined } } as never
    const view = createConnectionView({ rpc })
    await view.reloadStats("s")
    expect(view.stats("s")?.turns).toBe(1)
    result = {}
    await view.reloadStats("s")
    expect(view.stats("s")).toBeUndefined()
  })
})
