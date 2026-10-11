import { describe, expect, test } from "bun:test"
import {
  CATALOG_RECORD_VERSION,
  CATALOG_STALE_TTL_MS,
  catalogStorageKey,
  connectionFingerprint,
  countStale,
  isStaleModel,
  mergeCatalog,
  parseCatalogRecord,
  staleIds,
  type CatalogRecord,
} from "../../src/catalog-cache"
import type { CatalogEntry } from "../../src/catalog"

const BASE_URL = "http://cpa.test/v1"
const MODELS_URL = "http://cpa.test/v1/models?client_version=x"
const FINGERPRINT = connectionFingerprint(BASE_URL, "sk-fake-cache-0123456789")

const entry = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, ...extra })

function merge(input: {
  previous?: CatalogRecord
  entries: readonly CatalogEntry[]
  now: number
  staleTtlMs?: number
  fingerprint?: string
}): CatalogRecord {
  return mergeCatalog({
    previous: input.previous,
    entries: input.entries,
    baseURL: BASE_URL,
    modelsURL: MODELS_URL,
    fingerprint: input.fingerprint ?? FINGERPRINT,
    now: input.now,
    ...(input.staleTtlMs !== undefined ? { staleTtlMs: input.staleTtlMs } : {}),
  })
}

describe("connectionFingerprint", () => {
  test("is stable, one-way and distinct per connection", () => {
    const first = connectionFingerprint(BASE_URL, "sk-a")
    expect(first).toBe(connectionFingerprint(BASE_URL, "sk-a"))
    expect(first).toHaveLength(64)
    expect(first).not.toContain("sk-a")
    // A different key at the same address must never share a cache entry.
    expect(connectionFingerprint(BASE_URL, "sk-b")).not.toBe(first)
    // Nor a different address with the same key.
    expect(connectionFingerprint("http://other.test/v1", "sk-a")).not.toBe(first)
    expect(catalogStorageKey(first)).toBe(`catalog.v${CATALOG_RECORD_VERSION}.${first}`)
  })
})

describe("mergeCatalog", () => {
  test("marks a first read as fresh", () => {
    const record = merge({ entries: [entry("a"), entry("b")], now: 1000 })
    expect(record.fetchedAt).toBe(1000)
    expect(record.models).toEqual([
      { entry: { id: "a" }, lastSeenAt: 1000, stale: false },
      { entry: { id: "b" }, lastSeenAt: 1000, stale: false },
    ])
    expect(countStale(record)).toBe(0)
  })

  test("retains a disappeared model as stale from the first miss", () => {
    const first = merge({ entries: [entry("a"), entry("b")], now: 1000 })
    const second = merge({ previous: first, entries: [entry("a")], now: 2000 })
    expect(second.models.map((state) => state.entry.id)).toEqual(["a", "b"])
    expect(second.models[0]).toEqual({ entry: { id: "a" }, lastSeenAt: 2000, stale: false })
    expect(second.models[1]).toEqual({
      entry: { id: "b" },
      lastSeenAt: 1000,
      staleSince: 2000,
      stale: true,
    })
    expect(countStale(second)).toBe(1)
    expect(staleIds(second)).toEqual(["b"])
    expect(isStaleModel(second, "b")).toBe(true)
    expect(isStaleModel(second, "a")).toBe(false)
  })

  test("keeps the first-miss timestamp across later misses and drops at the window boundary", () => {
    const ttl = 10_000
    const first = merge({ entries: [entry("a"), entry("b")], now: 1000, staleTtlMs: ttl })
    const missed = merge({ previous: first, entries: [entry("a")], now: 2000, staleTtlMs: ttl })
    // A second miss keeps the original staleSince, not the new time.
    const stillMissed = merge({ previous: missed, entries: [entry("a")], now: 11_999, staleTtlMs: ttl })
    expect(stillMissed.models.find((state) => state.entry.id === "b")?.staleSince).toBe(2000)
    expect(countStale(stillMissed)).toBe(1)

    // Exactly at the boundary the model is dropped, one millisecond earlier it is kept.
    const kept = merge({ previous: stillMissed, entries: [entry("a")], now: 11_999, staleTtlMs: ttl })
    expect(countStale(kept)).toBe(1)
    const dropped = merge({ previous: stillMissed, entries: [entry("a")], now: 12_000, staleTtlMs: ttl })
    expect(dropped.models.map((state) => state.entry.id)).toEqual(["a"])
    expect(countStale(dropped)).toBe(0)
  })

  test("clears the stale mark when a model reappears and keeps its capabilities while stale", () => {
    const first = merge({
      entries: [
        entry("reasoner", {
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          inputModalities: ["text", "image"],
          reasoningLevels: ["low", "high"],
        }),
      ],
      now: 1000,
    })
    const missed = merge({ previous: first, entries: [], now: 2000 })
    expect(missed.models[0]?.stale).toBe(true)
    // Capabilities are kept with the retained entry, not re-derived.
    expect(missed.models[0]?.entry).toMatchObject({
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      inputModalities: ["text", "image"],
      reasoningLevels: ["low", "high"],
    })

    const back = merge({ previous: missed, entries: [entry("reasoner")], now: 3000 })
    expect(back.models).toEqual([{ entry: { id: "reasoner" }, lastSeenAt: 3000, stale: false }])
    expect(countStale(back)).toBe(0)
  })

  test("never reuses a record from another connection", () => {
    const other = merge({ entries: [entry("leaked")], now: 1000, fingerprint: "different-fingerprint" })
    const record = merge({ previous: other, entries: [entry("own")], now: 2000 })
    expect(record.models.map((state) => state.entry.id)).toEqual(["own"])
    expect(countStale(record)).toBe(0)
  })

  test("treats an empty directory as a valid read that stales the previous models", () => {
    const first = merge({ entries: [entry("a")], now: 1000 })
    const empty = merge({ previous: first, entries: [], now: 2000 })
    expect(empty.fetchedAt).toBe(2000)
    expect(empty.models).toHaveLength(1)
    expect(empty.models[0]?.stale).toBe(true)
    expect(countStale(empty)).toBe(1)
  })

  test("uses the seven day default window", () => {
    expect(CATALOG_STALE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
    const first = merge({ entries: [entry("a"), entry("b")], now: 0 })
    const missed = merge({ previous: first, entries: [entry("a")], now: 0 })
    const before = merge({ previous: missed, entries: [entry("a")], now: CATALOG_STALE_TTL_MS - 1 })
    expect(countStale(before)).toBe(1)
    const at = merge({ previous: before, entries: [entry("a")], now: CATALOG_STALE_TTL_MS })
    expect(countStale(at)).toBe(0)
  })
})

describe("parseCatalogRecord", () => {
  test("round-trips a record and rejects anything unexpected", () => {
    const record = merge({ entries: [entry("a", { contextWindow: 1000, hidden: true })], now: 1000 })
    expect(parseCatalogRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    expect(parseCatalogRecord(undefined)).toBeUndefined()
    expect(parseCatalogRecord({ ...record, version: CATALOG_RECORD_VERSION + 1 })).toBeUndefined()
    expect(parseCatalogRecord({ ...record, models: [{ entry: {} }] })).toBeUndefined()
    expect(parseCatalogRecord({ ...record, models: [{ entry: { id: "a" }, lastSeenAt: "soon", stale: false }] })).toBeUndefined()
    expect(parseCatalogRecord({ ...record, fetchedAt: Number.NaN })).toBeUndefined()
    expect(parseCatalogRecord("not a record")).toBeUndefined()
  })
})
