import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../src/catalog"
import { connectionFingerprint, mergeCatalog, type CatalogRecord } from "../../src/catalog-cache"
import {
  CatalogService,
  type CatalogCommit,
  type CatalogFailure,
  type CatalogIdentity,
  type CatalogReadInput,
} from "../../src/catalog-service"
import { createMemoryCatalogStore, type CatalogStore } from "../../src/catalog-store"
import type { VerifyKind, VerifyResult } from "../../src/state"

const STALE_TTL = 7 * 24 * 60 * 60 * 1000

function identityFor(address: string, key: string): CatalogIdentity {
  const baseURL = `${address}/v1`
  return {
    address,
    key,
    baseURL,
    modelsURL: `${baseURL}/models?client_version=test`,
    fingerprint: connectionFingerprint(baseURL, key),
  }
}

const identityA = identityFor("http://a.test", "sk-a")
const identityB = identityFor("http://b.test", "sk-b")

const entry = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, ...extra })
const ok = (entries: CatalogEntry[]): VerifyResult => ({
  ok: true,
  kind: entries.length > 0 ? "ok" : "empty",
  entries,
})
const failure = (kind: VerifyKind, message?: string): VerifyResult => ({
  ok: false,
  kind,
  ...(message !== undefined ? { message } : {}),
  entries: [],
})

/** A reader whose calls resolve only when the test says so. */
function readerQueue() {
  const pending: { resolve: (result: VerifyResult) => void; signal: AbortSignal }[] = []
  const read = (input: CatalogReadInput): Promise<VerifyResult> =>
    new Promise((resolve) => {
      pending.push({ resolve, signal: input.signal })
    })
  return { read, pending }
}

function recordFor(identity: CatalogIdentity, entries: CatalogEntry[], now: number): CatalogRecord {
  return mergeCatalog({
    entries,
    baseURL: identity.baseURL,
    modelsURL: identity.modelsURL,
    fingerprint: identity.fingerprint,
    now,
  })
}

interface Harness {
  service: CatalogService
  commits: CatalogCommit[]
  failures: CatalogFailure[]
  setClock: (value: number) => void
}

function makeHarness(input: {
  read: (input: CatalogReadInput) => Promise<VerifyResult>
  store?: CatalogStore
  staleTtlMs?: number
}): Harness {
  const commits: CatalogCommit[] = []
  const failures: CatalogFailure[] = []
  let clock = 1000
  const service = new CatalogService({
    store: input.store ?? createMemoryCatalogStore(),
    read: input.read,
    onCommit: (commit) => {
      commits.push(commit)
    },
    onFailure: (failure) => {
      failures.push(failure)
    },
    now: () => clock,
    ...(input.staleTtlMs !== undefined ? { staleTtlMs: input.staleTtlMs } : {}),
  })
  return { service, commits, failures, setClock: (value) => (clock = value) }
}

describe("CatalogService cache", () => {
  test("activate loads a matching cache and refresh merges against it", async () => {
    const cached = recordFor(identityA, [entry("a"), entry("b")], 500)
    const store = createMemoryCatalogStore([cached])
    const harness = makeHarness({ read: async () => ok([entry("a")]), store })

    const loaded = await harness.service.activate(identityA, 1)
    expect(loaded?.models.map((state) => state.entry.id)).toEqual(["a", "b"])
    expect(harness.service.ready).toBe(true)

    harness.setClock(2000)
    const outcome = await harness.service.refresh({ generation: 1, mode: "background" })
    expect(outcome.committed).toBe(true)
    // `b` is gone from the live read but retained as stale.
    expect(harness.service.current()?.models.map((state) => state.entry.id)).toEqual(["a", "b"])
    expect(harness.service.current()?.models.find((state) => state.entry.id === "b")?.staleSince).toBe(2000)
    expect(harness.commits[0]?.record.fetchedAt).toBe(2000)
  })

  test("does not load a cache for a different connection", async () => {
    const store = createMemoryCatalogStore([recordFor(identityA, [entry("a")], 500)])
    const harness = makeHarness({ read: async () => ok([entry("b")]), store })
    expect(await harness.service.activate(identityB, 1)).toBeUndefined()
    expect(harness.service.current()).toBeUndefined()
  })

  test("rejects a stored record whose fingerprint does not match the request", async () => {
    const foreign = recordFor(identityA, [entry("leaked")], 500)
    const store: CatalogStore = {
      load: async () => foreign,
      save: async () => undefined,
    }
    const harness = makeHarness({ read: async () => ok([]), store })
    expect(await harness.service.activate(identityB, 1)).toBeUndefined()
  })

  test("refresh without an active connection commits nothing", async () => {
    const harness = makeHarness({ read: async () => ok([entry("a")]) })
    const outcome = await harness.service.refresh({ generation: 1, mode: "manual" })
    expect(outcome).toMatchObject({ ok: false, kind: "stale", committed: false })
    expect(harness.commits).toHaveLength(0)
  })
})

describe("CatalogService refresh outcomes", () => {
  test("a failed read keeps the last good directory and reports the failure", async () => {
    const results: VerifyResult[] = [ok([entry("kept")]), failure("auth", "401")]
    const harness = makeHarness({ read: async () => results.shift() ?? failure("unreachable") })
    await harness.service.activate(identityA, 1)

    const good = await harness.service.refresh({ generation: 1, mode: "initial" })
    expect(good.committed).toBe(true)
    expect(harness.commits).toHaveLength(1)

    const bad = await harness.service.refresh({ generation: 1, mode: "manual" })
    expect(bad).toMatchObject({ ok: false, kind: "auth", committed: false })
    // The catalog is untouched and the failure says it had one to keep.
    expect(harness.commits).toHaveLength(1)
    expect(harness.service.current()?.models.map((state) => state.entry.id)).toEqual(["kept"])
    expect(harness.failures).toEqual([{ generation: 1, kind: "auth", message: "401", hadCatalog: true }])
  })

  test("an empty directory is a success, not a failure", async () => {
    const harness = makeHarness({ read: async () => ok([]) })
    await harness.service.activate(identityA, 1)
    const outcome = await harness.service.refresh({ generation: 1, mode: "initial" })
    expect(outcome).toMatchObject({ ok: true, kind: "empty", committed: true })
    expect(harness.failures).toHaveLength(0)
    expect(harness.commits[0]?.kind).toBe("empty")
    expect(harness.commits[0]?.record.models).toEqual([])
  })

  test("a reader that throws is reported as unreachable without touching the catalog", async () => {
    const harness = makeHarness({
      read: async () => {
        throw new Error("socket hang up")
      },
    })
    await harness.service.activate(identityA, 1)
    const outcome = await harness.service.refresh({ generation: 1, mode: "initial" })
    expect(outcome).toMatchObject({ ok: false, kind: "unreachable", committed: false })
    expect(harness.failures[0]?.message).toContain("socket hang up")
    expect(harness.commits).toHaveLength(0)
  })
})

describe("CatalogService ordering and cancellation", () => {
  test("two overlapping refreshes settle in request order, not completion order", async () => {
    const queue = readerQueue()
    const harness = makeHarness({ read: queue.read })
    await harness.service.activate(identityA, 1)

    const background = harness.service.refresh({ generation: 1, mode: "background" })
    const manual = harness.service.refresh({ generation: 1, mode: "manual" })
    expect(queue.pending).toHaveLength(2)

    // The newer request finishes first; the older one finishes late and loses.
    queue.pending[1]!.resolve(ok([entry("fresh")]))
    expect(await manual).toMatchObject({ committed: true, kind: "ok" })
    queue.pending[0]!.resolve(ok([entry("stale")]))
    const late = await background
    expect(late).toMatchObject({ ok: true, kind: "cancelled", committed: false })

    expect(harness.commits).toHaveLength(1)
    expect(harness.commits[0]?.record.models.map((state) => state.entry.id)).toEqual(["fresh"])
  })

  test("a superseding refresh aborts the previous read", async () => {
    const queue = readerQueue()
    const harness = makeHarness({ read: queue.read })
    await harness.service.activate(identityA, 1)

    const first = harness.service.refresh({ generation: 1, mode: "background" })
    expect(queue.pending[0]!.signal.aborted).toBe(false)

    const second = harness.service.refresh({ generation: 1, mode: "manual" })
    expect(queue.pending[0]!.signal.aborted).toBe(true)

    queue.pending[1]!.resolve(ok([entry("fresh")]))
    expect(await second).toMatchObject({ committed: true })
    queue.pending[0]!.resolve(ok([entry("late")]))
    expect(await first).toMatchObject({ committed: false, kind: "cancelled" })
  })

  test("a connection switch invalidates an in-flight refresh", async () => {
    const queue = readerQueue()
    const harness = makeHarness({ read: queue.read })
    await harness.service.activate(identityA, 1)

    const inflight = harness.service.refresh({ generation: 1, mode: "manual" })
    await harness.service.activate(identityB, 2)

    queue.pending[0]!.resolve(ok([entry("from-a")]))
    expect(await inflight).toMatchObject({ committed: false, kind: "cancelled" })
    expect(harness.commits).toHaveLength(0)

    const next = harness.service.refresh({ generation: 2, mode: "initial" })
    queue.pending[1]!.resolve(ok([entry("from-b")]))
    expect(await next).toMatchObject({ committed: true })
    expect(harness.commits).toHaveLength(1)
    expect(harness.commits[0]?.record.fingerprint).toBe(identityB.fingerprint)
    expect(harness.commits[0]?.record.models.map((state) => state.entry.id)).toEqual(["from-b"])
  })

  test("dispose cancels an in-flight refresh and releases the connection", async () => {
    const queue = readerQueue()
    const harness = makeHarness({ read: queue.read })
    await harness.service.activate(identityA, 1)

    const inflight = harness.service.refresh({ generation: 1, mode: "manual" })
    harness.service.dispose()
    expect(harness.service.ready).toBe(false)

    queue.pending[0]!.resolve(ok([entry("too-late")]))
    expect(await inflight).toMatchObject({ committed: false, kind: "cancelled" })
    expect(harness.commits).toHaveLength(0)
    expect(harness.service.current()).toBeUndefined()
  })

  test("a refresh with a superseded generation is refused before reading", async () => {
    const queue = readerQueue()
    const harness = makeHarness({ read: queue.read })
    await harness.service.activate(identityA, 1)
    const outcome = await harness.service.refresh({ generation: 0, mode: "manual" })
    expect(outcome).toMatchObject({ kind: "stale", committed: false })
    expect(queue.pending).toHaveLength(0)
  })
})

describe("CatalogService controlled clock and applyRead", () => {
  test("keeps a model stale across the window and drops it at the boundary", async () => {
    const queue = readerQueue()
    const harness = makeHarness({ read: queue.read, staleTtlMs: STALE_TTL })
    await harness.service.activate(identityA, 1)

    // The reader only settles when the test resolves its pending call, so start
    // the refresh first and then answer it.
    const run = async (entries: CatalogEntry[], now: number) => {
      harness.setClock(now)
      const pending = harness.service.refresh({ generation: 1, mode: "manual" })
      queue.pending.at(-1)!.resolve(ok(entries))
      return pending
    }

    await run([entry("a"), entry("b")], 1000)
    await run([entry("a")], 2000)
    expect(harness.service.current()?.models).toHaveLength(2)

    // Still inside the window.
    await run([entry("a")], 2000 + STALE_TTL - 1)
    expect(harness.service.current()?.models.map((state) => state.entry.id)).toEqual(["a", "b"])

    // Exactly at the window the model is dropped.
    await run([entry("a")], 2000 + STALE_TTL)
    expect(harness.service.current()?.models.map((state) => state.entry.id)).toEqual(["a"])
  })

  test("applyRead commits a verify-before-save read against the connection's cache", async () => {
    const cached = recordFor(identityA, [entry("a"), entry("b")], 500)
    const store = createMemoryCatalogStore([cached])
    const harness = makeHarness({ read: async () => ok([]), store })
    await harness.service.activate(identityA, 1)

    harness.setClock(2000)
    const record = await harness.service.applyRead({ generation: 1, entries: [entry("a")], kind: "ok" })
    expect(record?.models.map((state) => state.entry.id)).toEqual(["a", "b"])
    expect(harness.commits).toHaveLength(1)
    expect(harness.commits[0]?.kind).toBe("ok")

    // A read from a superseded generation is refused.
    expect(await harness.service.applyRead({ generation: 99, entries: [entry("a")] })).toBeUndefined()
    expect(harness.commits).toHaveLength(1)
  })

  test("isStale tracks the served record", async () => {
    const cached = recordFor(identityA, [entry("a"), entry("b")], 500)
    // Make `b` stale by merging a later read without it.
    const store = createMemoryCatalogStore([
      mergeCatalog({
        previous: cached,
        entries: [entry("a")],
        baseURL: identityA.baseURL,
        modelsURL: identityA.modelsURL,
        fingerprint: identityA.fingerprint,
        now: 2000,
      }),
    ])
    const harness = makeHarness({ read: async () => ok([entry("a")]), store })
    await harness.service.activate(identityA, 1)
    expect(harness.service.isStale("b")).toBe(true)
    expect(harness.service.isStale("a")).toBe(false)
    expect(harness.service.isStale("missing")).toBe(false)
  })
})
