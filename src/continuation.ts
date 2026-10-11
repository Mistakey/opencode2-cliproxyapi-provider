/**
 * Server-side continuation state after a summary.
 *
 * OpenCode keeps one socket per session and the native Responses runtime
 * continues with `previous_response_id`, so CPA keeps the pre-summary
 * conversation in its own connection state. Sending the compacted transcript
 * does not clear that state: when the request has no `previous_response_id` but
 * also no assistant or function_call item, CPA forwards it against the last
 * response id, and the model still sees the old history. That defeats the
 * summary OpenCode just produced.
 *
 * The public fix is the WebSocket handshake hook: changing a handshake header
 * makes the host reopen the socket, so the next request starts against a fresh
 * server state and CPA treats the compacted transcript as a new conversation.
 * The id below only changes once per summary, so ordinary turns keep reusing
 * their socket.
 */

/** Handshake header carrying the socket generation. Plugin-owned; CPA ignores it. */
export const SOCKET_HEADER = "x-oc2cpa-socket"

export class ContinuationReset {
  readonly #generations = new Map<string, number>()
  readonly #compacted = new Set<string>()

  /** A summary replaced this session's transcript; the next socket must be fresh. */
  markCompacted(sessionID: string): void {
    this.#compacted.add(sessionID)
  }

  /** Socket generation for this handshake; it increments once after a summary. */
  socketGeneration(sessionID: string): string {
    let generation = this.#generations.get(sessionID) ?? 0
    if (this.#compacted.delete(sessionID)) {
      generation += 1
      this.#generations.set(sessionID, generation)
    }
    return String(generation)
  }

  forget(sessionID: string): void {
    this.#compacted.delete(sessionID)
  }
}
