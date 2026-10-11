import { describe, expect, test } from "bun:test"
import { SessionStatsTracker, readTokens, tokenTotal, type TokenCounts } from "../../src/stats"

let nextId = 0
function event(type: string, data: Record<string, unknown>, created: number) {
  nextId += 1
  return { id: `evt_test_${nextId}`, type, created, data: { sessionID: "ses_a", ...data } }
}

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning = 0): TokenCounts => ({
  input,
  output,
  reasoning,
  cacheRead,
  cacheWrite,
  total: input + output + reasoning + cacheRead + cacheWrite,
})

const usage = (value: TokenCounts) => ({
  input: value.input,
  output: value.output,
  reasoning: value.reasoning,
  cache: { read: value.cacheRead, write: value.cacheWrite },
})

describe("readTokens", () => {
  test("reads the host shape and totals every counter", () => {
    expect(readTokens({ input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 1 } })).toEqual({
      input: 11,
      output: 7,
      reasoning: 2,
      cacheRead: 3,
      cacheWrite: 1,
      total: 24,
    })
    expect(readTokens({ input: 5 })).toEqual(tokens(5, 0))
    expect(readTokens(undefined)).toBeUndefined()
    expect(readTokens({})).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
    expect(tokenTotal({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 })).toBe(15)
  })
})

describe("SessionStatsTracker", () => {
  test("one turn with a tool continuation is one turn with two steps", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    expect(tracker.observe(event("session.execution.started", {}, 1000))).toEqual({
      sessionID: "ses_a",
      boundary: true,
    })
    tracker.observe(event("session.step.ended", { assistantMessageID: "msg_1", tokens: usage(tokens(11, 7)) }, 1100))
    tracker.observe(event("session.step.ended", { assistantMessageID: "msg_2", tokens: usage(tokens(5, 3)) }, 1200))
    expect(tracker.observe(event("session.execution.succeeded", {}, 1500))?.boundary).toBe(true)

    const stats = tracker.read("ses_a")!
    expect(stats.turns).toBe(1)
    expect(stats.running).toBe(false)
    expect(stats.steps).toBe(2)
    expect(stats.tokens).toEqual(tokens(16, 10))
    expect(stats.lastTurn).toMatchObject({
      startedAt: 1000,
      endedAt: 1500,
      durationMs: 500,
      pausedMs: 0,
      effectiveMs: 500,
      steps: 2,
      retries: 0,
      tps: 20,
    })
  })

  test("pause time inside the turn is excluded from the effective duration", () => {
    let clock = 1000
    const tracker = new SessionStatsTracker({ now: () => clock })
    tracker.observe(event("session.execution.started", {}, 1000))
    clock = 1100
    tracker.observe(event("session.step.ended", { assistantMessageID: "msg_1", tokens: usage(tokens(10, 4)) }, 1100))
    clock = 1200
    tracker.notePauseStart("ses_a")
    clock = 2200
    tracker.notePauseEnd("ses_a")
    clock = 2500
    tracker.observe(event("session.execution.succeeded", {}, 2500))

    const turn = tracker.read("ses_a")!.lastTurn!
    expect(turn.durationMs).toBe(1500)
    expect(turn.pausedMs).toBe(1000)
    expect(turn.effectiveMs).toBe(500)
    // 4 output tokens over 0.5s of effective time.
    expect(turn.tps).toBe(8)
  })

  test("a pause outside any turn is not attributed to a turn", () => {
    let clock = 100
    const tracker = new SessionStatsTracker({ now: () => clock })
    tracker.notePauseStart("ses_a")
    clock = 600
    tracker.notePauseEnd("ses_a")
    tracker.observe(event("session.execution.started", {}, 1000))
    tracker.observe(event("session.step.ended", { assistantMessageID: "msg_1", tokens: usage(tokens(1, 2)) }, 1200))
    tracker.observe(event("session.execution.succeeded", {}, 2000))
    expect(tracker.read("ses_a")!.lastTurn).toMatchObject({ durationMs: 1000, pausedMs: 0, effectiveMs: 1000 })
  })

  test("a retried step is counted once, and the retry is counted", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    tracker.observe(event("session.execution.started", {}, 1000))
    tracker.observe(event("session.retry.scheduled", { assistantMessageID: "msg_1", attempt: 2 }, 1010))
    tracker.observe(event("session.step.failed", { assistantMessageID: "msg_1", tokens: usage(tokens(3, 1)) }, 1020))
    tracker.observe(event("session.step.ended", { assistantMessageID: "msg_1", tokens: usage(tokens(11, 7)) }, 1200))
    tracker.observe(event("session.execution.succeeded", {}, 1300))

    const stats = tracker.read("ses_a")!
    expect(stats.steps).toBe(1)
    expect(stats.retries).toBe(1)
    expect(stats.tokens).toEqual(tokens(11, 7))
    expect(stats.lastTurn).toMatchObject({ steps: 1, retries: 1, tokens: tokens(11, 7) })
  })

  test("a replayed event id is not counted twice", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    tracker.observe(event("session.execution.started", {}, 1000))
    const step = event("session.step.ended", { assistantMessageID: "msg_1", tokens: usage(tokens(2, 1)) }, 1100)
    tracker.observe(step)
    tracker.observe(step)
    expect(tracker.read("ses_a")!.tokens).toEqual(tokens(2, 1))
    expect(tracker.read("ses_a")!.steps).toBe(1)
  })

  test("a step without usage is not invented", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    tracker.observe(event("session.execution.started", {}, 1000))
    tracker.observe(event("session.step.ended", { assistantMessageID: "msg_1" }, 1100))
    tracker.observe(event("session.execution.succeeded", {}, 1200))
    expect(tracker.read("ses_a")!.steps).toBe(0)
    expect(tracker.read("ses_a")!.tokens).toEqual(tokens(0, 0))
  })

  test("a child session is aggregated on its own, never into its parent", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    tracker.observe(event("session.created", { parentID: undefined }, 900))
    tracker.observe(event("session.created", { sessionID: "ses_child", parentID: "ses_a" }, 900))
    tracker.observe(event("session.execution.started", {}, 1000))
    tracker.observe(event("session.step.ended", { assistantMessageID: "msg_parent", tokens: usage(tokens(10, 5)) }, 1100))
    tracker.observe(event("session.execution.succeeded", {}, 1200))
    tracker.observe(event("session.execution.started", { sessionID: "ses_child" }, 1300))
    tracker.observe(
      event("session.step.ended", { sessionID: "ses_child", assistantMessageID: "msg_child", tokens: usage(tokens(2, 1)) }, 1400),
    )
    tracker.observe(event("session.execution.succeeded", { sessionID: "ses_child" }, 1500))

    expect(tracker.read("ses_a")!.tokens).toEqual(tokens(10, 5))
    expect(tracker.read("ses_a")!.parentID).toBeUndefined()
    expect(tracker.read("ses_child")!.tokens).toEqual(tokens(2, 1))
    expect(tracker.read("ses_child")!.parentID).toBe("ses_a")
    expect(tracker.list().map((entry) => entry.sessionID)).toEqual(["ses_child", "ses_a"])
  })

  test("an interrupted turn ends the turn without inventing a success", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    tracker.observe(event("session.execution.started", {}, 1000))
    tracker.observe(event("session.step.ended", { assistantMessageID: "msg_1", tokens: usage(tokens(4, 2)) }, 1100))
    expect(tracker.observe(event("session.execution.interrupted", { reason: "user" }, 1200))?.boundary).toBe(true)
    const stats = tracker.read("ses_a")!
    expect(stats.running).toBe(false)
    expect(stats.turns).toBe(1)
    expect(stats.lastTurn!.endedAt).toBe(1200)
    expect(stats.lastTurn!.tokens).toEqual(tokens(4, 2))
  })

  test("two turns accumulate session totals and keep the last turn", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    for (const [start, end, input, output] of [
      [1000, 2000, 10, 5],
      [3000, 4000, 4, 2],
    ] as const) {
      tracker.observe(event("session.execution.started", {}, start))
      tracker.observe(
        event("session.step.ended", { assistantMessageID: `msg_${start}`, tokens: usage(tokens(input, output)) }, start + 100),
      )
      tracker.observe(event("session.execution.succeeded", {}, end))
    }
    const stats = tracker.read("ses_a")!
    expect(stats.turns).toBe(2)
    expect(stats.steps).toBe(2)
    expect(stats.tokens).toEqual(tokens(14, 7))
    expect(stats.effectiveMs).toBe(2000)
    expect(stats.lastTurn!.tokens).toEqual(tokens(4, 2))
  })

  test("an unknown session has no stats, and a deleted session is dropped", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    expect(tracker.read("ses_missing")).toBeUndefined()
    tracker.observe(event("session.execution.started", {}, 1000))
    expect(tracker.read("ses_a")).toBeDefined()
    tracker.observe(event("session.deleted", {}, 1100))
    expect(tracker.read("ses_a")).toBeUndefined()
  })

  test("ignores events without a type or a session", () => {
    const tracker = new SessionStatsTracker({ now: () => 0 })
    expect(tracker.observe(undefined)).toBeUndefined()
    expect(tracker.observe({})).toBeUndefined()
    expect(tracker.observe({ type: "session.execution.started", created: 1, data: {} })).toBeUndefined()
  })

  test("a running turn reports its live duration without mutating the record", () => {
    let clock = 1000
    const tracker = new SessionStatsTracker({ now: () => clock })
    tracker.observe(event("session.execution.started", {}, 1000))
    clock = 1500
    const live = tracker.read("ses_a")!
    expect(live.running).toBe(true)
    expect(live.lastTurn!.durationMs).toBe(500)
    expect(live.turns).toBe(0)
    clock = 2500
    expect(tracker.read("ses_a")!.lastTurn!.durationMs).toBe(1500)
  })
})
