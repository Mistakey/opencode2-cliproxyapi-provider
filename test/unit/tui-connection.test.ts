import { describe, expect, test } from "bun:test"
import type { ConnectionSnapshot } from "../../src/state"
import {
  createConnectionView,
  describeConnection,
  describeDetail,
  matchesLocation,
  parseReport,
  parseSnapshot,
  type ConnectionRpc,
} from "../../src/tui-connection"

function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    location: "/work/one",
    providerID: "cliproxyapi",
    integrationID: "cliproxyapi",
    keyHint: "(redacted, 24 chars)",
    keySaved: true,
    verified: "ok",
    verifyKind: "ok",
    catalogModels: 2,
    generation: 3,
    updatedAt: 1,
    ...overrides,
  }
}

describe("parseSnapshot", () => {
  test("accepts a complete snapshot and refuses an unexpected shape", () => {
    expect(parseSnapshot(snapshot())?.catalogModels).toBe(2)
    expect(parseSnapshot(undefined)).toBeUndefined()
    expect(parseSnapshot({ location: "/w" })).toBeUndefined()
    expect(parseSnapshot({ ...snapshot(), verified: "maybe" })).toBeUndefined()
  })
})

describe("describeConnection", () => {
  test("separates offline, unconfigured, saved and verified", () => {
    expect(describeConnection(snapshot(), false)).toBe("CPA offline")
    expect(describeConnection(undefined, true)).toBe("CPA not configured")
    expect(describeConnection(snapshot({ verified: "unknown" }), true)).toBe("CPA saved")
    expect(describeConnection(snapshot({ verified: "unknown", keySaved: false }), true)).toBe("CPA not configured")
    expect(describeConnection(snapshot({ catalogModels: 0 }), true)).toBe("CPA empty")
    expect(describeConnection(snapshot({ catalogModels: 5 }), true)).toBe("CPA 5 models")
    expect(describeConnection(snapshot({ verified: "failed", verifyKind: "auth" }), true)).toBe("CPA auth")
  })

  test("the detail view never contains key material", () => {
    const detail = describeDetail(snapshot({ addressSource: "wizard", keySource: "wizard" }), true, undefined)
    expect(detail).toContain("address:")
    expect(detail).toContain("saved: yes")
    expect(detail).toContain("verified: ok")
    expect(detail).not.toContain("sk-")
  })
})

describe("matchesLocation", () => {
  test("filters events from other locations and accepts the current one", () => {
    expect(matchesLocation({ location: { directory: "/work/one" } }, "/work/one")).toBe(true)
    expect(matchesLocation({ location: { directory: "/work/two" } }, "/work/one")).toBe(false)
    expect(matchesLocation({}, "/work/one")).toBe(false)
    expect(matchesLocation({ location: { directory: "/work/two" } }, undefined)).toBe(true)
  })
})

function fakeRpc(overrides: Partial<ConnectionRpc> = {}): {
  rpc: ConnectionRpc
  statusCalls: () => number
  emit: (event: { data?: unknown; location?: { directory?: string } }) => void
} {
  let calls = 0
  const handlers = new Set<(event: { data?: unknown; location?: { directory?: string } }) => void>()
  const rpc: ConnectionRpc = {
    status: async () => {
      calls += 1
      return snapshot()
    },
    verify: async () => ({ ok: true, kind: "ok", models: 2, snapshot: snapshot() }),
    connect: async () => ({ ok: true, kind: "ok", models: 2, snapshot: snapshot({ address: "http://new.test" }) }),
    pause: async () => ({ paused: true, changedAt: 1, waiting: 0, scope: "location" }),
    resume: async () => ({ paused: false, changedAt: 2, waiting: 0, scope: "location" }),
    pauseState: async () => ({ paused: false, changedAt: 1, waiting: 0, scope: "location" }),
    stats: async () => ({ stats: undefined }),
    events: {
      on: (_name, next) => {
        handlers.add(next)
        return () => {
          handlers.delete(next)
        }
      },
    },
    ...overrides,
  }
  return {
    rpc,
    statusCalls: () => calls,
    emit: (event) => {
      for (const handler of handlers) handler(event)
    },
  }
}

describe("createConnectionView", () => {
  test("reads the snapshot and re-reads it after an RPC outage", async () => {
    let server: ConnectionSnapshot | undefined = snapshot()
    let down = false
    const view = createConnectionView({
      rpc: {
        ...fakeRpc().rpc,
        status: async () => {
          if (down) throw new Error("ECONNREFUSED")
          return server
        },
      },
      directory: "/work/one",
    })

    await view.refresh()
    expect(view.connected()).toBe(true)
    expect(view.snapshot()?.catalogModels).toBe(2)

    // The remote client drops: the last snapshot is kept, the link is not.
    down = true
    await view.refresh()
    expect(view.connected()).toBe(false)
    expect(view.snapshot()?.catalogModels).toBe(2)
    expect(view.lastError()).toContain("ECONNREFUSED")

    // While disconnected the server moved on; a reconnect re-reads the state.
    server = snapshot({ catalogModels: 5, generation: 4, verified: "failed", verifyKind: "auth" })
    down = false
    await view.refresh()
    expect(view.connected()).toBe(true)
    expect(view.snapshot()?.catalogModels).toBe(5)
    expect(view.snapshot()?.verified).toBe("failed")
    expect(view.lastError()).toBeUndefined()
  })

  test("subscribes to changes for this location only", async () => {
    const fake = fakeRpc()
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })
    const unsubscribe = view.subscribe()
    const before = fake.statusCalls()

    fake.emit({ location: { directory: "/work/two" } })
    expect(fake.statusCalls()).toBe(before)

    fake.emit({ location: { directory: "/work/one" } })
    await new Promise((done) => setTimeout(done, 0))
    expect(fake.statusCalls()).toBe(before + 1)

    unsubscribe()
    fake.emit({ location: { directory: "/work/one" } })
    await new Promise((done) => setTimeout(done, 0))
    expect(fake.statusCalls()).toBe(before + 1)
  })

  test("applies verify and connect reports to the view", async () => {
    const fake = fakeRpc()
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })

    const probe = await view.verify("http://new.test", "sk-fake")
    expect(probe.ok).toBe(true)
    expect(view.snapshot()?.catalogModels).toBe(2)

    const saved = await view.connect("http://new.test", "sk-fake")
    expect(saved.ok).toBe(true)
    expect(view.snapshot()?.address).toBe("http://new.test")
  })

  test("ignores an RPC response that is not a report", async () => {
    const fake = fakeRpc({ verify: async () => ({ nonsense: true }) })
    const view = createConnectionView({ rpc: fake.rpc, directory: "/work/one" })
    const report = await view.verify("http://new.test", "sk-fake")
    expect(report.ok).toBe(false)
    expect(report.kind).toBe("unreachable")
    expect(parseReport({ ok: true, kind: "ok" })).toEqual({ ok: true, kind: "ok" })
    expect(parseReport(42)).toBeUndefined()
  })
})
