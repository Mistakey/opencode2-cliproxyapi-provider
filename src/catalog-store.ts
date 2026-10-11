/**
 * Persistence for the directory cache.
 *
 * Uses OpenCode's own plugin storage, so the record lives in the host's data
 * directory rather than a file this plugin manages. Only the connection
 * fingerprint and the directory contents are stored; the API key is not.
 */

import { catalogStorageKey, parseCatalogRecord, type CatalogRecord } from "./catalog-cache"

/** The subset of the host storage domain this store needs. */
export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface CatalogStore {
  /** A record whose fingerprint matches, or `undefined` for a miss/corrupt entry. */
  load(fingerprint: string): Promise<CatalogRecord | undefined>
  save(record: CatalogRecord): Promise<void>
}

export function createStorageCatalogStore(storage: StorageLike): CatalogStore {
  return {
    async load(fingerprint) {
      const raw = await storage.get(catalogStorageKey(fingerprint))
      const record = parseCatalogRecord(raw)
      if (!record || record.fingerprint !== fingerprint) return undefined
      return record
    },
    async save(record) {
      await storage.set(catalogStorageKey(record.fingerprint), record)
    },
  }
}

/** In-memory store for tests and for a host that offers no storage domain. */
export function createMemoryCatalogStore(initial: CatalogRecord[] = []): CatalogStore {
  const records = new Map(initial.map((record) => [record.fingerprint, record]))
  return {
    load: async (fingerprint) => records.get(fingerprint),
    save: async (record) => {
      records.set(record.fingerprint, record)
    },
  }
}
