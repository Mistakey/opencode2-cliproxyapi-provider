import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../src/catalog"
import {
  HTTP_RUNTIME_PACKAGE,
  WEBSOCKET_RUNTIME_PACKAGE,
  directoryPrefersWebSocket,
  planCompaction,
  planTransport,
  readCompactionPreference,
  readTransportPreference,
} from "../../src/transport"

const entry = (input: Partial<CatalogEntry> & { id: string }): CatalogEntry => input

const plan = (input: {
  preference: "auto" | "http" | "websocket"
  directoryPrefersWebSocket: boolean
  websocketPackage?: string
  invalidPreference?: string
}) =>
  planTransport({
    preference: input.preference,
    directoryPrefersWebSocket: input.directoryPrefersWebSocket,
    httpPackage: HTTP_RUNTIME_PACKAGE,
    websocketPackage: input.websocketPackage ?? WEBSOCKET_RUNTIME_PACKAGE,
    ...(input.invalidPreference !== undefined ? { invalidPreference: input.invalidPreference } : {}),
  })

describe("readTransportPreference", () => {
  test("defaults to auto and accepts the documented values", () => {
    expect(readTransportPreference(undefined)).toEqual({ preference: "auto" })
    expect(readTransportPreference({})).toEqual({ preference: "auto" })
    expect(readTransportPreference({ transport: "auto" })).toEqual({ preference: "auto" })
    expect(readTransportPreference({ transport: "http" })).toEqual({ preference: "http" })
    expect(readTransportPreference({ transport: "websocket" })).toEqual({ preference: "websocket" })
  })

  test("refuses an unknown value instead of treating it as a preference", () => {
    const result = readTransportPreference({ transport: "ws" })
    expect(result.preference).toBe("auto")
    expect(result.invalid).toContain("transport must be one of")
    expect(readTransportPreference({ transport: 3 }).invalid).toContain("transport must be one of")
  })
})

describe("directoryPrefersWebSocket", () => {
  test("is true only for a visible model that declares it", () => {
    expect(directoryPrefersWebSocket([entry({ id: "a" })])).toBe(false)
    expect(directoryPrefersWebSocket([entry({ id: "a", preferWebsockets: false })])).toBe(false)
    expect(directoryPrefersWebSocket([entry({ id: "a", preferWebsockets: true })])).toBe(true)
    expect(directoryPrefersWebSocket([entry({ id: "a", preferWebsockets: true, hidden: true })])).toBe(false)
    expect(
      directoryPrefersWebSocket([entry({ id: "hidden", preferWebsockets: true, hidden: true }), entry({ id: "b" })]),
    ).toBe(false)
  })
})

describe("planTransport", () => {
  test("auto selects WebSocket from the directory preference", () => {
    const policy = plan({ preference: "auto", directoryPrefersWebSocket: true })
    expect(policy.transport).toBe("websocket")
    expect(policy.package).toBe(WEBSOCKET_RUNTIME_PACKAGE)
    expect(policy.source).toBe("directory")
    expect(policy.note).toBeUndefined()
  })

  test("auto stays on HTTP without a directory preference", () => {
    const policy = plan({ preference: "auto", directoryPrefersWebSocket: false })
    expect(policy.transport).toBe("http")
    expect(policy.package).toBe(HTTP_RUNTIME_PACKAGE)
    expect(policy.source).toBe("default")
  })

  test("auto does not take an unconfirmed WebSocket package", () => {
    const policy = plan({
      preference: "auto",
      directoryPrefersWebSocket: true,
      websocketPackage: "@example/custom-responses",
    })
    expect(policy.transport).toBe("http")
    expect(policy.package).toBe(HTTP_RUNTIME_PACKAGE)
    expect(policy.note).toContain("not a confirmed WebSocket runtime")
  })

  test("a forced HTTP wins over the directory preference", () => {
    const policy = plan({ preference: "http", directoryPrefersWebSocket: true })
    expect(policy.transport).toBe("http")
    expect(policy.package).toBe(HTTP_RUNTIME_PACKAGE)
    expect(policy.source).toBe("option")
  })

  test("a forced WebSocket is kept even when the package is HTTP-only, with a diagnostic", () => {
    const policy = plan({
      preference: "websocket",
      directoryPrefersWebSocket: false,
      websocketPackage: HTTP_RUNTIME_PACKAGE,
    })
    expect(policy.transport).toBe("websocket")
    expect(policy.package).toBe(HTTP_RUNTIME_PACKAGE)
    expect(policy.source).toBe("option")
    expect(policy.note).toContain("has no WebSocket channel")
    expect(policy.note).toContain(WEBSOCKET_RUNTIME_PACKAGE)
  })

  test("an unconfirmed forced package carries a note but not a downgrade", () => {
    const policy = plan({
      preference: "websocket",
      directoryPrefersWebSocket: false,
      websocketPackage: "@example/custom-responses",
    })
    expect(policy.transport).toBe("websocket")
    expect(policy.note).toContain("cannot confirm")
  })

  test("an invalid preference is reported and behaves as auto", () => {
    const policy = plan({
      preference: "auto",
      directoryPrefersWebSocket: false,
      invalidPreference: "transport must be one of auto, http, websocket; got \"ws\"",
    })
    expect(policy.transport).toBe("http")
    expect(policy.note).toContain("falling back to auto")
  })
})

describe("readCompactionPreference", () => {
  test("defaults to summary and accepts native", () => {
    expect(readCompactionPreference(undefined)).toEqual({ preference: "summary" })
    expect(readCompactionPreference({})).toEqual({ preference: "summary" })
    expect(readCompactionPreference({ compaction: "summary" })).toEqual({ preference: "summary" })
    expect(readCompactionPreference({ compaction: "native" })).toEqual({ preference: "native" })
  })

  test("refuses an unknown value", () => {
    const result = readCompactionPreference({ compaction: "auto" })
    expect(result.preference).toBe("summary")
    expect(result.invalid).toContain("compaction must be one of")
  })
})

describe("planCompaction", () => {
  test("summary is the default and never carries a note", () => {
    expect(planCompaction({ preference: "summary", package: WEBSOCKET_RUNTIME_PACKAGE })).toEqual({
      preference: "summary",
      type: "summary",
    })
  })

  test("native is declared for the runtime package that exposes a compaction endpoint", () => {
    const policy = planCompaction({ preference: "native", package: WEBSOCKET_RUNTIME_PACKAGE })
    expect(policy.type).toBe("native")
    expect(policy.note).toBeUndefined()
  })

  test("native against an HTTP-only package keeps summary and says why", () => {
    const policy = planCompaction({ preference: "native", package: HTTP_RUNTIME_PACKAGE })
    expect(policy.type).toBe("summary")
    expect(policy.preference).toBe("native")
    expect(policy.note).toContain("exposes no compaction endpoint")
  })

  test("an invalid compaction value keeps summary with a note", () => {
    const policy = planCompaction({
      preference: "summary",
      package: WEBSOCKET_RUNTIME_PACKAGE,
      invalidPreference: "compaction must be one of summary, native; got \"auto\"",
    })
    expect(policy.type).toBe("summary")
    expect(policy.note).toContain("keeping summary")
  })
})
