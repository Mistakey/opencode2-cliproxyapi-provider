/**
 * Directory refresh engine for one connection.
 *
 * The service owns the active connection identity, the cached directory and a
 * request token. Every asynchronous read is checked against the token and the
 * connection generation before it may commit, so a slow refresh from a
 * connection the user already replaced (or a plugin that was unloaded) can
 * never overwrite the newer state, and two overlapping refreshes settle in
 * request order rather than completion order.
 */

import type { CatalogEntry } from "./catalog"
import { isStaleModel, mergeCatalog, type CatalogRecord } from "./catalog-cache"
import type { CatalogStore } from "./catalog-store"
import type { VerifyKind, VerifyResult } from "./state"

/** Address/key pair a refresh belongs to. `key` is only used to read CPA. */
export interface CatalogIdentity {
  readonly address: string
  readonly key: string
  readonly baseURL: string
  readonly modelsURL: string
  readonly fingerprint: string
}

export interface CatalogReadInput {
  readonly identity: CatalogIdentity
  readonly signal: AbortSignal
}

export type CatalogReader = (input: CatalogReadInput) => Promise<VerifyResult>

export interface CatalogCommit {
  readonly generation: number
  readonly record: CatalogRecord
  readonly fromCache: boolean
  /** Outcome of the read that produced this record. */
  readonly kind: VerifyKind
}

export interface CatalogFailure {
  readonly generation: number
  readonly kind: VerifyKind
  readonly message?: string
  /** Whether a previous catalog is still being served. */
  readonly hadCatalog: boolean
}

export interface CatalogServiceInput {
  readonly store: CatalogStore
  readonly read: CatalogReader
  readonly onCommit: (commit: CatalogCommit) => Promise<void> | void
  readonly onFailure: (failure: CatalogFailure) => Promise<void> | void
  readonly now?: () => number
  readonly staleTtlMs?: number
}

export interface RefreshInput {
  readonly generation: number
  readonly mode: "initial" | "background" | "manual"
}

export type RefreshKind = VerifyKind | "stale" | "cancelled"

export interface RefreshOutcome {
  readonly ok: boolean
  readonly kind: RefreshKind
  readonly message?: string
  readonly record?: CatalogRecord
  /** True only when the read was applied to the active connection. */
  readonly committed: boolean
}

export class CatalogService {
  readonly #store: CatalogStore
  readonly #read: CatalogReader
  readonly #onCommit: CatalogServiceInput["onCommit"]
  readonly #onFailure: CatalogServiceInput["onFailure"]
  readonly #now: () => number
  readonly #staleTtlMs: number | undefined

  #identity: CatalogIdentity | undefined
  #generation = 0
  #record: CatalogRecord | undefined
  #token = 0
  #controller: AbortController | undefined
  #disposed = false

  constructor(input: CatalogServiceInput) {
    this.#store = input.store
    this.#read = input.read
    this.#onCommit = input.onCommit
    this.#onFailure = input.onFailure
    this.#now = input.now ?? Date.now
    this.#staleTtlMs = input.staleTtlMs
  }

  get ready(): boolean {
    return this.#identity !== undefined && !this.#disposed
  }

  current(): CatalogRecord | undefined {
    return this.#record
  }

  isStale(modelID: string): boolean {
    return isStaleModel(this.#record, modelID)
  }

  /**
   * Bind the service to a connection and load a matching cache.
   *
   * The generation is applied synchronously, so an in-flight refresh from the
   * previous connection is invalidated before this method awaits storage.
   */
  async activate(identity: CatalogIdentity, generation: number): Promise<CatalogRecord | undefined> {
    this.#abortInflight()
    this.#identity = identity
    this.#generation = generation
    this.#record = undefined
    if (this.#disposed) return undefined

    let loaded: CatalogRecord | undefined
    try {
      loaded = await this.#store.load(identity.fingerprint)
    } catch {
      loaded = undefined
    }
    if (this.#disposed || this.#generation !== generation || this.#identity !== identity) return undefined
    if (loaded && loaded.baseURL === identity.baseURL && loaded.modelsURL === identity.modelsURL) {
      this.#record = loaded
      return loaded
    }
    return undefined
  }

  /** Read the directory for the active connection and commit it if still current. */
  async refresh(input: RefreshInput): Promise<RefreshOutcome> {
    const identity = this.#identity
    if (this.#disposed || !identity || input.generation !== this.#generation) {
      return { ok: false, kind: "stale", committed: false }
    }

    const token = this.#token + 1
    this.#token = token
    this.#abortInflight()
    const controller = new AbortController()
    this.#controller = controller

    let result: VerifyResult
    try {
      result = await this.#read({ identity, signal: controller.signal })
    } catch (error) {
      result = {
        ok: false,
        kind: "unreachable",
        message: error instanceof Error ? error.message : String(error),
        entries: [],
      }
    }

    if (this.#disposed || token !== this.#token || input.generation !== this.#generation) {
      return { ok: result.ok, kind: "cancelled", committed: false }
    }
    if (!result.ok) {
      await this.#onFailure({
        generation: input.generation,
        kind: result.kind,
        message: result.message,
        hadCatalog: this.#record !== undefined,
      })
      return { ok: false, kind: result.kind, message: result.message, committed: false }
    }

    const record = await this.#commit(input.generation, result.entries, result.kind)
    return record
      ? { ok: true, kind: result.kind, record, committed: true }
      : { ok: false, kind: "cancelled", committed: false }
  }

  /**
   * Commit a directory read that was already performed elsewhere, such as the
   * verify-before-save step of an interactive connect.
   */
  async applyRead(input: {
    generation: number
    entries: readonly CatalogEntry[]
    kind?: VerifyKind
  }): Promise<CatalogRecord | undefined> {
    if (this.#disposed || !this.#identity || input.generation !== this.#generation) return undefined
    const kind = input.kind ?? (input.entries.length === 0 ? "empty" : "ok")
    return this.#commit(input.generation, input.entries, kind)
  }

  async #commit(
    generation: number,
    entries: readonly CatalogEntry[],
    kind: VerifyKind,
  ): Promise<CatalogRecord | undefined> {
    const identity = this.#identity
    if (!identity) return undefined
    const record = mergeCatalog({
      previous: this.#record,
      entries,
      baseURL: identity.baseURL,
      modelsURL: identity.modelsURL,
      fingerprint: identity.fingerprint,
      now: this.#now(),
      ...(this.#staleTtlMs !== undefined ? { staleTtlMs: this.#staleTtlMs } : {}),
    })

    // The connection may have changed while the read was in flight; a stale
    // result is dropped before it can touch the cache or the provider.
    if (this.#disposed || this.#generation !== generation) return undefined
    this.#record = record
    try {
      await this.#store.save(record)
    } catch {
      // Losing the cache write is not worth failing a good live directory.
    }
    if (this.#disposed || this.#generation !== generation) return undefined
    await this.#onCommit({ generation, record, fromCache: false, kind })
    return record
  }

  #abortInflight(): void {
    this.#controller?.abort()
    this.#controller = undefined
  }

  /** Cancel any in-flight read and release the connection. */
  dispose(): void {
    this.#disposed = true
    this.#abortInflight()
    this.#identity = undefined
    this.#record = undefined
  }
}
