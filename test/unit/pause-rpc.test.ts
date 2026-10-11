import { afterEach, describe, expect, test } from "bun:test"
import plugin from "../../src/index"
import { createFakeHost, type FakeHost } from "../support/fake-ctx"
import { startMockCpa } from "../support/mock-cpa.mjs"

const API_KEY = "sk-fake-pause-0123456789abcdef"
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

interface PauseState {
  paused: boolean
  changedAt: number
  waiting: number
  scope: string
}

interface TokenShape {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

interface SessionStatsShape {
  sessionID: string
  parentID?: string
  turns: number
  running: boolean
  steps: number
  retries: number
  effectiveMs: number
  tokens: TokenShape
  lastTurn?: { effectiveMs: number; pausedMs: number; tps?: number; tokens: TokenShape }
}

type Handlers = {
  status: (input: unknown) => Promise<Record<string, unknown>>
  pause: (input: unknown) => Promise<PauseState>
  resume: (input: unknown) => Promise<PauseState>
  pauseState: (input: unknown) => Promise<PauseState>
  stats: (input: unknown) => Promise<{ stats?: SessionStatsShape }>
  sessions: (input: unknown) => Promise<{ sessions: SessionStatsShape[] }>
}

let host: FakeHost | undefined
let mock: Awaited<ReturnType<typeof startMockCpa>> | undefined
let cleanup: (() => Promise<void> | void) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  host?.restoreConsole()
  host = undefined
  await mock?.close()
  mock = undefined
})

function handlersOf(target: FakeHost): Handlers {
  const registration = target.rpcRegistrations[0]
  if (!registration) throw new Error("the plugin registered no RPC")
  return registration.handlers as Handlers
}

async function setup(target: FakeHost) {
  cleanup =
    (await plugin.setup(target.ctx as unknown as Parameters<typeof plugin.setup>[0])) ?? undefined
}

let nextEvent = 0
function hostEvent(type: string, data: Record<string, unknown>, created = 1000) {
  nextEvent += 1
  return { id: `evt_host_${nextEvent}`, type, created, data }
}

/** The pause gate's own `model.request` hook; the stale-warning hook is one too. */
function pauseHook(target: FakeHost) {
  const hook = target.sessionHooks.filter((entry) => entry.name === "model.request").at(-1)
  if (!hook) throw new Error("the plugin registered no model.request hook")
  return hook
}

describe("pause gate over the server RPC", () => {
  test("registers the model.request hook for this provider only", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host)
    host.restoreConsole()

    expect(host.sessionHooks.filter((entry) => entry.name === "model.request")).toHaveLength(2)
    expect(pauseHook(host).options).toEqual({ providerID: "cliproxyapi" })
    const methods = Object.keys(host.rpcRegistrations[0]!.definition.methods)
    expect(methods).toEqual([
      "status",
      "verify",
      "refresh",
      "connect",
      "setFast",
      "pause",
      "resume",
      "pauseState",
      "stats",
      "sessions",
    ])
  })

  test("pause holds the next call, resume releases it without a model call", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host)
    host.restoreConsole()
    const handlers = handlersOf(host)
    const hook = pauseHook(host)

    // Running: the call passes straight through.
    await hook.callback({ sessionID: "ses_a", kind: "primary" })

    const paused = await handlers.pause({})
    expect(paused).toMatchObject({ paused: true, waiting: 0, scope: "location" })
    expect(host.rpcEvents.some((entry) => entry.name === "pause.changed")).toBe(true)

    let sent = false
    const pending = Promise.resolve(hook.callback({ sessionID: "ses_a", kind: "primary" })).then(() => {
      sent = true
    })
    await sleep(0)
    expect(sent).toBe(false)
    expect((await handlers.pauseState({})).waiting).toBe(1)

    // The resume is an RPC call, never a model call.
    const resumed = await handlers.resume({})
    expect(resumed.paused).toBe(false)
    await pending
    expect(sent).toBe(true)
    expect((await handlers.pauseState({})).waiting).toBe(0)
  })

  test("an interrupted session stops waiting and is never sent", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host)
    host.restoreConsole()
    const handlers = handlersOf(host)
    const hook = pauseHook(host)

    await handlers.pause({})
    let sent = false
    void Promise.resolve(hook.callback({ sessionID: "ses_cancelled", kind: "primary" })).then(() => {
      sent = true
    })
    await sleep(0)
    expect((await handlers.pauseState({})).waiting).toBe(1)

    host.pushEvent(hostEvent("session.execution.interrupted", { sessionID: "ses_cancelled", reason: "user" }))
    await sleep(0)
    await sleep(0)
    expect((await handlers.pauseState({})).waiting).toBe(0)
    expect(sent).toBe(false)

    await handlers.resume({})
  })

  test("stats follow the session events and are published on a turn boundary", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host)
    host.restoreConsole()
    const handlers = handlersOf(host)
    const before = host.rpcEvents.filter((entry) => entry.name === "stats.changed").length

    host.pushEvent(hostEvent("session.execution.started", { sessionID: "ses_stats" }, 1000))
    host.pushEvent(
      hostEvent(
        "session.step.ended",
        {
          sessionID: "ses_stats",
          assistantMessageID: "msg_1",
          tokens: { input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        1100,
      ),
    )
    await sleep(0)
    await sleep(0)
    // The turn start publishes once; a step is not a boundary on its own.
    expect(host.rpcEvents.filter((entry) => entry.name === "stats.changed").length).toBe(before + 1)

    host.pushEvent(hostEvent("session.execution.succeeded", { sessionID: "ses_stats" }, 1500))
    await sleep(0)
    await sleep(0)
    expect(host.rpcEvents.filter((entry) => entry.name === "stats.changed").length).toBe(before + 2)

    const result = await handlers.stats({ sessionID: "ses_stats" })
    expect(result.stats).toMatchObject({
      sessionID: "ses_stats",
      turns: 1,
      running: false,
      steps: 1,
      tokens: { input: 11, output: 7, total: 18 },
      lastTurn: { effectiveMs: 500, pausedMs: 0, tps: 14 },
    })
    expect(JSON.stringify(result)).not.toContain(API_KEY)

    const listed = await handlers.sessions({})
    expect(listed.sessions.map((entry) => entry.sessionID)).toEqual(["ses_stats"])
    expect(await handlers.stats({ sessionID: "ses_unknown" })).toEqual({})
  })

  test("a paused wait is excluded from the turn's effective duration", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host)
    host.restoreConsole()
    const handlers = handlersOf(host)
    const hook = pauseHook(host)

    host.pushEvent(hostEvent("session.execution.started", { sessionID: "ses_wait" }, 1000))
    await sleep(0)
    await handlers.pause({})
    const pending = hook.callback({ sessionID: "ses_wait", kind: "primary" })
    await sleep(0)
    await sleep(20)
    await handlers.resume({})
    await pending
    host.pushEvent(
      hostEvent(
        "session.step.ended",
        {
          sessionID: "ses_wait",
          assistantMessageID: "msg_wait",
          tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        1100,
      ),
    )
    host.pushEvent(hostEvent("session.execution.succeeded", { sessionID: "ses_wait" }, 1200))
    await sleep(0)
    await sleep(0)

    const turn = (await handlers.stats({ sessionID: "ses_wait" })).stats!.lastTurn!
    expect(turn.pausedMs).toBeGreaterThan(0)
    expect(turn.pausedMs).toBeLessThanOrEqual(turn.effectiveMs + turn.pausedMs)
  })

  test("a location shutdown cancels a held wait and stops the stream", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host)
    host.restoreConsole()
    const handlers = handlersOf(host)
    const hook = pauseHook(host)

    await handlers.pause({})
    let outcome = "pending"
    const pending = Promise.resolve(hook.callback({ sessionID: "ses_reload", kind: "primary" }))
      .then(() => (outcome = "resolved"))
      .catch(() => (outcome = "cancelled"))
    await sleep(0)
    expect((await handlers.pauseState({})).waiting).toBe(1)

    host.pushEvent(hostEvent("location.shutdown", {}))
    await pending
    // The unloaded generation must not let the paused request through.
    expect(outcome).toBe("cancelled")
    expect(await handlers.pauseState({})).toMatchObject({ paused: false, waiting: 0 })

    // The old generation's stream stopped: a later event is not observed.
    const published = host.rpcEvents.filter((entry) => entry.name === "stats.changed").length
    host.pushEvent(hostEvent("session.execution.started", { sessionID: "ses_after" }))
    await sleep(0)
    await sleep(0)
    expect(host.rpcEvents.filter((entry) => entry.name === "stats.changed").length).toBe(published)
    expect(await handlers.stats({ sessionID: "ses_after" })).toEqual({})
  })

  test("unload cancels the wait and disposes the hook", async () => {
    mock = await startMockCpa({ models: [{ slug: "a" }] })
    host = createFakeHost({ options: { baseURL: mock.url, apiKey: API_KEY, modelsDev: false } })
    await setup(host)
    host.restoreConsole()
    const handlers = handlersOf(host)
    const hook = pauseHook(host)

    await handlers.pause({})
    let outcome = "pending"
    const pending = Promise.resolve(hook.callback({ sessionID: "ses_unload", kind: "primary" }))
      .then(() => (outcome = "resolved"))
      .catch(() => (outcome = "cancelled"))
    await sleep(0)
    expect((await handlers.pauseState({})).waiting).toBe(1)

    await cleanup?.()
    cleanup = undefined
    await pending
    expect(outcome).toBe("cancelled")
    expect(hook.disposed).toBe(true)
  })
})
