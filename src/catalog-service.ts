/**
 * Directory refresh engine for one connection.
 *
 * The service owns the active connection identity, the cached directory and a
 * read token. Every asynchronous read is checked against the token and the
 * connection generation before it may commit, so a slow refresh from a
 * connection the user already replaced (or a plugin that was unloaded) can
 * never overwrite the newer state, and a superseded read is dropped.
 *
 * Commits are applied one at a time in the order they were issued: the record,
 * its best-effort cache write and the publish callback are a single ordered
 * step. That ordering is what removes the need for a repair write or a
 * republish loop — a newer commit simply runs after the older one and leaves
 * the newest state in the cache and in the runtime.
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
  /**
   * Simple timed recovery after a stale or failed read, matching the official
   * plugin: a 60s first delay, 1.5x growth and a 300s ceiling. The timer hooks
   * are injectable so a test can control the clock.
   */
  readonly recovery?: {
    readonly baseDelayMs?: number
    readonly maxDelayMs?: number
    readonly setTimer?: (callback: () => void, delayMs: number) => unknown
    readonly clearTimer?: (handle: unknown) => void
  }
}

/** First delay before a stale or failed directory read is retried. */
export const DEFAULT_RECOVERY_DELAY_MS = 60_000
/** Ceiling for the recovery delay. */
export const MAX_RECOVERY_DELAY_MS = 300_000

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
  readonly #recoveryBaseMs: number
  readonly #recoveryMaxMs: number
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimer: (handle: unknown) => void

  #identity: CatalogIdentity | undefined
  #generation = 0
  #record: CatalogRecord | undefined
  #token = 0
  #controller: AbortController | undefined
  #disposed = false
  #recoveryTimer: unknown
  #recoveryAttempt = 0
  /** Commits run in issue order; the chain is the only serialization needed. */
  #commitChain: Promise<unknown> = Promise.resolve()

  constructor(input: CatalogServiceInput) {
    this.#store = input.store
    this.#read = input.read
    this.#onCommit = input.onCommit
    this.#onFailure = input.onFailure
    this.#now = input.now ?? Date.now
    this.#staleTtlMs = input.staleTtlMs
    this.#recoveryBaseMs = input.recovery?.baseDelayMs ?? DEFAULT_RECOVERY_DELAY_MS
    this.#recoveryMaxMs = input.recovery?.maxDelayMs ?? MAX_RECOVERY_DELAY_MS
    this.#setTimer =
      input.recovery?.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer =
      input.recovery?.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
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
    // A different connection has no schedule to keep.
    this.#clearRecovery()
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

    // A new read supersedes any pending recovery; the outcome below decides
    // whether another one is scheduled.
    this.#clearRecoveryTimer()

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

    if (!this.#isCurrent(input.generation, identity, token)) {
      return { ok: result.ok, kind: "cancelled", committed: false }
    }
    if (!result.ok) {
      await this.#onFailure({
        generation: input.generation,
        kind: result.kind,
        message: result.message,
        hadCatalog: this.#record !== undefined,
      })
      // A failed read is retried on the simple backoff. The very first boot read
      // (mode "initial") is not retried, matching the reference plugin.
      if (input.mode !== "initial") this.#scheduleRecovery()
      return { ok: false, kind: result.kind, message: result.message, committed: false }
    }

    const record = await this.#enqueue(() =>
      this.#commit(input.generation, identity, token, result.entries, result.kind),
    )
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
    const identity = this.#identity
    if (this.#disposed || !identity || input.generation !== this.#generation) return undefined
    const kind = input.kind ?? (input.entries.length === 0 ? "empty" : "ok")
    const token = this.#token
    return this.#enqueue(() => this.#commit(input.generation, identity, token, input.entries, kind))
  }

  /**
   * Re-derive the provider binding from the current directory under the same
   * ordered path as a refresh, so a Fast toggle cannot apply an older record
   * after a newer directory already committed.
   */
  async rebind<T>(task: (record: CatalogRecord) => Promise<T>): Promise<T | undefined> {
    const identity = this.#identity
    if (this.#disposed || !identity) return undefined
    const generation = this.#generation
    return this.#enqueue(async () => {
      const record = this.#record
      if (this.#disposed || !record || this.#generation !== generation || this.#identity !== identity) {
        return undefined
      }
      return task(record)
    })
  }

  async #commit(
    generation: number,
    identity: CatalogIdentity,
    token: number,
    entries: readonly CatalogEntry[],
    kind: VerifyKind,
  ): Promise<CatalogRecord | undefined> {
    if (!this.#isCurrent(generation, identity, token)) return undefined
    const record = mergeCatalog({
      previous: this.#record,
      entries,
      baseURL: identity.baseURL,
      modelsURL: identity.modelsURL,
      fingerprint: identity.fingerprint,
      now: this.#now(),
      ...(this.#staleTtlMs !== undefined ? { staleTtlMs: this.#staleTtlMs } : {}),
    })
    this.#record = record
    try {
      await this.#store.save(record)
    } catch {
      // Losing the cache write is not worth failing a good live directory.
    }
    // A newer read issued during the cache write owns the served record; the
    // queued newer commit writes the cache and publishes after this one.
    if (!this.#isCurrent(generation, identity, token)) return undefined
    await this.#onCommit({ generation, record, fromCache: false, kind })
    // A directory that still retains missing models keeps trying to recover
    // them; a fully fresh directory clears the schedule.
    if (record.models.some((state) => state.stale)) this.#scheduleRecovery()
    else this.#clearRecovery()
    return record
  }

  /**
   * Arrange one recovery read after the official delay. The timer only clears
   * itself and reads through the same generation guard, so a switch or unload
   * cannot let an old schedule act.
   */
  #scheduleRecovery(): void {
    if (this.#disposed || !this.#identity) return
    this.#clearRecoveryTimer()
    const delay = Math.min(this.#recoveryBaseMs * 1.5 ** this.#recoveryAttempt, this.#recoveryMaxMs)
    this.#recoveryAttempt += 1
    const generation = this.#generation
    const handle = this.#setTimer(() => {
      this.#recoveryTimer = undefined
      if (this.#disposed || this.#generation !== generation) return
      void this.refresh({ generation, mode: "background" }).catch(() => undefined)
    }, delay)
    // Never hold the host process open for a pending retry.
    ;(handle as { unref?: () => void } | undefined)?.unref?.()
    this.#recoveryTimer = handle
  }

  #clearRecoveryTimer(): void {
    if (this.#recoveryTimer !== undefined) {
      this.#clearTimer(this.#recoveryTimer)
      this.#recoveryTimer = undefined
    }
  }

  /** A successful fresh read clears the schedule and the backoff counter. */
  #clearRecovery(): void {
    this.#clearRecoveryTimer()
    this.#recoveryAttempt = 0
  }

  /** Whether this read is still the active connection's latest issued one. */
  #isCurrent(generation: number, identity: CatalogIdentity, token: number): boolean {
    return (
      !this.#disposed &&
      this.#generation === generation &&
      this.#identity === identity &&
      token === this.#token
    )
  }

  /** Run one commit at a time, in the order the commits were issued. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#commitChain.then(task, task)
    this.#commitChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #abortInflight(): void {
    this.#controller?.abort()
    this.#controller = undefined
  }

  /** Cancel any in-flight read and release the connection. */
  dispose(): void {
    this.#disposed = true
    this.#abortInflight()
    this.#clearRecovery()
    this.#identity = undefined
    this.#record = undefined
  }
}
