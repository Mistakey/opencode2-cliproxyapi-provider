/**
 * Transport policy for the CPA provider.
 *
 * The directory is the primary capability source, but OpenCode v2 selects a
 * transport per provider, not per model, and only some runtime packages can
 * carry a WebSocket at all. This module turns the directory's WebSocket
 * preference plus the explicit preference into one decision: which transport to
 * ask the host for, and which runtime package can actually carry it.
 *
 * The capability facts below were established against OpenCode 2.0.26 by
 * loading both packages into the real host against a loopback CPA that accepts
 * WebSocket upgrades (see `scripts/host-transport.mjs`): the OpenAI-compatible
 * Responses route is HTTP-only and silently falls back, while the native OpenAI
 * Responses route opens the socket.
 */

import type { CatalogEntry } from "./catalog"

/** Runtime package whose Responses route has no WebSocket channel. */
export const HTTP_RUNTIME_PACKAGE = "@opencode/ai/providers/openai-compatible/responses"
/** Runtime package whose Responses route carries the WebSocket channel. */
export const WEBSOCKET_RUNTIME_PACKAGE = "@opencode/ai/providers/openai/responses"

export const TRANSPORT_VALUES = ["auto", "http", "websocket"] as const
export type TransportPreference = (typeof TRANSPORT_VALUES)[number]
export type EffectiveTransport = "http" | "websocket"
/** Why the effective transport was chosen. */
export type TransportSource = "option" | "directory" | "default"

/** Compaction mechanisms OpenCode v2 understands. */
export const COMPACTION_VALUES = ["summary", "native"] as const
export type CompactionPreference = (typeof COMPACTION_VALUES)[number]
export type EffectiveCompaction = "summary" | "native"

const WEBSOCKET_CAPABLE = new Set([WEBSOCKET_RUNTIME_PACKAGE])
const HTTP_ONLY = new Set([HTTP_RUNTIME_PACKAGE])

export interface TransportPolicy {
  /** What the user asked for. */
  readonly preference: TransportPreference
  /** What the plugin asks the host for. */
  readonly transport: EffectiveTransport
  /** Runtime package that must carry the effective transport. */
  readonly package: string
  readonly source: TransportSource
  /** The directory declared `prefer_websockets` for at least one visible model. */
  readonly directoryPrefersWebSocket: boolean
  /** Human-readable diagnostic when the request and the runtime capability differ. */
  readonly note?: string
}

export interface CompactionPolicy {
  readonly preference: CompactionPreference
  /** What the provider declares; summary is the default and the mandatory path. */
  readonly type: EffectiveCompaction
  /** Set when native was requested but the runtime package cannot carry it. */
  readonly note?: string
}

export interface PreferenceResult<Value> {
  readonly preference: Value
  /** Set when the configured value is not one of the accepted values. */
  readonly invalid?: string
}

/** Read the `transport` option, refusing anything outside the accepted values. */
export function readTransportPreference(
  options: Record<string, unknown> | undefined,
): PreferenceResult<TransportPreference> {
  const raw = options?.transport
  if (raw === undefined) return { preference: "auto" }
  if (typeof raw === "string" && (TRANSPORT_VALUES as readonly string[]).includes(raw)) {
    return { preference: raw as TransportPreference }
  }
  return {
    preference: "auto",
    invalid: `transport must be one of ${TRANSPORT_VALUES.join(", ")}; got ${JSON.stringify(raw)}`,
  }
}

/** Read the `compaction` option, refusing anything outside the accepted values. */
export function readCompactionPreference(
  options: Record<string, unknown> | undefined,
): PreferenceResult<CompactionPreference> {
  const raw = options?.compaction
  if (raw === undefined) return { preference: "summary" }
  if (typeof raw === "string" && (COMPACTION_VALUES as readonly string[]).includes(raw)) {
    return { preference: raw as CompactionPreference }
  }
  return {
    preference: "summary",
    invalid: `compaction must be one of ${COMPACTION_VALUES.join(", ")}; got ${JSON.stringify(raw)}`,
  }
}

/**
 * Decide the compaction mechanism.
 *
 * Summary is the default and the mandatory path. Native is opt-in and only
 * declared when the runtime package actually exposes a compaction endpoint;
 * asking for it against a package that has none keeps summary and says why,
 * instead of pretending native is active.
 */
export function planCompaction(input: {
  preference: CompactionPreference
  package: string
  invalidPreference?: string
}): CompactionPolicy {
  const notes: string[] = []
  if (input.invalidPreference) notes.push(`${input.invalidPreference}; keeping summary`)
  if (input.preference !== "native") {
    return { preference: "summary", type: "summary", ...(notes.length > 0 ? { note: notes.join("; ") } : {}) }
  }
  if (WEBSOCKET_CAPABLE.has(input.package)) {
    return { preference: "native", type: "native", ...(notes.length > 0 ? { note: notes.join("; ") } : {}) }
  }
  notes.push(`${input.package} exposes no compaction endpoint; native compaction is unavailable, summary stays in effect`)
  return { preference: "native", type: "summary", note: notes.join("; ") }
}

/**
 * The directory prefers WebSocket when a visible model declares it. Hidden
 * entries are ignored: they are not selectable, so they must not decide the
 * transport of the models that are.
 */
export function directoryPrefersWebSocket(entries: readonly CatalogEntry[]): boolean {
  return entries.some((entry) => entry.preferWebsockets === true && entry.hidden !== true)
}

/**
 * Decide the effective transport and the runtime package.
 *
 * `auto` only selects WebSocket when both the directory asks for it and the
 * chosen package is known to carry a WebSocket channel; correctness wins over
 * an unverified route. A forced `websocket` is kept even when the package is
 * known to be HTTP-only, because the host reports that mismatch itself, and the
 * policy carries the diagnostic instead of hiding it.
 */
export function planTransport(input: {
  preference: TransportPreference
  directoryPrefersWebSocket: boolean
  httpPackage: string
  websocketPackage: string
  invalidPreference?: string
}): TransportPolicy {
  const { preference, directoryPrefersWebSocket, httpPackage, websocketPackage } = input
  const notes: string[] = []
  if (input.invalidPreference) notes.push(`${input.invalidPreference}; falling back to auto`)

  const websocketRequested = preference === "websocket" || (preference === "auto" && directoryPrefersWebSocket)
  const websocketConfirmed = WEBSOCKET_CAPABLE.has(websocketPackage)

  if (websocketRequested && (preference === "websocket" || websocketConfirmed)) {
    if (HTTP_ONLY.has(websocketPackage)) {
      notes.push(
        `${websocketPackage} has no WebSocket channel; the host will fall back to HTTP/SSE. ` +
          `Set websocketPackage to ${WEBSOCKET_RUNTIME_PACKAGE} to use WebSocket.`,
      )
    } else if (!websocketConfirmed) {
      notes.push(`cannot confirm that ${websocketPackage} carries a WebSocket channel`)
    }
    return {
      preference,
      transport: "websocket",
      package: websocketPackage,
      source: preference === "websocket" ? "option" : "directory",
      directoryPrefersWebSocket,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    }
  }

  if (websocketRequested) {
    notes.push(
      `the directory prefers WebSocket but ${websocketPackage} is not a confirmed WebSocket runtime; using HTTP/SSE`,
    )
  }
  return {
    preference,
    transport: "http",
    package: httpPackage,
    source: preference === "http" ? "option" : "default",
    directoryPrefersWebSocket,
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  }
}
