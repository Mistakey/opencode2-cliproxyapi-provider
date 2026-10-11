/**
 * TUI-side connection view.
 *
 * The TUI never contacts CPA and never reads server files: it asks the server
 * over RPC, renders what the snapshot says, and re-reads the snapshot instead
 * of trusting a possibly-missed event. This module holds no JSX so the
 * behaviour can be tested without a terminal.
 */

import type { ConnectionSnapshot, VerifyKind } from "./state"

/** The subset of the CPA RPC client this view uses. */
export interface ConnectionRpc {
  readonly status: (input?: unknown) => Promise<unknown>
  readonly verify: (input: { address: string; key?: string }) => Promise<unknown>
  readonly connect: (input: { address: string; key: string }) => Promise<unknown>
  readonly events: {
    readonly on: (name: "changed", handler: (event: { location?: { directory?: string } | undefined }) => void) => () => void
  }
}

export interface ConnectionReport {
  readonly ok: boolean
  readonly kind: string
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
  if (typeof value.ok !== "boolean" || typeof value.kind !== "string") return undefined
  return value as unknown as ConnectionReport
}

/** Events arrive from every location; only this location's state is rendered. */
export function matchesLocation(
  event: { location?: { directory?: string } | undefined } | undefined,
  directory: string | undefined,
): boolean {
  if (directory === undefined || directory === "") return true
  return event?.location?.directory === directory
}

/** Short footer text; "saved" and "verified" are deliberately different states. */
export function describeConnection(snapshot: ConnectionSnapshot | undefined, connected: boolean): string {
  if (!connected) return "CPA offline"
  if (!snapshot) return "CPA not configured"
  if (snapshot.verified === "ok") {
    return snapshot.catalogModels === 0 ? "CPA empty" : `CPA ${snapshot.catalogModels ?? "?"} models`
  }
  if (snapshot.verified === "failed") return `CPA ${snapshot.verifyKind ?? "failed"}`
  return snapshot.keySaved ? "CPA saved" : "CPA not configured"
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
  /** Subscribe to server pushes; returns the unsubscribe function. */
  subscribe(): () => void
  verify(address: string, key?: string): Promise<ConnectionReport>
  connect(address: string, key: string): Promise<ConnectionReport>
}

export function createConnectionView(input: {
  rpc: ConnectionRpc
  directory?: string
  onUpdate?: () => void
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
    subscribe: () =>
      input.rpc.events.on("changed", (event) => {
        if (!matchesLocation(event, input.directory)) return
        void refresh()
      }),
    verify: async (address, key) => {
      const report = parseReport(await input.rpc.verify(key === undefined ? { address } : { address, key }))
      return applyReport(report)
    },
    connect: async (address, key) => applyReport(parseReport(await input.rpc.connect({ address, key }))),
  }
}

/** Verify kinds that mean "saved but not verified", for callers that format them. */
export const FAILED_VERIFY_KINDS: readonly VerifyKind[] = ["auth", "unreachable", "format", "address"]
