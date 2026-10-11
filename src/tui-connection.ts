/**
 * TUI-side connection view.
 *
 * The TUI never contacts CPA and never reads server files: it asks the server
 * over RPC, renders what the snapshot says, and re-reads the snapshot instead
 * of trusting a possibly-missed event. This module holds no JSX so the
 * behaviour can be tested without a terminal.
 */

import type { PauseState } from "./pause"
import type { SessionStats, TokenCounts, TurnStats } from "./stats"
import type { ConnectionSnapshot, VerifyKind } from "./state"

/** Event payload the server pushes; `data` carries the event's own fields. */
export interface RpcEvent {
  readonly location?: { directory?: string } | undefined
  readonly data?: unknown
}

/** The subset of the CPA RPC client this view uses. */
export interface ConnectionRpc {
  readonly status: (input?: unknown) => Promise<unknown>
  readonly verify: (input: { address: string; key?: string }) => Promise<unknown>
  readonly connect: (input: { address: string; key: string }) => Promise<unknown>
  readonly refresh: (input?: unknown) => Promise<unknown>
  readonly setFast: (input: { enabled: boolean }) => Promise<unknown>
  readonly pause: (input?: unknown) => Promise<unknown>
  readonly resume: (input?: unknown) => Promise<unknown>
  readonly pauseState: (input?: unknown) => Promise<unknown>
  readonly stats: (input: { sessionID: string }) => Promise<unknown>
  readonly events: {
    readonly on: (name: "changed" | "stale" | "pause.changed" | "stats.changed", handler: (event: RpcEvent) => void) => () => void
  }
}

export interface ConnectionReport {
  readonly ok: boolean
  /** Present on verify/connect results; a Fast toggle reports no kind. */
  readonly kind?: string
  readonly message?: string
  readonly models?: number
  readonly snapshot?: ConnectionSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Narrow an RPC result to a snapshot; an unexpected shape is ignored, not trusted. */
export function parseSnapshot(value: unknown): ConnectionSnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.location !== "string" || typeof value.providerID !== "string") return undefined
  if (typeof value.integrationID !== "string" || typeof value.keyHint !== "string") return undefined
  if (typeof value.keySaved !== "boolean") return undefined
  if (value.verified !== "unknown" && value.verified !== "ok" && value.verified !== "failed") return undefined
  return value as unknown as ConnectionSnapshot
}

export function parseReport(value: unknown): ConnectionReport | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.ok !== "boolean") return undefined
  return value as unknown as ConnectionReport
}

/** Narrow an RPC result to a pause state. */
export function parsePauseState(value: unknown): PauseState | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.paused !== "boolean" || !isFiniteNumber(value.changedAt)) return undefined
  if (!isFiniteNumber(value.waiting)) return undefined
  if (value.scope !== "location") return undefined
  return value as unknown as PauseState
}

function parseTokens(value: unknown): TokenCounts | undefined {
  if (!isRecord(value)) return undefined
  const keys = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"] as const
  for (const key of keys) {
    if (!isFiniteNumber(value[key])) return undefined
  }
  return value as unknown as TokenCounts
}

function parseTurn(value: unknown): TurnStats | undefined {
  if (!isRecord(value)) return undefined
  if (!isFiniteNumber(value.startedAt) || !isFiniteNumber(value.durationMs)) return undefined
  if (!isFiniteNumber(value.pausedMs) || !isFiniteNumber(value.effectiveMs)) return undefined
  if (!isFiniteNumber(value.steps) || !isFiniteNumber(value.retries)) return undefined
  const tokens = parseTokens(value.tokens)
  if (!tokens) return undefined
  if (value.tps !== undefined && !isFiniteNumber(value.tps)) return undefined
  if (value.endedAt !== undefined && !isFiniteNumber(value.endedAt)) return undefined
  return value as unknown as TurnStats
}

/** Narrow an RPC result to session stats. */
export function parseStats(value: unknown): SessionStats | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.sessionID !== "string" || typeof value.running !== "boolean") return undefined
  if (!isFiniteNumber(value.turns) || !isFiniteNumber(value.steps) || !isFiniteNumber(value.retries)) return undefined
  if (!isFiniteNumber(value.effectiveMs)) return undefined
  const tokens = parseTokens(value.tokens)
  if (!tokens) return undefined
  if (value.parentID !== undefined && typeof value.parentID !== "string") return undefined
  const lastTurn = value.lastTurn === undefined ? undefined : parseTurn(value.lastTurn)
  if (value.lastTurn !== undefined && !lastTurn) return undefined
  return { ...(value as unknown as SessionStats), tokens, ...(lastTurn ? { lastTurn } : {}) }
}

/** Model id carried by a `stale` event, when it is shaped as expected. */
export function parseStaleModelID(event: RpcEvent): string | undefined {
  const data = event.data
  if (!isRecord(data)) return undefined
  const modelID = data.modelID
  return typeof modelID === "string" && modelID ? modelID : undefined
}

/** Events arrive from every location; only this location's state is rendered. */
export function matchesLocation(
  event: { location?: { directory?: string } | undefined } | undefined,
  directory: string | undefined,
): boolean {
  if (directory === undefined || directory === "") return true
  return event?.location?.directory === directory
}

function formatTime(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "(never)"
  return new Date(value).toISOString()
}

/** Short footer text; "saved" and "verified" are deliberately different states. */
export function describeConnection(snapshot: ConnectionSnapshot | undefined, connected: boolean): string {
  if (!connected) return "CPA offline"
  if (!snapshot) return "CPA not configured"
  const models = snapshot.catalogModels
  let connection: string
  if (snapshot.verified === "failed") {
    // A failed refresh keeps the last good models; show both facts.
    connection = models !== undefined && models > 0 ? `CPA ${models} models · ${snapshot.verifyKind ?? "error"}` : `CPA ${snapshot.verifyKind ?? "failed"}`
  } else if (snapshot.verified === "ok") {
    if (models === 0) {
      connection = "CPA empty"
    } else {
      const stale = snapshot.catalogStaleModels ?? 0
      const staleText = stale > 0 ? ` · ${stale} stale` : ""
      const cachedText = snapshot.catalogFromCache ? " (cached)" : ""
      connection = `CPA ${models ?? "?"} models${staleText}${cachedText}`
    }
  } else {
    connection = snapshot.keySaved ? "CPA saved" : "CPA not configured"
  }
  return `${connection} · ${describeFast(snapshot)}`
}

/** The Fast preference and its effect are different states and are shown as such. */
export function describeFast(snapshot: ConnectionSnapshot): string {
  if (!snapshot.fastEnabled) return "Fast off"
  return snapshot.fastEffectiveModels > 0 ? `Fast on (${snapshot.fastEffectiveModels})` : "Fast on (no capable model)"
}

/** Longer text for the status dialog, still free of key material. */
export function describeDetail(
  snapshot: ConnectionSnapshot | undefined,
  connected: boolean,
  lastError: string | undefined,
  pause?: PauseState | undefined,
): string {
  if (!connected) return `CPA server unreachable over RPC${lastError ? `: ${lastError}` : ""}`
  if (!snapshot) return "CPA is not configured at this location"
  const lines = [
    `address: ${snapshot.address ?? "(none)"} (from ${snapshot.addressSource ?? "unknown"})`,
    `key: ${snapshot.keyHint} (from ${snapshot.keySource ?? "unknown"})`,
    `saved: ${snapshot.keySaved ? "yes" : "no"}`,
    `verified: ${snapshot.verified === "failed" && snapshot.verifyKind ? `failed (${snapshot.verifyKind})` : snapshot.verified}`,
    `models: ${snapshot.catalogModels ?? "(unknown)"}`,
    `last refresh: ${formatTime(snapshot.catalogFetchedAt)}${snapshot.catalogFromCache ? " (from cache)" : ""}`,
    `stale: ${snapshot.catalogStaleModels ?? 0}${snapshot.catalogStaleIds?.length ? ` (${snapshot.catalogStaleIds.join(", ")})` : ""}`,
    `fast: ${snapshot.fastEnabled ? "on" : "off"} (effective on ${snapshot.fastEffectiveModels} model(s))`,
    `prices: models.dev estimate for ${snapshot.costModels ?? 0} model(s), not a CPA bill`,
    `requests: ${describePause(pause)}`,
    `generation: ${snapshot.generation}`,
  ]
  if (snapshot.verifyMessage) lines.push(`detail: ${snapshot.verifyMessage}`)
  return lines.join("\n")
}

/** One short phrase for the pause state. */
export function describePause(pause: PauseState | undefined): string {
  if (!pause) return "unknown"
  if (!pause.paused) return "running"
  return pause.waiting > 0 ? `paused (${pause.waiting} waiting)` : "paused"
}

/** Group thousands without depending on the host locale. */
function group(value: number): string {
  const rounded = Math.round(value)
  const sign = rounded < 0 ? "-" : ""
  const digits = Math.abs(rounded).toString()
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`
}

export function formatTokens(tokens: TokenCounts): string {
  return (
    `in ${group(tokens.input)} · out ${group(tokens.output)} · reasoning ${group(tokens.reasoning)} · ` +
    `cache ${group(tokens.cacheRead)}/${group(tokens.cacheWrite)} · total ${group(tokens.total)}`
  )
}

export function formatTps(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps)) return "n/a"
  return `${tps.toFixed(1)} tok/s`
}

/** The turn summary the main session shows: effective duration and whole-turn TPS. */
export function describeTurn(stats: SessionStats | undefined): string | undefined {
  const turn = stats?.lastTurn
  if (!turn) return undefined
  const window = `${formatDuration(turn.effectiveMs)} · ${formatTps(turn.tps)}`
  return stats?.running ? `${window} (running)` : window
}

/** The prompt-footer suffix: connection, pause state and the last turn. */
export function describeFooter(
  snapshot: ConnectionSnapshot | undefined,
  connected: boolean,
  pause: PauseState | undefined,
  stats: SessionStats | undefined,
): string {
  const parts = [describeConnection(snapshot, connected)]
  if (pause?.paused) parts.push("paused")
  const turn = describeTurn(stats)
  if (turn) parts.push(turn)
  return parts.join(" · ")
}

/** Multi-line stats for the `/cpa-stats` dialog. */
export function describeStats(stats: SessionStats | undefined): string {
  if (!stats) return "No CPA model calls have been observed for this session yet."
  const lines = [
    `session: ${stats.sessionID}${stats.parentID ? ` (child of ${stats.parentID})` : ""}`,
    `turns: ${stats.turns}${stats.running ? " (one running)" : ""}`,
    `steps: ${stats.steps} · retries: ${stats.retries}`,
    `effective total: ${formatDuration(stats.effectiveMs)}`,
    `tokens (session): ${formatTokens(stats.tokens)}`,
  ]
  const turn = stats.lastTurn
  if (turn) {
    lines.push(
      `last turn: ${formatDuration(turn.effectiveMs)} effective ` +
        `(${formatDuration(turn.durationMs)} wall, ${formatDuration(turn.pausedMs)} paused) · ${formatTps(turn.tps)}`,
    )
    lines.push(`last turn steps: ${turn.steps} · retries: ${turn.retries}`)
    lines.push(`tokens (last turn): ${formatTokens(turn.tokens)}`)
  }
  return lines.join("\n")
}

export interface ConnectionView {
  snapshot(): ConnectionSnapshot | undefined
  connected(): boolean
  lastError(): string | undefined
  pause(): PauseState | undefined
  /** Cached stats; the first read schedules a refresh and later reads reuse it. */
  stats(sessionID: string | undefined): SessionStats | undefined
  /** Force a fresh stats read for one session. */
  reloadStats(sessionID: string | undefined): Promise<void>
  /** Re-read the authoritative snapshot. Safe to call after a reconnect. */
  refresh(): Promise<void>
  /** Ask the server to read the directory again, bypassing the cache. */
  refreshCatalog(): Promise<ConnectionReport>
  /** Subscribe to server pushes; returns the unsubscribe function. */
  subscribe(): () => void
  verify(address: string, key?: string): Promise<ConnectionReport>
  connect(address: string, key: string): Promise<ConnectionReport>
  /** Persist the Fast preference and reload the location so it reaches the wire. */
  setFast(enabled: boolean): Promise<ConnectionReport>
  pauseRequests(): Promise<PauseState | undefined>
  resumeRequests(): Promise<PauseState | undefined>
}

export function createConnectionView(input: {
  rpc: ConnectionRpc
  directory?: string
  /** Reloads the location so a persisted preference is recompiled. */
  reload?: () => Promise<void>
  onUpdate?: () => void
  /** Called when a request selects a model the server still serves from cache. */
  onStale?: (modelID: string) => void
}): ConnectionView {
  let snapshot: ConnectionSnapshot | undefined
  let pauseState: PauseState | undefined
  let connected = false
  let lastError: string | undefined
  const statsCache = new Map<string, SessionStats>()
  const statsPending = new Set<string>()
  // Read-through reads are attempted once per session id, so a down RPC cannot
  // turn a render into an endless refresh loop.
  const statsAttempted = new Set<string>()

  const notify = () => input.onUpdate?.()

  const refresh = async (): Promise<void> => {
    const wasConnected = connected
    try {
      const parsed = parseSnapshot(await input.rpc.status({}))
      if (parsed && matchesLocation({ location: { directory: parsed.location } }, input.directory)) {
        snapshot = parsed
      }
      const nextPause = parsePauseState(await input.rpc.pauseState({}))
      if (nextPause) pauseState = nextPause
      connected = true
      lastError = undefined
      if (!wasConnected && statsCache.size > 0) {
        // A reconnect re-reads the authoritative stats instead of trusting a
        // cache filled before the link dropped.
        for (const sessionID of [...statsCache.keys()]) {
          statsAttempted.delete(sessionID)
          void refreshStats(sessionID)
        }
      }
    } catch (error) {
      // Keep the last snapshot but mark the RPC link as down: the next refresh
      // re-reads the authoritative state rather than replaying missed events.
      connected = false
      lastError = error instanceof Error ? error.message : String(error)
    }
    notify()
  }

  const refreshStats = async (sessionID: string): Promise<void> => {
    if (statsPending.has(sessionID)) return
    statsPending.add(sessionID)
    statsAttempted.add(sessionID)
    try {
      const response = await input.rpc.stats({ sessionID })
      const parsed = isRecord(response) ? parseStats(response.stats) : undefined
      if (parsed) statsCache.set(sessionID, parsed)
      connected = true
      lastError = undefined
    } catch (error) {
      connected = false
      lastError = error instanceof Error ? error.message : String(error)
    }
    statsPending.delete(sessionID)
    notify()
  }

  const applyReport = (report: ConnectionReport | undefined): ConnectionReport => {
    if (report?.snapshot) snapshot = report.snapshot
    connected = true
    lastError = undefined
    notify()
    return report ?? { ok: false, kind: "unreachable", message: "the server returned an unexpected response" }
  }

  const applyPauseResult = async (call: Promise<unknown>): Promise<PauseState | undefined> => {
    try {
      const next = parsePauseState(await call)
      if (next) pauseState = next
      connected = true
      lastError = undefined
      notify()
      return next
    } catch (error) {
      connected = false
      lastError = error instanceof Error ? error.message : String(error)
      notify()
      return undefined
    }
  }

  return {
    snapshot: () => snapshot,
    connected: () => connected,
    lastError: () => lastError,
    pause: () => pauseState,
    stats: (sessionID) => {
      if (!sessionID) return undefined
      const cached = statsCache.get(sessionID)
      if (cached) return cached
      if (!statsAttempted.has(sessionID)) void refreshStats(sessionID)
      return undefined
    },
    reloadStats: async (sessionID) => {
      if (sessionID) await refreshStats(sessionID)
    },
    refresh,
    refreshCatalog: async () => applyReport(parseReport(await input.rpc.refresh({}))),
    subscribe: () => {
      const stopChanged = input.rpc.events.on("changed", (event) => {
        if (!matchesLocation(event, input.directory)) return
        void refresh()
      })
      const stopStale = input.rpc.events.on("stale", (event) => {
        if (!matchesLocation(event, input.directory)) return
        const modelID = parseStaleModelID(event)
        if (modelID) input.onStale?.(modelID)
      })
      const stopPause = input.rpc.events.on("pause.changed", (event) => {
        if (!matchesLocation(event, input.directory)) return
        const next = parsePauseState(event.data)
        if (next) {
          pauseState = next
          notify()
        }
      })
      const stopStats = input.rpc.events.on("stats.changed", (event) => {
        if (!matchesLocation(event, input.directory)) return
        const next = parseStats(event.data)
        if (next) {
          statsCache.set(next.sessionID, next)
          notify()
        }
      })
      return () => {
        stopChanged()
        stopStale()
        stopPause()
        stopStats()
      }
    },
    verify: async (address, key) => {
      const report = parseReport(await input.rpc.verify(key === undefined ? { address } : { address, key }))
      return applyReport(report)
    },
    connect: async (address, key) => applyReport(parseReport(await input.rpc.connect({ address, key }))),
    setFast: async (enabled) => {
      const report = parseReport(await input.rpc.setFast({ enabled }))
      // The host compiles the provider registry when the location boots, so the
      // persisted preference only reaches the wire after this reload. A reload
      // failure is not fatal: the preference is already stored and applies on
      // the next boot.
      try {
        await input.reload?.()
      } catch {
        // Reported through the refreshed snapshot instead of failing the toggle.
      }
      await refresh()
      return report ?? { ok: false, kind: "unreachable", message: "the server returned an unexpected response" }
    },
    pauseRequests: () => applyPauseResult(input.rpc.pause({})),
    resumeRequests: () => applyPauseResult(input.rpc.resume({})),
  }
}

/** Verify kinds that mean "saved but not verified", for callers that format them. */
export const FAILED_VERIFY_KINDS: readonly VerifyKind[] = ["auth", "unreachable", "format", "address"]
