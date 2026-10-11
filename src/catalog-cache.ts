/**
 * Directory cache, stale retention and connection identity.
 *
 * A cache record belongs to exactly one connection (address + key). It is
 * persisted under a one-way fingerprint of that pair, so a directory read for
 * one credential can never be served to another, and the key itself is never
 * written anywhere.
 *
 * Stale retention follows the reference plugin: a model that disappears from
 * the directory is kept, marked, and dropped only after it has been missing for
 * the whole retention window. The window is measured from the first miss, so a
 * model that keeps flickering is not retained forever.
 */

import { createHash } from "node:crypto"
import type { CatalogEntry } from "./catalog"

/** Bumped when the persisted shape changes; an older record is ignored. */
export const CATALOG_RECORD_VERSION = 1
/** Default retention window for a model that disappeared from the directory. */
export const CATALOG_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** One model in the cached directory, with its staleness bookkeeping. */
export interface CatalogModelState {
  readonly entry: CatalogEntry
  /** Last time the directory actually listed this model. */
  readonly lastSeenAt: number
  /** First time this model was missing from an otherwise valid read. */
  readonly staleSince?: number
  readonly stale: boolean
}

/** The cached directory for one connection. Never contains the API key. */
export interface CatalogRecord {
  readonly version: typeof CATALOG_RECORD_VERSION
  readonly baseURL: string
  readonly modelsURL: string
  /** `connectionFingerprint` of the connection this record belongs to. */
  readonly fingerprint: string
  /** When the directory was last read successfully. */
  readonly fetchedAt: number
  readonly models: readonly CatalogModelState[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * One-way identity of a connection. The digest is stable across restarts, so a
 * matching cache is found again, but it is not the key and cannot be used as
 * one. Two different keys at the same address always produce different values.
 */
export function connectionFingerprint(baseURL: string, key: string): string {
  return createHash("sha256").update(`${baseURL}\n${key}`, "utf8").digest("hex")
}

export function catalogStorageKey(fingerprint: string): string {
  return `catalog.v${CATALOG_RECORD_VERSION}.${fingerprint}`
}

export interface MergeCatalogInput {
  /** Previous record; ignored when it belongs to a different connection. */
  readonly previous?: CatalogRecord
  readonly entries: readonly CatalogEntry[]
  readonly baseURL: string
  readonly modelsURL: string
  readonly fingerprint: string
  readonly now: number
  readonly staleTtlMs?: number
}

/**
 * Fold a fresh directory read into the cached record.
 *
 * `entries` is a complete, successful read: listed models become current again
 * (which also clears their stale mark), missing ones are retained until the
 * retention window since their first miss has passed.
 */
export function mergeCatalog(input: MergeCatalogInput): CatalogRecord {
  const staleTtlMs = input.staleTtlMs ?? CATALOG_STALE_TTL_MS
  const previous =
    input.previous && input.previous.fingerprint === input.fingerprint ? input.previous : undefined

  const fresh: CatalogModelState[] = input.entries.map((entry) => ({
    entry,
    lastSeenAt: input.now,
    stale: false,
  }))
  const freshIds = new Set(fresh.map((state) => state.entry.id))

  const retained: CatalogModelState[] = []
  for (const state of previous?.models ?? []) {
    if (freshIds.has(state.entry.id)) continue
    const staleSince = state.stale ? (state.staleSince ?? state.lastSeenAt) : input.now
    // Retained while the model has been missing for less than the window; at the
    // boundary it is dropped, matching the reference plugin.
    if (input.now - staleSince < staleTtlMs) {
      retained.push({
        entry: state.entry,
        lastSeenAt: state.lastSeenAt,
        staleSince,
        stale: true,
      })
    }
  }

  return {
    version: CATALOG_RECORD_VERSION,
    baseURL: input.baseURL,
    modelsURL: input.modelsURL,
    fingerprint: input.fingerprint,
    fetchedAt: input.now,
    models: [...fresh, ...retained],
  }
}

function parseEntry(value: unknown): CatalogEntry | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== "string" || value.id.trim() === "") return undefined
  const entry: Record<string, unknown> = { id: value.id }
  if (typeof value.name === "string") entry.name = value.name
  if (typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow)) {
    entry.contextWindow = value.contextWindow
  }
  if (typeof value.maxOutputTokens === "number" && Number.isFinite(value.maxOutputTokens)) {
    entry.maxOutputTokens = value.maxOutputTokens
  }
  if (Array.isArray(value.inputModalities) && value.inputModalities.every((item) => typeof item === "string")) {
    entry.inputModalities = value.inputModalities
  }
  if (Array.isArray(value.reasoningLevels) && value.reasoningLevels.every((item) => typeof item === "string")) {
    entry.reasoningLevels = value.reasoningLevels
  }
  if (typeof value.hidden === "boolean") entry.hidden = value.hidden
  return entry as unknown as CatalogEntry
}

function parseModelState(value: unknown): CatalogModelState | undefined {
  if (!isRecord(value)) return undefined
  const entry = parseEntry(value.entry)
  if (!entry) return undefined
  if (typeof value.lastSeenAt !== "number" || !Number.isFinite(value.lastSeenAt)) return undefined
  if (typeof value.stale !== "boolean") return undefined
  const state: { entry: CatalogEntry; lastSeenAt: number; stale: boolean; staleSince?: number } = {
    entry,
    lastSeenAt: value.lastSeenAt,
    stale: value.stale,
  }
  if (value.staleSince !== undefined) {
    if (typeof value.staleSince !== "number" || !Number.isFinite(value.staleSince)) return undefined
    state.staleSince = value.staleSince
  }
  return state
}

/**
 * Validate a persisted record. Storage is shared with other runs and possibly
 * older versions, so anything unexpected is treated as "no cache" instead of
 * being trusted or crashing the plugin.
 */
export function parseCatalogRecord(value: unknown): CatalogRecord | undefined {
  if (!isRecord(value)) return undefined
  if (value.version !== CATALOG_RECORD_VERSION) return undefined
  if (typeof value.baseURL !== "string" || typeof value.modelsURL !== "string") return undefined
  if (typeof value.fingerprint !== "string" || value.fingerprint === "") return undefined
  if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) return undefined
  if (!Array.isArray(value.models)) return undefined

  const models: CatalogModelState[] = []
  for (const item of value.models) {
    const state = parseModelState(item)
    if (!state) return undefined
    models.push(state)
  }

  return {
    version: CATALOG_RECORD_VERSION,
    baseURL: value.baseURL,
    modelsURL: value.modelsURL,
    fingerprint: value.fingerprint,
    fetchedAt: value.fetchedAt,
    models,
  }
}

export function countStale(record: CatalogRecord | undefined): number {
  if (!record) return 0
  let count = 0
  for (const state of record.models) if (state.stale) count += 1
  return count
}

/** Stale model ids, capped so a snapshot stays small. */
export function staleIds(record: CatalogRecord | undefined, limit = 20): string[] {
  if (!record) return []
  const ids: string[] = []
  for (const state of record.models) {
    if (state.stale && ids.length < limit) ids.push(state.entry.id)
  }
  return ids
}

export function isStaleModel(record: CatalogRecord | undefined, modelID: string): boolean {
  if (!record) return false
  return record.models.some((state) => state.stale && state.entry.id === modelID)
}
