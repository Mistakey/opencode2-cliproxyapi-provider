import { describe, expect, test } from "bun:test"
import { PauseGate } from "../../src/pause"

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe("PauseGate", () => {
  test("starts running and lets a model call through", async () => {
    const gate = new PauseGate()
    expect(gate.read()).toEqual({ paused: false, changedAt: expect.any(Number), waiting: 0, scope: "location" })
    await gate.wait("ses_a")
    expect(gate.read().waiting).toBe(0)
  })

  test("pausing holds the next call until resume", async () => {
    const starts: string[] = []
    const ends: string[] = []
    const gate = new PauseGate({ onWaitStart: (id) => starts.push(id), onWaitEnd: (id) => ends.push(id) })

    const paused = gate.pause()
    expect(paused.paused).toBe(true)
    expect(paused.waiting).toBe(0)

    let released = false
    const waiting = gate.wait("ses_a").then(() => {
      released = true
    })
    await sleep(0)
    expect(released).toBe(false)
    expect(gate.read().waiting).toBe(1)
    expect(starts).toEqual(["ses_a"])

    const resumed = gate.resume()
    await waiting
    expect(released).toBe(true)
    expect(resumed.paused).toBe(false)
    expect(resumed.waiting).toBe(0)
    expect(ends).toEqual(["ses_a"])
  })

  test("an already in-flight call is not affected by pausing", async () => {
    const gate = new PauseGate()
    // The call passed the gate before the pause: it never waits.
    await gate.wait("ses_a")
    gate.pause()
    expect(gate.read().waiting).toBe(0)
  })

  test("cancelling a session drops its wait without resolving it", async () => {
    const gate = new PauseGate()
    gate.pause()
    let resolved = false
    void gate.wait("ses_a").then(() => {
      resolved = true
    })
    void gate.wait("ses_b").then(() => {
      resolved = true
    })
    expect(gate.read().waiting).toBe(2)

    expect(gate.cancel("ses_a")).toBe(1)
    expect(gate.read().waiting).toBe(1)
    await sleep(10)
    // The cancelled call must never be sent, so its wait must not resolve.
    expect(resolved).toBe(false)

    gate.resume()
    await sleep(0)
    expect(resolved).toBe(true)
  })

  test("unloading releases every wait and clears the bookkeeping", async () => {
    const gate = new PauseGate()
    gate.pause()
    const waits = [gate.wait("ses_a"), gate.wait("ses_b")]
    expect(gate.read().waiting).toBe(2)

    expect(gate.releaseAll()).toBe(2)
    await Promise.all(waits)
    expect(gate.read().waiting).toBe(0)
  })

  test("resume on a running gate changes nothing", () => {
    const gate = new PauseGate()
    const state = gate.resume()
    expect(state.paused).toBe(false)
    expect(state.waiting).toBe(0)
  })

  test("changedAt only moves on a real transition", () => {
    let now = 100
    const gate = new PauseGate({ now: () => now })
    expect(gate.read().changedAt).toBe(100)
    gate.pause()
    expect(gate.read().changedAt).toBe(100)
    now = 200
    gate.pause()
    expect(gate.read().changedAt).toBe(100)
    gate.resume()
    expect(gate.read().changedAt).toBe(200)
    now = 300
    gate.resume()
    expect(gate.read().changedAt).toBe(200)
  })
})
