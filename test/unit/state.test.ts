import { describe, expect, test } from "bun:test"
import { ConnectionState, connectionUpdate, verifyConnection } from "../../src/state"
import { startMockCpa } from "../support/mock-cpa.mjs"

const API_KEY = "sk-fake-state-0123456789"

describe("ConnectionState", () => {
  const initial = {
    location: "/work/one",
    providerID: "cliproxyapi",
    integrationID: "cliproxyapi",
    keyHint: "(none)",
    keySaved: false,
    verified: "unknown" as const,
    fastEnabled: false,
    fastEffectiveModels: 0,
  }

  test("commits an update for the current generation", () => {
    const state = new ConnectionState({ ...initial, now: () => 1000 })
    const generation = state.begin()
    expect(state.commit(generation, { address: "http://a.test", verified: "ok", catalogModels: 3 })).toBe(true)
    expect(state.read()).toMatchObject({
      location: "/work/one",
      address: "http://a.test",
      verified: "ok",
      catalogModels: 3,
      generation,
      updatedAt: 1000,
    })
  })

  test("drops a stale commit after a newer connection change began", () => {
    const state = new ConnectionState(initial)
    const first = state.begin()
    const second = state.begin()
    expect(state.commit(first, { address: "http://stale.test", verified: "ok" })).toBe(false)
    expect(state.commit(second, { address: "http://fresh.test", verified: "ok" })).toBe(true)
    expect(state.read().address).toBe("http://fresh.test")
    expect(state.read().generation).toBe(second)
    expect(state.isCurrent(first)).toBe(false)
  })

  test("clears a field set to undefined instead of leaving an undefined value", () => {
    const state = new ConnectionState(initial)
    const generation = state.begin()
    state.commit(generation, { verified: "failed", verifyKind: "auth", verifyMessage: "401" })
    expect(state.read().verifyMessage).toBe("401")
    state.commit(generation, { verified: "ok", verifyKind: "ok", verifyMessage: undefined })
    expect(state.read().verifyMessage).toBeUndefined()
    expect("verifyMessage" in state.read()).toBe(false)
    expect(JSON.stringify(state.read())).not.toContain("401")
  })

  test("patches non-connection state without touching the generation", () => {
    const state = new ConnectionState({ ...initial, now: () => 1000 })
    const generation = state.begin()
    state.commit(generation, { verified: "ok", catalogModels: 2 })
    state.patch({ fastEnabled: true, fastEffectiveModels: 2, costModels: 2 })
    expect(state.read()).toMatchObject({
      verified: "ok",
      fastEnabled: true,
      fastEffectiveModels: 2,
      costModels: 2,
      generation,
    })
    // A pending connection change does not drop a Fast update.
    state.begin()
    state.patch({ fastEnabled: false, fastEffectiveModels: 0 })
    expect(state.read().fastEnabled).toBe(false)
    expect(state.read().verified).toBe("ok")
  })

  test("describes a connection without ever holding the key", () => {
    const update = connectionUpdate({
      address: "http://a.test",
      addressSource: "wizard",
      keySource: "wizard",
      key: API_KEY,
      keySaved: true,
      verified: "ok",
      verifyKind: "ok",
      catalogModels: 2,
    })
    expect(update.keyHint).toBe(`(redacted, ${API_KEY.length} chars)`)
    expect(JSON.stringify(update)).not.toContain(API_KEY)
    expect(JSON.stringify(update)).not.toContain("sk-fake")
  })
})

describe("verifyConnection", () => {
  test("accepts a served directory and reports the model count", async () => {
    const mock = await startMockCpa({ models: [{ slug: "a" }, { slug: "b" }] })
    try {
      const result = await verifyConnection({ address: mock.url, apiKey: API_KEY })
      expect(result.ok).toBe(true)
      expect(result.kind).toBe("ok")
      expect(result.entries).toHaveLength(2)
      expect(mock.requests[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`)
    } finally {
      await mock.close()
    }
  })

  test("treats a served empty directory as a valid empty catalog", async () => {
    const mock = await startMockCpa({ models: [] })
    try {
      const result = await verifyConnection({ address: mock.url, apiKey: API_KEY })
      expect(result.ok).toBe(true)
      expect(result.kind).toBe("empty")
      expect(result.entries).toEqual([])
    } finally {
      await mock.close()
    }
  })

  test("separates an authentication failure from an unreachable deployment", async () => {
    const auth = await startMockCpa({ directory: { status: 401, body: { error: "bad key" } } })
    try {
      const result = await verifyConnection({ address: auth.url, apiKey: API_KEY })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe("auth")
    } finally {
      await auth.close()
    }

    const down = await startMockCpa({ directory: { status: 503, body: { error: "upstream down" } } })
    try {
      const result = await verifyConnection({ address: down.url, apiKey: API_KEY })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe("unreachable")
    } finally {
      await down.close()
    }

    const closed = await startMockCpa({ models: [] })
    const closedURL = closed.url
    await closed.close()
    const result = await verifyConnection({ address: closedURL, apiKey: API_KEY, timeoutMs: 500 })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("unreachable")
  })

  test("refuses a body that is not a catalog instead of calling it empty", async () => {
    const mock = await startMockCpa({ directory: { raw: "<html>proxy</html>", contentType: "text/html" } })
    try {
      const result = await verifyConnection({ address: mock.url, apiKey: API_KEY })
      expect(result.ok).toBe(false)
      expect(result.kind).toBe("format")
      expect(result.entries).toEqual([])
    } finally {
      await mock.close()
    }
  })

  test("reports an unusable address without a request", async () => {
    const result = await verifyConnection({ address: "ftp://cpa.test", apiKey: API_KEY })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("address")
    expect(result.message).toContain("http or https")
  })
})
