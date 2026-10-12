// Permanent regressions for the fresh-review residuals fixed in this slice.
//
// Each test names the positive behaviour the review proved missing: the connect
// transaction is ordered around the native save (F02), an older directory commit
// cannot outlive a newer one and needs no repair write (F04), a withdrawn service
// tier is never dispatched before the location reloads (F03), an authoritative
// refresh applies a pending snapshot (F07) and drops the previous generation's
// stats (F05), and a live turn excludes an open pause wait (F06).

import { describe, expect, test } from "bun:test"
import { CatalogService } from "../../src/catalog-service"
import { createMemoryCatalogStore } from "../../src/catalog-store"
import { SessionStatsTracker } from "../../src/stats"
import { createConnectionView } from "../../src/tui-connection"
import plugin from "../../src/index"
import { createFakeHost, type FakeHost } from "../support/fake-ctx"
import { startMockCpa } from "../support/mock-cpa.mjs"

const gate = () => {
  let done!: () => void
  const promise = new Promise<void>((resolve) => (done = resolve))
  return { promise, done }
}

const identity = {
  address: "http://127.0.0.1:1",
  key: "sk-fake",
  baseURL: "http://127.0.0.1:1/v1",
  modelsURL: "http://127.0.0.1:1/v1/models",
  fingerprint: "fake",
}

const result = (id: string) => ({ ok: true as const, kind: "ok" as const, entries: [{ id }] })

/** Drive the plugin against one A and one B mock, restoring everything after. */
async function withPair(
  body: (host: FakeHost, rpc: Record<string, (input?: unknown) => Promise<any>>, cleanup: () => Promise<void>, a: any, b: any) => Promise<void>,
): Promise<void> {
  const a = await startMockCpa({ models: [{ slug: "shared", supported_reasoning_levels: ["high"] }] })
  const b = await startMockCpa({ models: [{ slug: "shared", supported_reasoning_levels: ["low"] }] })
  const host = createFakeHost({ options: { baseURL: a.url, apiKey: "sk-fake-A", modelsDev: false } })
  let cleanup: (() => Promise<void>) | undefined
  try {
    cleanup = (await plugin.setup(host.ctx as never)) as unknown as () => Promise<void>
    host.restoreConsole()
    await body(host, host.rpcRegistrations[0]!.handlers as never, cleanup, a, b)
  } finally {
    host.restoreConsole()
    await cleanup?.()
    await a.close()
    await b.close()
  }
}

describe("F02 the native save is the connect transaction's commit point", () => {
  test("a refresh during the pending save never binds the candidate directory to the previous credential", async () => {
    await withPair(async (host, rpc, _cleanup, a, b) => {
      const entered = gate()
      const release = gate()
      const original = (host.ctx as any).integration.connect.key
      ;(host.ctx as any).integration.connect.key = async (input: unknown) => {
        entered.done()
        await release.promise
        await original(input)
      }

      const connect = rpc.connect!({ address: b.url, key: "sk-fake-B" })
      await entered.promise
      // The candidate has verified but not saved: the served pair is still A.
      await rpc.refresh!()
      const provider = host.providers[0] as any
      const value = host.credentials.find((credential) => credential.id === provider.sourceConnection.id)!.value
      expect(provider.info.settings.baseURL).toBe(`${value.configuration!.baseURL}/v1`)
      expect((await rpc.status!()).address).toBe(a.url)

      release.done()
      await connect
      const saved = host.providers[0] as any
      const savedCredential = host.credentials.find((credential) => credential.id === saved.sourceConnection.id)!.value
      expect(saved.info.settings.baseURL).toBe(`${savedCredential.configuration!.baseURL}/v1`)
      expect((await rpc.status!()).address).toBe(b.url)
    })
  })

  test("a rejected native save leaves the previous connection active and refreshable", async () => {
    await withPair(async (host, rpc, _cleanup, a, b) => {
      ;(host.ctx as any).integration.connect.key = async () => {
        throw new Error("fictional native save refused")
      }
      const failed = await rpc.connect!({ address: b.url, key: "sk-fake-B" })
      expect(failed.ok).toBe(false)
      expect(String(failed.message)).toContain("could not be saved")
      await rpc.refresh!()
      const provider = host.providers[0] as any
      expect(provider.info.settings.baseURL).toBe(`${a.url}/v1`)
      expect((await rpc.status!()).address).toBe(a.url)
    })
  })

  test("a candidate that already saved stays consistent when a newer candidate is rejected", async () => {
    const bad = await startMockCpa({ directory: { status: 401, body: { error: "fictional" } } })
    try {
      await withPair(async (host, rpc, _cleanup, _a, b) => {
        const entered = gate()
        const release = gate()
        const original = (host.ctx as any).integration.connect.key
        ;(host.ctx as any).integration.connect.key = async (input: unknown) => {
          entered.done()
          await release.promise
          await original(input)
        }

        const first = rpc.connect!({ address: b.url, key: "sk-fake-B" })
        await entered.promise
        const second = rpc.connect!({ address: bad.url, key: "sk-fake-rejected" })
        release.done()
        const firstResult = await first
        await second
        await rpc.refresh!()

        // The saved key is the active credential; the snapshot and the provider
        // binding must describe that same pair, not the rejected candidate.
        const provider = host.providers[0] as any
        const value = host.credentials.find((credential) => credential.id === provider.sourceConnection.id)!.value
        const snapshot = await rpc.status!()
        expect(firstResult.ok).toBe(true)
        expect(snapshot.address).toBe(value.configuration!.baseURL)
        expect(provider.info.settings.baseURL).toBe(`${value.configuration!.baseURL}/v1`)
      })
    } finally {
      await bad.close()
    }
  })

  test("an unload during the pending save invalidates the candidate completion", async () => {
    await withPair(async (host, rpc, cleanup, _a, b) => {
      const entered = gate()
      const release = gate()
      const original = (host.ctx as any).integration.connect.key
      ;(host.ctx as any).integration.connect.key = async (input: unknown) => {
        entered.done()
        await release.promise
        await original(input)
      }

      const candidate = rpc.connect!({ address: b.url, key: "sk-fake-B" })
      await entered.promise
      await cleanup()
      release.done()
      const report = await candidate
      expect(report.ok).toBe(false)
      expect(String(report.message)).toContain("unloaded")
    })
  })
})

describe("F04 an older commit cannot outlive a newer one", () => {
  test("a newer issued read invalidates an older save before that read completes", async () => {
    const entered = gate()
    const saveRelease = gate()
    const readRelease = gate()
    const store = createMemoryCatalogStore()
    const commits: string[] = []
    let reads = 0
    let saves = 0
    const service = new CatalogService({
      store: {
        load: store.load,
        save: async (record) => {
          if (++saves === 1) {
            entered.done()
            await saveRelease.promise
          }
          await store.save(record)
        },
      },
      read: async () => {
        if (++reads === 1) return result("old")
        await readRelease.promise
        return { ok: false, kind: "auth", entries: [] }
      },
      onCommit: (commit) => {
        commits.push(commit.record.models[0]!.entry.id)
      },
      onFailure: () => undefined,
    })
    await service.activate(identity, 1)
    const old = service.refresh({ generation: 1, mode: "manual" })
    await entered.promise
    const newer = service.refresh({ generation: 1, mode: "manual" })
    saveRelease.done()
    const oldOutcome = await old
    readRelease.done()
    await newer
    expect(oldOutcome.committed).toBe(false)
    expect(commits).toEqual([])
    service.dispose()
  })

  test("a newer read issued during the older cache write leaves the newest record served and cached", async () => {
    const saveEntered = gate()
    const saveRelease = gate()
    const store = createMemoryCatalogStore()
    const commits: string[] = []
    let reads = 0
    let saves = 0
    const service = new CatalogService({
      store: {
        load: store.load,
        save: async (record) => {
          if (++saves === 1) {
            saveEntered.done()
            await saveRelease.promise
          }
          await store.save(record)
        },
      },
      read: async () => result(++reads === 1 ? "old" : "new"),
      onCommit: (commit) => {
        commits.push(commit.record.models[0]!.entry.id)
      },
      onFailure: () => undefined,
    })
    await service.activate(identity, 1)
    const old = service.refresh({ generation: 1, mode: "manual" })
    await saveEntered.promise
    // The newer read is issued while the older cache write is still pending.
    const newer = service.refresh({ generation: 1, mode: "manual" })
    saveRelease.done()
    expect((await old).committed).toBe(false)
    expect((await newer).committed).toBe(true)
    // The superseded commit published nothing; the cache ends on the newest one
    // because commits are applied in issue order, with no repair write.
    expect(commits).toEqual(["new"])
    expect(service.current()?.models[0]?.entry.id).toBe("new")
    expect((await store.load("fake"))?.models[0]?.entry.id).toBe("new")
    service.dispose()
  })

  test("a new generation of the same pair cannot be overwritten by an older in-flight save", async () => {
    const entered = gate()
    const release = gate()
    const store = createMemoryCatalogStore()
    let reads = 0
    let saves = 0
    const service = new CatalogService({
      store: {
        load: store.load,
        save: async (record) => {
          if (++saves === 1) {
            entered.done()
            await release.promise
          }
          await store.save(record)
        },
      },
      read: async () => result(++reads === 1 ? "old" : "new"),
      onCommit: () => undefined,
      onFailure: () => undefined,
    })
    await service.activate(identity, 1)
    const old = service.refresh({ generation: 1, mode: "manual" })
    await entered.promise
    await service.activate({ ...identity }, 2)
    // Issue the new generation's read while the older save is still pending; it
    // is queued behind that commit, so release it before awaiting the result.
    const newer = service.refresh({ generation: 2, mode: "manual" })
    release.done()
    await old
    await newer
    expect((await store.load("fake"))?.models[0]?.entry.id).toBe("new")
    service.dispose()
  })
})

describe("F03 a withdrawn service tier is not dispatched before the reload", () => {
  test("the model.request hook refuses the model until the saved directory declares it again", async () => {
    let entries: unknown[] = [{ slug: "shared", service_tiers: ["priority"] }, { slug: "plain" }]
    const mock = await startMockCpa({ directory: () => ({ body: { models: entries } }) })
    const host = createFakeHost({
      options: { baseURL: mock.url, apiKey: "sk-fake", modelsDev: false },
      storage: { "cliproxyapi.fast.cliproxyapi": true },
    })
    try {
      await plugin.setup(host.ctx as never)
      host.restoreConsole()
      const handlers = host.rpcRegistrations[0]!.handlers as any
      expect((await handlers.status()).fastEffectiveModels).toBe(1)

      entries = [{ slug: "shared" }, { slug: "plain" }]
      await handlers.refresh()
      expect(await handlers.status()).toMatchObject({ applied: false, reloadRequired: true, fastEffectiveModels: 1 })

      const hook = host.sessionHooks.filter((entry) => entry.name === "model.request").at(-1)!
      await expect(Promise.resolve(hook.callback({ sessionID: "s", model: { id: "shared" } }))).rejects.toThrow(
        /service tier/,
      )
      // A model the runtime never asked for priority on is unaffected.
      await expect(Promise.resolve(hook.callback({ sessionID: "s", model: { id: "plain" } }))).resolves.toBeUndefined()
    } finally {
      host.restoreConsole()
      await mock.close()
    }
  })
})

describe("F07 an authoritative refresh applies a pending snapshot", () => {
  test("the initial and reconnect refresh reloads the location instead of waiting for an event", async () => {
    let pending = true
    let reloads = 0
    const snap = () => ({
      location: "/review",
      providerID: "cliproxyapi",
      integrationID: "cliproxyapi",
      keyHint: "(redacted)",
      keySaved: true,
      verified: "ok",
      fastEnabled: false,
      fastEffectiveModels: 0,
      applied: !pending,
      reloadRequired: pending,
    })
    const view = createConnectionView({
      directory: "/review",
      rpc: {
        status: async () => snap(),
        pauseState: async () => ({ paused: false, changedAt: 1, waiting: 0, scope: "location" }),
        events: { on: () => () => undefined },
      } as never,
      reload: async () => {
        reloads += 1
        pending = false
      },
    })
    await view.refresh()
    expect(reloads).toBe(1)
    expect(view.snapshot()?.applied).toBe(true)
    // The same directory is applied already, so it is not reloaded again.
    await view.refresh()
    expect(reloads).toBe(1)
  })
})

describe("F05 an automatic apply drops the previous generation's stats", () => {
  test("a same-connection reload invalidates the cached stats", async () => {
    let absent = false
    const stats = {
      sessionID: "s",
      turns: 1,
      running: false,
      steps: 1,
      retries: 0,
      effectiveMs: 1000,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
    }
    const snap = () => ({
      location: "/review",
      providerID: "cliproxyapi",
      integrationID: "cliproxyapi",
      keyHint: "(redacted)",
      keySaved: true,
      verified: "ok",
      fastEnabled: false,
      fastEffectiveModels: 0,
      applied: true,
      reloadRequired: false,
    })
    const view = createConnectionView({
      rpc: {
        status: async () => snap(),
        pauseState: async () => ({ paused: false, changedAt: 1, waiting: 0, scope: "location" }),
        stats: async () => (absent ? {} : { stats }),
        setFast: async () => ({ ok: true, snapshot: { ...snap(), applied: false, reloadRequired: true } }),
        events: { on: () => () => undefined },
      } as never,
      reload: async () => {
        absent = true
      },
    })
    await view.refresh()
    await view.reloadStats("s")
    expect(view.stats("s")?.turns).toBe(1)
    await view.setFast(true)
    expect(view.stats("s")).toBeUndefined()
  })
})

describe("F06 a live turn excludes an open pause wait", () => {
  test("the projected effective time subtracts the wait that is still open", () => {
    let now = 1000
    const tracker = new SessionStatsTracker({ now: () => now })
    tracker.observe({ type: "session.execution.started", created: 1000, data: { sessionID: "s" } })
    now = 1200
    tracker.notePauseStart("s")
    now = 3200
    const lastTurn = tracker.read("s")?.lastTurn
    expect(lastTurn?.effectiveMs).toBe(200)
    expect(lastTurn?.pausedMs).toBe(2000)
  })
})
