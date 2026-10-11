/**
 * Per-session timing and usage statistics.
 *
 * The tracker reads the host's own session events and keeps a small aggregate
 * per session. Nothing here contacts CPA and nothing here holds a credential.
 *
 * Measurement rules (also documented in README):
 *
 * - A **turn** is one host execution: `session.execution.started` until
 *   `session.execution.succeeded | failed | interrupted`. One user prompt with
 *   tool continuations is one turn, so tool rounds are not separate turns.
 * - **Effective duration** is the turn's wall time minus the time this session
 *   spent waiting at the pause gate. Pausing while nothing waits does not
 *   subtract anything: the turn was not blocked.
 * - **TPS** is `output tokens / effective seconds` for the whole turn. It is not
 *   pure decode speed, because tool rounds, retries and the pause gate are all
 *   inside the same window.
 * - **Tokens** come from the host's `session.step.ended` / `session.step.failed`
 *   events, keyed by assistant message id. A retried step reuses its message id
 *   and reports its final usage once, so a retry is counted once, not once per
 *   attempt. `total` follows the host's `TokenUsage.total`:
 *   `input + output + reasoning + cache.read + cache.write`.
 * - Every session id is aggregated on its own. A child (subagent) session is
 *   never folded into its parent.
 */

/** Token counters in the host's normalized shape. */
export interface TokenCounts {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly total: number
}

export const ZERO_TOKENS: TokenCounts = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
}

/** One host turn, as reported to a reader. */
export interface TurnStats {
  readonly startedAt: number
  readonly endedAt?: number
  readonly durationMs: number
  readonly pausedMs: number
  readonly effectiveMs: number
  readonly steps: number
  readonly retries: number
  readonly tokens: TokenCounts
  readonly tps?: number
}

/** One session's aggregate, as reported to a reader. */
export type SessionStats = {
  readonly sessionID: string
  readonly parentID?: string
  readonly turns: number
  readonly running: boolean
  readonly steps: number
  readonly retries: number
  readonly effectiveMs: number
  readonly tokens: TokenCounts
  readonly lastTurn?: TurnStats
}

export interface SessionEventLike {
  readonly id?: string
  readonly type?: string
  readonly created?: number
  readonly data?: unknown
}

export interface ObserveResult {
  readonly sessionID: string
  /** True when a turn boundary moved, i.e. the snapshot is worth publishing. */
  readonly boundary: boolean
}

const MAX_SEEN_EVENTS = 512
const MAX_SESSIONS = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Read the host's `TokenUsage.Info` shape; `undefined` when there is no usage. */
export function readTokens(value: unknown): TokenCounts | undefined {
  if (!isRecord(value)) return undefined
  const cache = isRecord(value.cache) ? value.cache : {}
  const tokens: TokenCounts = {
    input: finite(value.input),
    output: finite(value.output),
    reasoning: finite(value.reasoning),
    cacheRead: finite(cache.read),
    cacheWrite: finite(cache.write),
    total: 0,
  }
  return { ...tokens, total: tokenTotal(tokens) }
}

/** The host's own total: every counter, cache included. */
export function tokenTotal(tokens: Omit<TokenCounts, "total">): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

function addTokens(left: TokenCounts, right: TokenCounts): TokenCounts {
  const sum = {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: 0,
  }
  return { ...sum, total: tokenTotal(sum) }
}

function subtractTokens(left: TokenCounts, right: TokenCounts): TokenCounts {
  const difference = {
    input: Math.max(0, left.input - right.input),
    output: Math.max(0, left.output - right.output),
    reasoning: Math.max(0, left.reasoning - right.reasoning),
    cacheRead: Math.max(0, left.cacheRead - right.cacheRead),
    cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
    total: 0,
  }
  return { ...difference, total: tokenTotal(difference) }
}

interface MutableTurn {
  startedAt: number
  endedAt?: number
  durationMs: number
  pausedMs: number
  effectiveMs: number
  steps: number
  retries: number
  tokens: TokenCounts
  tps?: number
}

interface SessionRecord {
  sessionID: string
  parentID?: string
  turns: number
  running: boolean
  steps: number
  retries: number
  effectiveMs: number
  tokens: TokenCounts
  lastTurn?: MutableTurn
  turn?: MutableTurn
  /** Last counted usage per assistant message id, with the turn it landed in. */
  messages: Map<string, { tokens: TokenCounts; turn?: MutableTurn }>
  /** Open pause wait for this session, if any. */
  pauseStartedAt?: number
  order: number
}

export interface SessionStatsTrackerOptions {
  readonly now?: () => number
}

export class SessionStatsTracker {
  readonly #now: () => number
  readonly #sessions = new Map<string, SessionRecord>()
  readonly #seen = new Set<string>()
  readonly #seenOrder: string[] = []
  #order = 0

  constructor(options: SessionStatsTrackerOptions = {}) {
    this.#now = options.now ?? Date.now
  }

  /**
   * Fold one host event into the aggregate.
   *
   * Returns `undefined` for an event that carries no session, a duplicate event
   * id, or a shape this tracker does not use.
   */
  observe(event: SessionEventLike | undefined): ObserveResult | undefined {
    if (!event || typeof event.type !== "string") return undefined
    if (event.id) {
      if (this.#seen.has(event.id)) return undefined
      this.#seen.add(event.id)
      this.#seenOrder.push(event.id)
      if (this.#seenOrder.length > MAX_SEEN_EVENTS) {
        const oldest = this.#seenOrder.shift()
        if (oldest !== undefined) this.#seen.delete(oldest)
      }
    }
    const data = isRecord(event.data) ? event.data : {}
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return undefined
    const at = typeof event.created === "number" && Number.isFinite(event.created) ? event.created : this.#now()

    switch (event.type) {
      case "session.created": {
        const record = this.#record(sessionID)
        record.parentID = typeof data.parentID === "string" ? data.parentID : undefined
        return { sessionID, boundary: false }
      }
      case "session.deleted": {
        this.#sessions.delete(sessionID)
        return { sessionID, boundary: false }
      }
      case "session.execution.started": {
        const record = this.#record(sessionID)
        this.#closeTurn(record, at)
        record.turn = {
          startedAt: at,
          durationMs: 0,
          pausedMs: 0,
          effectiveMs: 0,
          steps: 0,
          retries: 0,
          tokens: ZERO_TOKENS,
        }
        record.running = true
        return { sessionID, boundary: true }
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const record = this.#sessions.get(sessionID)
        // The boundary is reported even for an unseen session, so a caller can
        // still react to a cancelled execution it never saw start.
        if (!record) return { sessionID, boundary: false }
        this.#closeTurn(record, at)
        record.running = false
        return { sessionID, boundary: true }
      }
      case "session.step.ended":
      case "session.step.failed": {
        const tokens = readTokens(data.tokens)
        if (!tokens) return undefined
        const record = this.#record(sessionID)
        const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
        this.#countStep(record, messageID, tokens)
        return { sessionID, boundary: false }
      }
      case "session.retry.scheduled": {
        const record = this.#sessions.get(sessionID)
        if (!record) return undefined
        record.retries += 1
        if (record.turn) record.turn.retries += 1
        return { sessionID, boundary: false }
      }
      default:
        return { sessionID, boundary: false }
    }
  }

  /** A model call for this session started waiting at the pause gate. */
  notePauseStart(sessionID: string): void {
    const record = this.#sessions.get(sessionID)
    if (!record) return
    if (record.pauseStartedAt === undefined) record.pauseStartedAt = this.#now()
  }

  /** The wait ended: attribute the interval to the turn that was open. */
  notePauseEnd(sessionID: string): void {
    const record = this.#sessions.get(sessionID)
    if (!record || record.pauseStartedAt === undefined) return
    const now = this.#now()
    const started = record.pauseStartedAt
    record.pauseStartedAt = undefined
    const turn = record.turn
    if (!turn) return
    // A wait that began before the turn opened only pauses the part inside it.
    turn.pausedMs += Math.max(0, now - Math.max(started, turn.startedAt))
  }

  read(sessionID: string): SessionStats | undefined {
    const record = this.#sessions.get(sessionID)
    return record ? this.#project(record) : undefined
  }

  list(): SessionStats[] {
    return [...this.#sessions.values()].sort((a, b) => b.order - a.order).map((record) => this.#project(record))
  }

  get size(): number {
    return this.#sessions.size
  }

  #record(sessionID: string): SessionRecord {
    let record = this.#sessions.get(sessionID)
    if (!record) {
      record = {
        sessionID,
        turns: 0,
        running: false,
        steps: 0,
        retries: 0,
        effectiveMs: 0,
        tokens: ZERO_TOKENS,
        messages: new Map(),
        order: 0,
      }
      this.#sessions.set(sessionID, record)
      this.#evict()
    }
    record.order = ++this.#order
    return record
  }

  /** Keep memory bounded: drop the least recently active finished session. */
  #evict(): void {
    if (this.#sessions.size <= MAX_SESSIONS) return
    let victim: SessionRecord | undefined
    for (const record of this.#sessions.values()) {
      if (record.running) continue
      if (!victim || record.order < victim.order) victim = record
    }
    if (victim) this.#sessions.delete(victim.sessionID)
  }

  #closeTurn(record: SessionRecord, at: number): void {
    const turn = record.turn
    if (!turn) return
    // A pause wait that is still open when the turn closes was part of this
    // turn's wall time (an interruption cancels it before the gate reports the
    // end), so attribute the wait up to the close and clear it rather than
    // letting the later pause-end find no turn to charge.
    if (record.pauseStartedAt !== undefined) {
      turn.pausedMs += Math.max(0, at - Math.max(record.pauseStartedAt, turn.startedAt))
      record.pauseStartedAt = undefined
    }
    turn.endedAt = at
    turn.durationMs = Math.max(0, at - turn.startedAt)
    turn.effectiveMs = Math.max(0, turn.durationMs - turn.pausedMs)
    if (turn.effectiveMs > 0) turn.tps = (turn.tokens.output / turn.effectiveMs) * 1000
    record.lastTurn = turn
    record.turn = undefined
    record.turns += 1
    record.effectiveMs += turn.effectiveMs
  }

  #countStep(record: SessionRecord, messageID: string | undefined, tokens: TokenCounts): void {
    const previous = messageID !== undefined ? record.messages.get(messageID) : undefined
    if (previous) {
      // Same assistant message reported again (a retry that ended, a replayed
      // event): replace its contribution instead of adding a second one.
      record.tokens = subtractTokens(record.tokens, previous.tokens)
      if (previous.turn) previous.turn.tokens = subtractTokens(previous.turn.tokens, previous.tokens)
      if (previous.turn) previous.turn.steps = Math.max(0, previous.turn.steps - 1)
      record.steps = Math.max(0, record.steps - 1)
    }
    record.tokens = addTokens(record.tokens, tokens)
    record.steps += 1
    const turn = record.turn
    if (turn) {
      turn.tokens = addTokens(turn.tokens, tokens)
      turn.steps += 1
    }
    if (messageID !== undefined) record.messages.set(messageID, { tokens, ...(turn ? { turn } : {}) })
  }

  #project(record: SessionRecord): SessionStats {
    const turn = record.turn
    const lastTurn = turn ? this.#projectLiveTurn(turn) : record.lastTurn ? projectTurn(record.lastTurn) : undefined
    return {
      sessionID: record.sessionID,
      ...(record.parentID !== undefined ? { parentID: record.parentID } : {}),
      turns: record.turns,
      running: record.running,
      steps: record.steps,
      retries: record.retries,
      effectiveMs: record.effectiveMs,
      tokens: record.tokens,
      ...(lastTurn ? { lastTurn } : {}),
    }
  }

  /** A turn still in progress: report the elapsed time so far, without mutating. */
  #projectLiveTurn(turn: MutableTurn): TurnStats {
    const durationMs = Math.max(0, this.#now() - turn.startedAt)
    const effectiveMs = Math.max(0, durationMs - turn.pausedMs)
    return {
      startedAt: turn.startedAt,
      durationMs,
      pausedMs: turn.pausedMs,
      effectiveMs,
      steps: turn.steps,
      retries: turn.retries,
      tokens: turn.tokens,
      ...(effectiveMs > 0 && turn.tokens.output > 0
        ? { tps: (turn.tokens.output / effectiveMs) * 1000 }
        : {}),
    }
  }
}

function projectTurn(turn: MutableTurn): TurnStats {
  return {
    startedAt: turn.startedAt,
    ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
    durationMs: turn.durationMs,
    pausedMs: turn.pausedMs,
    effectiveMs: turn.effectiveMs,
    steps: turn.steps,
    retries: turn.retries,
    tokens: turn.tokens,
    ...(turn.tps !== undefined ? { tps: turn.tps } : {}),
  }
}
