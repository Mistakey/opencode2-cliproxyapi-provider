import { describe, expect, test } from "bun:test"
import type { SessionStats } from "../../src/stats"
import {
  createConnectionView,
  describeFooter,
  describePause,
  describeStats,
  describeTurn,
  formatDuration,
  formatTokens,
  parsePauseState,
  parseStats,
  type ConnectionRpc,
} from "../../src/tui-connection"
import type { ConnectionSnapshot } from "../../src/state"

const snapshot: ConnectionSnapshot = {
  location: "/work/one",
  providerID: "cliproxyapi",
  integrationID: "cliproxyapi",
  keyHint: "(redacted, 24 chars)",
  keySaved: true,
  verified: "ok",
  verifyKind: "ok",
  catalogModels: 2,
  fastEnabled: false,
  fastEffectiveModels: 0,
  generation: 3,
  updatedAt: 1,
}

const sessionStats: SessionStats = {
  sessionID: "ses_a",
  turns: 1,
  running: false,
  steps: 2,
  retries: 1,
  effectiveMs: 2000,
  tokens: { input: 16, output: 10, reasoning: 0, cacheRead: 4, cacheWrite: 1, total: 31 },
  lastTurn: {
    startedAt: 1000,
    endedAt: 3000,
    durationMs: 3000,
    pausedMs: 1000,
    effectiveMs: 2000,
    steps: 2,
    retries: 1,
    tokens: { input: 16, output: 10, reasoning: 0, cacheRead: 4, cacheWrite: 1, total: 31 },
    tps: 5,
  },
}

function fakeRpc(overrides: Partial<ConnectionRpc> = {}): {
  rpc: ConnectionRpc
  handlers: Set<(event: { data?: unknown; location?: { directory?: string } }) => void>
  emit: (name: string, event: { data?: unknown; location?: { directory?: string } }) => void
  statsCalls: () => number
} {
  let statsCalls = 0
  const byName = new Map<string, Set<(event: { data?: unknown; location?: { directory?: string } }) => void>>()
  const rpc: ConnectionRpc = {
    status: async () => snapshot,
    verify: async () => ({ ok: true, kind: "ok", snapshot }),
    connect: async () => ({ ok: true, kind: "ok", snapshot }),
    refresh: async () => ({ ok: true, kind: "ok", snapshot }),
    setFast: async () => ({ ok: true, snapshot }),
    pause: async () => ({ paused: true, changedAt: 1, waiting: 0, scope: "location" }),
    resume: async () => ({ paused: false, changedAt: 2, waiting: 0, scope: "location" }),
    pauseState: async () => ({ paused: false, changedAt: 1, waiting: 0, scope: "location" }),
    stats: async () => {
      statsCalls += 1
      return { stats: sessionStats }
    },
    events: {
      on: (name, next) => {
        let set = byName.get(name)
        if (!set) {
          set = new Set()
          byName.set(name, set)
        }
        set.add(next)
        return () => {
          set!.delete(next)
        }
      },
    },
    ...overrides,
  }
  return {
    rpc,
    get handlers() {
      return new Set([...byName.values()].flatMap((set) => [...set]))
    },
    emit: (name, event) => {
      for (const handler of byName.get(name) ?? []) handler(event)
    },
    statsCalls: () => statsCalls,
  }
}

describe("parsePauseState and parseStats", () => {
  test("accept a well-formed state and refuse anything else", () => {
    expect(parsePauseState({ paused: true, changedAt: 1, waiting: 2, scope: "location" })?.paused).toBe(true)
    expect(parsePauseState({ paused: true })).toBeUndefined()
    expect(parsePauseState({ paused: "yes", changedAt: 1, waiting: 0, scope: "location" })).toBeUndefined()
    expect(parsePauseState({ paused: true, changedAt: 1, waiting: 0, scope: "session" })).toBeUndefined()

    expect(parseStats(sessionStats)?.lastTurn?.tps).toBe(5)
    expect(parseStats({ ...sessionStats, tokens: { input: 1 } })).toBeUndefined()
    expect(parseStats({ ...sessionStats, lastTurn: { bogus: true } })).toBeUndefined()
    expect(parseStats(undefined)).toBeUndefined()
  })
})

describe("stats formatting", () => {
  test("formats durations and token counters", () => {
    expect(formatDuration(500)).toBe("500ms")
    expect(formatDuration(2000)).toBe("2.0s")
    expect(formatDuration(65_000)).toBe("1m05s")
    expect(formatTokens({ input: 1234, output: 5, reasoning: 0, cacheRead: 10, cacheWrite: 0, total: 1249 })).toBe(
      "in 1,234 · out 5 · reasoning 0 · cache 10/0 · total 1,249",
    )
  })

  test("carries rounded seconds into minutes without changing the recorded duration", () => {
    expect(formatDuration(119_499)).toBe("1m59s")
    expect(formatDuration(119_500)).toBe("2m00s")
    expect(formatDuration(119_600)).toBe("2m00s")
    expect(formatDuration(179_600)).toBe("3m00s")
    expect(formatDuration(3_599_600)).toBe("60m00s")
    expect(formatDuration(60_000)).toBe("1m00s")
    expect(formatDuration(-1)).toBe("?")
    expect(formatDuration(Number.NaN)).toBe("?")
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("?")
  })

  test("describes pause, the turn and the footer without claiming decode speed", () => {
    expect(describePause(undefined)).toBe("unknown")
    expect(describePause({ paused: false, changedAt: 0, waiting: 0, scope: "location" })).toBe("running")
    expect(describePause({ paused: true, changedAt: 0, waiting: 2, scope: "location" })).toBe("paused (2 waiting)")
    expect(describeTurn(sessionStats)).toBe("2.0s · 5.0 tok/s")
    expect(describeTurn({ ...sessionStats, running: true })).toBe("2.0s · 5.0 tok/s (running)")
    expect(describeTurn(undefined)).toBeUndefined()
    expect(describeFooter(snapshot, true, undefined, sessionStats)).toBe("CPA 2 models · Fast off · 2.0s · 5.0 tok/s")
    expect(describeFooter(snapshot, true, { paused: true, changedAt: 0, waiting: 0, scope: "location" }, undefined)).toBe(
      "CPA 2 models · Fast off · paused",
    )
  })

  test("the stats detail separates the turn from the session and never invents a value", () => {
    const detail = describeStats(sessionStats)
    expect(detail).toContain("turns: 1")
    expect(detail).toContain("steps: 2 · retries: 1")
    expect(detail).toContain("last turn: 2.0s effective (3.0s wall, 1.0s paused) · 5.0 tok/s")
    expect(detail).toContain("tokens (last turn): in 16 · out 10")
    expect(describeStats(undefined)).toContain("No CPA model calls")
  })
})

describe("createConnectionView pause and stats", () => {
  test("applies pause and resume results", async () => {
    const fake = fakeRpc()
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })
    await view.refresh()
    expect(view.pause()?.paused).toBe(false)

    expect((await view.pauseRequests())?.paused).toBe(true)
    expect(view.pause()?.paused).toBe(true)
    expect((await view.resumeRequests())?.paused).toBe(false)
    expect(view.pause()?.paused).toBe(false)
  })

  test("reports a failed pause over RPC instead of pretending it worked", async () => {
    const fake = fakeRpc({
      pause: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })
    expect(await view.pauseRequests()).toBeUndefined()
    expect(view.connected()).toBe(false)
    expect(view.lastError()).toContain("ECONNREFUSED")
  })

  test("reads stats once per session and updates from the stats event", async () => {
    const fake = fakeRpc()
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })
    const unsubscribe = view.subscribe()

    // The first read schedules a fetch; the value arrives on the next tick.
    expect(view.stats("ses_a")).toBeUndefined()
    await new Promise((done) => setTimeout(done, 0))
    expect(view.stats("ses_a")?.turns).toBe(1)
    expect(fake.statsCalls()).toBe(1)
    // A later read is served from the cache, not another RPC call.
    view.stats("ses_a")
    expect(fake.statsCalls()).toBe(1)

    const updated: SessionStats = { ...sessionStats, turns: 4 }
    fake.emit("stats.changed", { data: updated, location: { directory: "/work/one" } })
    expect(view.stats("ses_a")?.turns).toBe(4)

    fake.emit("stats.changed", { data: updated, location: { directory: "/work/other" } })
    expect(view.stats("ses_a")?.turns).toBe(4)

    unsubscribe()
  })

  test("re-reads stats after a reconnect instead of trusting the stale cache", async () => {
    let down = false
    let current: SessionStats = sessionStats
    let calls = 0
    const fake = fakeRpc({
      status: async () => {
        if (down) throw new Error("ECONNREFUSED")
        return snapshot
      },
      stats: async () => {
        calls += 1
        return { stats: current }
      },
    })
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })

    await view.refresh()
    view.stats("ses_a")
    await new Promise((done) => setTimeout(done, 0))
    expect(view.stats("ses_a")?.turns).toBe(1)
    expect(calls).toBe(1)

    // The link drops, the server moves on, the link returns.
    down = true
    await view.refresh()
    expect(view.connected()).toBe(false)
    current = { ...sessionStats, turns: 7 }
    down = false
    await view.refresh()
    await new Promise((done) => setTimeout(done, 0))
    expect(view.connected()).toBe(true)
    expect(view.stats("ses_a")?.turns).toBe(7)
    expect(calls).toBe(2)
  })

  test("ignores a stats response that is not a stats object", async () => {
    const fake = fakeRpc({ stats: async () => ({ stats: { nonsense: true } }) })
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })
    expect(view.stats("ses_a")).toBeUndefined()
    await new Promise((done) => setTimeout(done, 0))
    expect(view.stats("ses_a")).toBeUndefined()
  })

  test("applies a pause event without a refresh", () => {
    const fake = fakeRpc()
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })
    const unsubscribe = view.subscribe()
    fake.emit("pause.changed", {
      data: { paused: true, changedAt: 9, waiting: 1, scope: "location" },
      location: { directory: "/work/one" },
    })
    expect(view.pause()).toEqual({ paused: true, changedAt: 9, waiting: 1, scope: "location" })
    unsubscribe()
  })
})
