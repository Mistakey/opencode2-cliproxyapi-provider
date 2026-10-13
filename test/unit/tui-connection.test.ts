import { describe, expect, test } from "bun:test"
import type { ConnectionSnapshot } from "../../src/state"
import {
  createConnectionView,
  describeConnection,
  describeDetail,
  matchesLocation,
  parseReport,
  parseSnapshot,
  parseStaleModelID,
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
    fastEnabled: false,
    fastEffectiveModels: 0,
    applied: true,
    reloadRequired: false,
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
    expect(describeConnection(snapshot(), false)).toBe("OpenCode RPC offline")
    expect(describeConnection(undefined, true)).toBe("CPA not configured")
    expect(describeConnection(snapshot({ verified: "unknown" }), true)).toBe("CPA saved · Fast off")
    expect(describeConnection(snapshot({ verified: "unknown", keySaved: false }), true)).toBe(
      "CPA not configured · Fast off",
    )
    expect(describeConnection(snapshot({ catalogModels: 0 }), true)).toBe("CPA empty · Fast off")
    expect(describeConnection(snapshot({ catalogModels: 5 }), true)).toBe("CPA 5 models · Fast off")
    expect(describeConnection(snapshot({ verified: "failed", verifyKind: "auth" }), true)).toBe(
      "CPA 2 models · auth · Fast off",
    )
    expect(describeConnection(snapshot({ verified: "failed", verifyKind: "auth", catalogModels: 0 }), true)).toBe(
      "CPA auth · Fast off",
    )
  })

  test("separates the Fast preference from its effect", () => {
    expect(describeConnection(snapshot({ fastEnabled: true, fastEffectiveModels: 3 }), true)).toBe(
      "CPA 2 models · Fast on (3)",
    )
    // The preference is on but the directory declared no capable model.
    expect(describeConnection(snapshot({ fastEnabled: true, fastEffectiveModels: 0 }), true)).toBe(
      "CPA 2 models · Fast on (no capable model)",
    )
  })

  test("shows cached, stale and last-refresh state", () => {
    expect(describeConnection(snapshot({ catalogFromCache: true }), true)).toBe("CPA 2 models (cached) · Fast off")
    expect(describeConnection(snapshot({ catalogStaleModels: 1 }), true)).toBe("CPA 2 models · 1 stale · Fast off")
    const detail = describeDetail(
      snapshot({
        catalogFromCache: true,
        catalogFetchedAt: 1_700_000_000_000,
        catalogStaleModels: 1,
        catalogStaleIds: ["gone-model"],
      }),
      true,
      undefined,
    )
    expect(detail).toContain("last refresh: 2023-11-14T22:13:20.000Z (from cache)")
    expect(detail).toContain("stale: 1 (gone-model)")
    expect(detail).not.toContain("sk-")
  })

  test("shows selected transport, compaction and fallback notes, not WebSocket success", () => {
    const detail = describeDetail(snapshot({
      transport: "websocket", transportSource: "directory", compaction: "native",
      transportNote: "requested WebSocket; HTTP fallback remains possible",
      compactionNote: "native is unavailable for this model",
      applied: false, reloadRequired: true,
    }), true, undefined)
    expect(detail).toContain("transport (selected): websocket (from directory; not a connection-success check)")
    expect(detail).toContain("transport note: requested WebSocket; HTTP fallback remains possible")
    expect(detail).toContain("compaction: native")
    expect(detail).toContain("compaction note: native is unavailable for this model")
    expect(detail).toContain("apply: reload required")

    const http = describeDetail(snapshot({ transport: "http", transportSource: "option", compaction: "summary" }), true, undefined)
    expect(http).toContain("transport (selected): http (from option; not a connection-success check)")
    expect(http).toContain("compaction: summary")
    expect(http).toContain("apply: live in the runtime")
    expect(http).not.toContain("transport note:")
    expect(http).not.toContain("compaction note:")
    const unknown = describeDetail(snapshot({ applied: undefined, transport: undefined, compaction: undefined }), true, undefined)
    expect(unknown).toContain("transport (selected): (unknown)")
    expect(unknown).toContain("compaction: (unknown)")
    expect(unknown).toContain("apply: (unknown)")
  })

  test("distinguishes a lost host RPC link from failed CPA verification", () => {
    const failed = snapshot({ verified: "failed", verifyKind: "auth", verifyMessage: "CPA rejected the credential" })
    const rpcDown = describeDetail(failed, false, "ECONNREFUSED")
    expect(rpcDown).toContain("OpenCode server unreachable over RPC: ECONNREFUSED")
    expect(rpcDown).toContain("CPA connection status is unknown")
    expect(rpcDown).not.toContain("verified: failed")
    const cpaFailed = describeDetail(failed, true, undefined)
    expect(cpaFailed).toContain("OpenCode RPC: connected")
    expect(cpaFailed).toContain("verified: failed (auth)")
    expect(cpaFailed).toContain("detail: CPA rejected the credential")
    expect(cpaFailed).not.toContain("unreachable over RPC")
    expect(describeDetail(undefined, true, undefined)).toContain("CPA is not configured")
  })

  test("the detail view never contains key material", () => {
    const detail = describeDetail(
      snapshot({ addressSource: "wizard", keySource: "wizard", fastEnabled: true, fastEffectiveModels: 1, costModels: 2 }),
      true,
      undefined,
    )
    expect(detail).toContain("address:")
    expect(detail).toContain("saved: yes")
    expect(detail).toContain("verified: ok")
    expect(detail).toContain("fast: on (effective on 1 model(s))")
    expect(detail).toContain("models.dev estimate for 2 model(s), not a CPA bill")
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
  emitStale: (event: { location?: { directory?: string }; data?: unknown }) => void
} {
  let calls = 0
  const handlers = new Map<string, Set<(event: { data?: unknown; location?: { directory?: string } }) => void>>()
  const on = (name: string, next: (event: { data?: unknown; location?: { directory?: string } }) => void) => {
    let set = handlers.get(name)
    if (!set) {
      set = new Set()
      handlers.set(name, set)
    }
    set.add(next)
    return () => {
      set!.delete(next)
    }
  }
  const dispatch = (name: string, event: { data?: unknown; location?: { directory?: string } }) => {
    for (const handler of handlers.get(name) ?? []) handler(event)
  }
  const rpc: ConnectionRpc = {
    status: async () => {
      calls += 1
      return snapshot()
    },
    verify: async () => ({ ok: true, kind: "ok", models: 2, snapshot: snapshot() }),
    connect: async () => ({
      ok: true,
      kind: "ok",
      models: 2,
      snapshot: snapshot({ address: "http://new.test", applied: false, reloadRequired: true }),
    }),
    refresh: async () => ({
      ok: true,
      kind: "ok",
      models: 2,
      snapshot: snapshot({ catalogFetchedAt: 1, applied: false, reloadRequired: true }),
    }),
    setFast: async ({ enabled }) => ({
      ok: true,
      snapshot: snapshot({
        fastEnabled: enabled,
        fastEffectiveModels: enabled ? 2 : 0,
        applied: false,
        reloadRequired: true,
      }),
    }),
    pause: async () => ({ paused: true, changedAt: 1, waiting: 0, scope: "location" }),
    resume: async () => ({ paused: false, changedAt: 2, waiting: 0, scope: "location" }),
    pauseState: async () => ({ paused: false, changedAt: 1, waiting: 0, scope: "location" }),
    stats: async () => ({ stats: undefined }),
    events: { on },
    ...overrides,
  }
  return {
    rpc,
    statusCalls: () => calls,
    emit: (event) => dispatch("changed", event),
    emitStale: (event) => dispatch("stale", event),
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
    const order: string[] = []
    const view = createConnectionView({
      rpc: {
        ...fake.rpc,
        status: async () => {
          order.push("status")
          return snapshot({ address: "http://new.test" })
        },
      },
      directory: "/work/one",
      reload: async () => {
        order.push("reload")
      },
    })

    const probe = await view.verify("http://new.test", "sk-fake")
    expect(probe.ok).toBe(true)
    expect(view.snapshot()?.catalogModels).toBe(2)

    const saved = await view.connect("http://new.test", "sk-fake")
    expect(saved.ok).toBe(true)
    // A committed connect reloads the location so the new connection reaches
    // the wire, then re-reads the authoritative snapshot.
    expect(order).toEqual(["reload", "status"])
    expect(view.snapshot()?.address).toBe("http://new.test")
  })

  test("does not reload the location when a connect fails", async () => {
    const fake = fakeRpc({ connect: async () => ({ ok: false, kind: "auth", message: "bad key" }) })
    const order: string[] = []
    const view = createConnectionView({
      rpc: fake.rpc,
      directory: "/work/one",
      reload: async () => {
        order.push("reload")
      },
    })
    const saved = await view.connect("http://new.test", "sk-fake")
    expect(saved.ok).toBe(false)
    expect(order).toEqual([])
  })

  test("does not reload when the server reports the change is already applied", async () => {
    const fake = fakeRpc({
      connect: async () => ({
        ok: true,
        kind: "ok",
        models: 2,
        snapshot: snapshot({ address: "http://new.test", applied: true, reloadRequired: false }),
      }),
    })
    const order: string[] = []
    const view = createConnectionView({
      rpc: { ...fake.rpc, status: async () => snapshot({ address: "http://new.test" }) },
      directory: "/work/one",
      reload: async () => {
        order.push("reload")
      },
    })
    const saved = await view.connect("http://new.test", "sk-fake")
    expect(saved.ok).toBe(true)
    expect(order).toEqual([])
  })

  test("persists Fast, reloads the location and re-reads the authoritative snapshot", async () => {
    const fake = fakeRpc()
    const order: string[] = []
    const view = createConnectionView({
      rpc: {
        ...fake.rpc,
        setFast: async ({ enabled }) => {
          order.push(`set:${enabled}`)
          return {
            ok: true,
            snapshot: snapshot({
              fastEnabled: enabled,
              fastEffectiveModels: 0,
              applied: false,
              reloadRequired: true,
            }),
          }
        },
        status: async () => {
          order.push("status")
          return snapshot({ fastEnabled: true, fastEffectiveModels: 2, generation: 4 })
        },
      },
      directory: "/work/one",
      reload: async () => {
        order.push("reload")
      },
    })

    const report = await view.setFast(true)
    expect(report.ok).toBe(true)
    // The reload is what makes the persisted preference reach the provider registry.
    expect(order).toEqual(["set:true", "reload", "status"])
    expect(view.snapshot()?.fastEffectiveModels).toBe(2)
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

  test("refreshes the catalog over RPC and applies the returned snapshot", async () => {
    const fake = fakeRpc()
    const view = createConnectionView({
      rpc: { ...fake.rpc, status: async () => snapshot({ catalogFetchedAt: 1 }) },
      directory: "/work/one",
      reload: async () => undefined,
    })
    const report = await view.refreshCatalog()
    expect(report.ok).toBe(true)
    expect(report.models).toBe(2)
    expect(view.snapshot()?.catalogFetchedAt).toBe(1)
  })

  test("applies a background change the server reports as pending", async () => {
    const fake = fakeRpc()
    let pending = false
    const order: string[] = []
    const view = createConnectionView({
      rpc: {
        ...fake.rpc,
        status: async () => snapshot({ applied: !pending, reloadRequired: pending }),
      },
      directory: "/work/one",
      reload: async () => {
        order.push("reload")
        pending = false
      },
    })
    const unsubscribe = view.subscribe()
    pending = true
    fake.emit({ location: { directory: "/work/one" } })
    await new Promise((done) => setTimeout(done, 10))
    unsubscribe()
    expect(order).toEqual(["reload"])
  })

  test("forwards a stale event for this location only, once shaped as expected", async () => {
    const fake = fakeRpc()
    const seen: string[] = []
    const view = createConnectionView({
      rpc: fake.rpc,
      directory: "/work/one",
      onStale: (modelID) => seen.push(modelID),
    })
    const unsubscribe = view.subscribe()

    fake.emitStale({ location: { directory: "/work/two" }, data: { modelID: "other-location" } })
    fake.emitStale({ location: { directory: "/work/one" }, data: { modelID: "gone-model" } })
    fake.emitStale({ location: { directory: "/work/one" }, data: { nonsense: true } })
    expect(seen).toEqual(["gone-model"])

    unsubscribe()
    fake.emitStale({ location: { directory: "/work/one" }, data: { modelID: "after-unsubscribe" } })
    expect(seen).toEqual(["gone-model"])

    expect(parseStaleModelID({ data: { modelID: "m" } })).toBe("m")
    expect(parseStaleModelID({ data: { modelID: "" } })).toBeUndefined()
    expect(parseStaleModelID({ data: 42 })).toBeUndefined()
  })
})
