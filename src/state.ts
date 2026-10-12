/**
 * Connection state for one plugin instance.
 *
 * One instance serves one location's CPA integration. It owns the last
 * verified connection facts so a status reader can tell "the credential is
 * saved" apart from "this connection answered a directory request", and it
 * carries a generation counter so a slow request from a connection the user
 * already replaced can never overwrite the newer state.
 *
 * Nothing here stores the API key: only its length, through `redactKey`.
 */

import { AddressError, resolveEndpoints } from "./address"
import { CatalogError, fetchCatalog, type CatalogEntry } from "./catalog"
import { redactKey, type ConfigSource } from "./connection"

/** Observable outcome of reading the CPA directory with one address/key pair. */
export type VerifyKind = "ok" | "empty" | "auth" | "unreachable" | "format" | "address"

export interface VerifyResult {
  readonly ok: boolean
  readonly kind: VerifyKind
  /** Human-readable detail; never contains the key. */
  readonly message?: string
  /** Directory entries, only when the read succeeded. */
  readonly entries: readonly CatalogEntry[]
}

export interface VerifyInput {
  readonly address: string
  readonly apiKey: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

/** Read the directory for one address/key pair without changing any state. */
export async function verifyConnection(input: VerifyInput): Promise<VerifyResult> {
  let endpoints
  try {
    endpoints = resolveEndpoints(input.address)
  } catch (error) {
    const detail = error instanceof AddressError ? error.message : String(error)
    return { ok: false, kind: "address", message: detail, entries: [] }
  }

  try {
    const entries = await fetchCatalog({
      modelsURL: endpoints.modelsURL,
      apiKey: input.apiKey,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    })
    return entries.length === 0
      ? { ok: true, kind: "empty", entries }
      : { ok: true, kind: "ok", entries }
  } catch (error) {
    if (error instanceof CatalogError) {
      if (error.kind === "format") return { ok: false, kind: "format", message: error.message, entries: [] }
      if (error.status === 401 || error.status === 403) {
        return { ok: false, kind: "auth", message: error.message, entries: [] }
      }
      return { ok: false, kind: "unreachable", message: error.message, entries: [] }
    }
    return { ok: false, kind: "unreachable", message: String(error), entries: [] }
  }
}

/** What a status reader can observe about the active CPA connection. */
export type ConnectionSnapshot = {
  /** Location directory this instance serves. */
  readonly location: string
  readonly providerID: string
  readonly integrationID: string
  /** Effective address, before normalization. */
  readonly address?: string
  readonly addressSource?: ConfigSource
  readonly keySource?: ConfigSource
  /** `redactKey` output: a length, never the key. */
  readonly keyHint: string
  /** A key is present in OpenCode's credential store. */
  readonly keySaved: boolean
  /** Whether that saved connection was verified against CPA. */
  readonly verified: "unknown" | "ok" | "failed"
  readonly verifyKind?: VerifyKind
  readonly verifyMessage?: string
  /** Model count from the last successful directory read; `undefined` when never verified. */
  readonly catalogModels?: number
  /** When the directory was last read successfully. */
  readonly catalogFetchedAt?: number
  /** Models retained from an earlier directory read but missing now. */
  readonly catalogStaleModels?: number
  /** Ids of the retained models, capped for snapshot size. */
  readonly catalogStaleIds?: readonly string[]
  /** Models currently come from a matching persisted cache, not a live read. */
  readonly catalogFromCache?: boolean
  /** Persisted Fast preference. */
  readonly fastEnabled: boolean
  /** Registered models that currently send the priority parameter. */
  readonly fastEffectiveModels: number
  /**
   * Whether the runtime has compiled the directory this snapshot describes.
   * The host compiles the provider registry at location boot, so a directory or
   * preference changed after boot is saved but not yet effective.
   */
  readonly applied?: boolean
  /**
   * Whether a newer saved directory or preference still needs a location reload
   * before the runtime dispatches it. A headless caller reads this flag, calls
   * the host's public location reload, and re-reads the snapshot to confirm.
   */
  readonly reloadRequired?: boolean
  /** Registered models whose price is a models.dev estimate. */
  readonly costModels?: number
  /** Effective transport asked of the host for this connection. */
  readonly transport?: "http" | "websocket"
  /** Why that transport was chosen. */
  readonly transportSource?: "option" | "directory" | "default"
  /** Whether the directory declared a WebSocket preference. */
  readonly directoryPrefersWebSocket?: boolean
  /** Diagnostic when the request and the runtime capability differ. */
  readonly transportNote?: string
  /** Compaction mechanism declared for this connection. */
  readonly compaction?: "summary" | "native"
  /** Diagnostic when native compaction was requested but is unavailable. */
  readonly compactionNote?: string
  /** Increments on every connection-changing attempt. */
  readonly generation: number
  readonly updatedAt: number
}

export interface ConnectionStateInput extends Omit<ConnectionSnapshot, "generation" | "updatedAt"> {
  readonly now?: () => number
}

/**
 * Mutable connection facts with a generation guard.
 *
 * `begin()` is called before an asynchronous connection change; `commit()` only
 * applies when its generation is still current, so a stale request is dropped
 * instead of overwriting the connection the user selected later.
 */
export class ConnectionState {
  readonly #now: () => number
  #generation = 0
  #snapshot: ConnectionSnapshot

  constructor(input: ConnectionStateInput) {
    this.#now = input.now ?? Date.now
    const { now: _now, ...initial } = input
    this.#snapshot = { ...initial, generation: 0, updatedAt: this.#now() }
  }

  get generation(): number {
    return this.#generation
  }

  /** Reserve the next generation for an asynchronous connection change. */
  begin(): number {
    this.#generation += 1
    return this.#generation
  }

  /** True when `generation` is still the current one. */
  isCurrent(generation: number): boolean {
    return generation === this.#generation
  }

  /** Apply an update unless a newer connection change already superseded it. */
  commit(generation: number, update: Partial<Omit<ConnectionSnapshot, "generation" | "updatedAt">>): boolean {
    if (!this.isCurrent(generation)) return false
    this.#apply(update)
    return true
  }

  /**
   * Apply a non-connection update (the Fast preference, price estimates). It is
   * not tied to the generation guard: it describes the active connection, not a
   * candidate one.
   */
  patch(update: ConnectionUpdate): void {
    this.#apply(update)
  }

  #apply(update: Partial<Omit<ConnectionSnapshot, "generation" | "updatedAt">>): void {
    // A field explicitly set to `undefined` clears the previous value and is left
    // out of the snapshot, so the RPC output never carries an `undefined` field.
    const next: Record<string, unknown> = { ...this.#snapshot }
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    next.generation = this.#generation
    next.updatedAt = this.#now()
    this.#snapshot = next as ConnectionSnapshot
  }

  read(): ConnectionSnapshot {
    return this.#snapshot
  }
}

/** Snapshot fields a caller may set when describing the active connection. */
export type ConnectionUpdate = Partial<Omit<ConnectionSnapshot, "generation" | "updatedAt">>

/** Describe a plan-derived connection without exposing the key. */
export function connectionUpdate(input: {
  address: string
  addressSource: ConfigSource
  keySource: ConfigSource
  key: string
  keySaved: boolean
  verified: ConnectionSnapshot["verified"]
  verifyKind?: VerifyKind
  verifyMessage?: string
  catalogModels?: number
}): ConnectionUpdate {
  return {
    address: input.address,
    addressSource: input.addressSource,
    keySource: input.keySource,
    keyHint: redactKey(input.key),
    keySaved: input.keySaved,
    verified: input.verified,
    // Always written, so a successful verify clears an earlier failure message.
    verifyKind: input.verifyKind,
    verifyMessage: input.verifyMessage,
    ...(input.catalogModels !== undefined ? { catalogModels: input.catalogModels } : {}),
  }
}
