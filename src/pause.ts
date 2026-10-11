/**
 * Cancellable pause gate for CPA model requests.
 *
 * Pausing must stop the *next* CPA request without touching one already in
 * flight, and the wait must end when the session is cancelled or the plugin is
 * unloaded. So the gate is a plain promise per waiting model call: no polling,
 * no interval, and nothing to leak. `resume()` releases the waits; a
 * `session.execution.interrupted` event drops the waits of the cancelled
 * session (the host interrupts the request fiber itself, so dropping the
 * resolver never sends the request); unloading releases everything.
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

interface Waiter {
  readonly sessionID: string
  readonly resolve: () => void
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
   * A resolved wait means "the request may be sent now". A dropped wait (see
   * `cancel`) never resolves, because the host has already abandoned the call.
   */
  wait(sessionID: string): Promise<void> {
    if (this.#closed || !this.#paused) return Promise.resolve()
    const id = this.#next
    this.#next += 1
    return new Promise<void>((resolve) => {
      this.#waiters.set(id, { sessionID, resolve })
      this.#onWaitStart?.(sessionID)
    })
  }

  /**
   * The host ended this session's execution (interrupt/cancel). Stop tracking
   * its waits without resolving them: resolving could still send a request the
   * host has already cancelled.
   */
  cancel(sessionID: string): number {
    return this.#settle("cancel", sessionID)
  }

  /** Unload: release every wait so no plugin state outlives the instance. */
  releaseAll(): number {
    return this.#settle("release")
  }

  /**
   * The location is being replaced (the host's `location.shutdown`). End every
   * wait now and refuse new ones: the host disposes this generation's hook, so
   * a wait created after this point would never be released.
   */
  close(): number {
    this.#closed = true
    this.#paused = false
    return this.#settle("release")
  }

  #settle(kind: "resume" | "cancel" | "release", sessionID?: string): number {
    let settled = 0
    for (const [id, waiter] of this.#waiters) {
      if (sessionID !== undefined && waiter.sessionID !== sessionID) continue
      this.#waiters.delete(id)
      this.#onWaitEnd?.(waiter.sessionID)
      if (kind !== "cancel") waiter.resolve()
      settled += 1
    }
    return settled
  }
}
