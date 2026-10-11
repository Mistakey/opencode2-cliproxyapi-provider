/**
 * TUI-side connection view.
 *
 * The TUI never contacts CPA and never reads server files: it asks the server
 * over RPC, renders what the snapshot says, and re-reads the snapshot instead
 * of trusting a possibly-missed event. This module holds no JSX so the
 * behaviour can be tested without a terminal.
 */

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
  readonly events: {
    on(name: "changed", handler: (event: RpcEvent) => void): () => void
    on(name: "stale", handler: (event: RpcEvent) => void): () => void
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
    `generation: ${snapshot.generation}`,
  ]
  if (snapshot.verifyMessage) lines.push(`detail: ${snapshot.verifyMessage}`)
  return lines.join("\n")
}

export interface ConnectionView {
  snapshot(): ConnectionSnapshot | undefined
  connected(): boolean
  lastError(): string | undefined
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
  let connected = false
  let lastError: string | undefined

  const notify = () => input.onUpdate?.()

  const refresh = async (): Promise<void> => {
    try {
      const parsed = parseSnapshot(await input.rpc.status({}))
      if (parsed && matchesLocation({ location: { directory: parsed.location } }, input.directory)) {
        snapshot = parsed
      }
      connected = true
      lastError = undefined
    } catch (error) {
      // Keep the last snapshot but mark the RPC link as down: the next refresh
      // re-reads the authoritative state rather than replaying missed events.
      connected = false
      lastError = error instanceof Error ? error.message : String(error)
    }
    notify()
  }

  const applyReport = (report: ConnectionReport | undefined): ConnectionReport => {
    if (report?.snapshot) snapshot = report.snapshot
    connected = true
    lastError = undefined
    notify()
    return report ?? { ok: false, kind: "unreachable", message: "the server returned an unexpected response" }
  }

  return {
    snapshot: () => snapshot,
    connected: () => connected,
    lastError: () => lastError,
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
      return () => {
        stopChanged()
        stopStale()
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
  }
}

/** Verify kinds that mean "saved but not verified", for callers that format them. */
export const FAILED_VERIFY_KINDS: readonly VerifyKind[] = ["auth", "unreachable", "format", "address"]
