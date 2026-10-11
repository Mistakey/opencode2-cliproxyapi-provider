/**
 * Cancellable pause gate for CPA model requests.
 *
 * Pausing must stop the *next* CPA request without touching one already in
 * flight, and the wait must end when the session is cancelled or the plugin is
 * unloaded. So the gate is a plain promise per waiting model call: no polling,
 * no interval, and nothing to leak. `resume()` resolves the waits; a
 * `session.execution.interrupted` event drops the waits of the cancelled
 * session (the host interrupts the request fiber itself, so dropping the
 * resolver never sends the request); an unload (`location.shutdown` or the
 * plugin cleanup) rejects them, because a paused request must not be sent
 * without a resume.
 *
 * The gate is one instance per location, i.e. per plugin instance: a pause in
 * one location never touches another.
 */

/** Where a pause applies. One plugin instance serves one location. */
export type PauseScope = "location"

/** Observable pause state; never contains credentials. */
export type PauseState = {
  readonly paused: boolean
  readonly changedAt: number
  /** Model calls currently waiting for a resume. */
  readonly waiting: number
  readonly scope: PauseScope
}

export interface PauseGateOptions {
  readonly now?: () => number
  /** Called when a model call starts waiting, with the session it belongs to. */
  readonly onWaitStart?: (sessionID: string) => void
  /** Called when a wait stops, whether by resume, cancel or unload. */
  readonly onWaitEnd?: (sessionID: string) => void
}

/**
 * A held model call was cancelled because the plugin was unloaded or the
 * location was replaced. It is a rejection, not a resume: the request must not
 * be sent after the user paused it.
 */
export class PauseCancelledError extends Error {
  readonly reason = "unload"

  constructor() {
    super("CLIProxyAPI requests were paused and the plugin was unloaded before they were resumed")
    this.name = "PauseCancelledError"
  }
}

interface Waiter {
  readonly sessionID: string
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

export class PauseGate {
  readonly #now: () => number
  readonly #onWaitStart: ((sessionID: string) => void) | undefined
  readonly #onWaitEnd: ((sessionID: string) => void) | undefined
  #paused = false
  #closed = false
  #changedAt: number
  #next = 1
  readonly #waiters = new Map<number, Waiter>()

  constructor(options: PauseGateOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#onWaitStart = options.onWaitStart
    this.#onWaitEnd = options.onWaitEnd
    this.#changedAt = this.#now()
  }

  get paused(): boolean {
    return this.#paused
  }

  read(): PauseState {
    return {
      paused: this.#paused,
      changedAt: this.#changedAt,
      waiting: this.#waiters.size,
      scope: "location",
    }
  }

  /** Pause subsequent CPA requests. Requests already in flight are untouched. */
  pause(): PauseState {
    if (!this.#paused && !this.#closed) {
      this.#paused = true
      this.#changedAt = this.#now()
    }
    return this.read()
  }

  /** Release every wait and let the held requests continue. */
  resume(): PauseState {
    if (this.#paused) {
      this.#paused = false
      this.#changedAt = this.#now()
    }
    this.#settle("resume")
    return this.read()
  }

  /**
   * Wait for a resume when paused; resolve immediately when running.
   *
   * A resolved wait means "the request may be sent now". A rejected wait means
   * the request was cancelled by an unload and must not be sent. A dropped wait
   * (see `cancel`) settles nothing, because the host has already abandoned the
   * call.
   */
  wait(sessionID: string): Promise<void> {
    if (this.#closed || !this.#paused) return Promise.resolve()
    const id = this.#next
    this.#next += 1
    const promise = new Promise<void>((resolve, reject) => {
      this.#waiters.set(id, { sessionID, resolve, reject })
      this.#onWaitStart?.(sessionID)
    })
    // The host may abandon this call (a session cancel) before an unload
    // rejects it; keep that rejection from surfacing as an unhandled one.
    promise.catch(() => {})
    return promise
  }

  /**
   * The host ended this session's execution (interrupt/cancel). Stop tracking
   * its waits without resolving them: resolving could still send a request the
   * host has already cancelled.
   */
  cancel(sessionID: string): number {
    return this.#settle("cancel", sessionID)
  }

  /**
   * Unload: cancel every held wait, so a paused request is never sent after the
   * plugin is gone. Kept as the fallback for a host that does call the cleanup.
   */
  releaseAll(): number {
    return this.#settle("unload")
  }

  /**
   * The location is being replaced (the host's `location.shutdown`). Cancel
   * every held wait now and refuse new ones: the host disposes this generation's
   * hook, so a wait created after this point would never be settled, and a held
   * request must not be sent without a resume.
   */
  close(): number {
    this.#closed = true
    this.#paused = false
    return this.#settle("unload")
  }

  #settle(kind: "resume" | "cancel" | "unload", sessionID?: string): number {
    let settled = 0
    for (const [id, waiter] of this.#waiters) {
      if (sessionID !== undefined && waiter.sessionID !== sessionID) continue
      this.#waiters.delete(id)
      this.#onWaitEnd?.(waiter.sessionID)
      if (kind === "resume") waiter.resolve()
      else if (kind === "unload") waiter.reject(new PauseCancelledError())
      settled += 1
    }
    return settled
  }
}
