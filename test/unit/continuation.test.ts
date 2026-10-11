import { describe, expect, test } from "bun:test"
import { SOCKET_HEADER, ContinuationReset } from "../../src/continuation"

describe("ContinuationReset", () => {
  test("keeps one socket generation across ordinary turns", () => {
    const reset = new ContinuationReset()
    expect(reset.socketGeneration("ses_1")).toBe("0")
    expect(reset.socketGeneration("ses_1")).toBe("0")
  })

  test("advances the generation once after a summary", () => {
    const reset = new ContinuationReset()
    reset.socketGeneration("ses_1")
    reset.markCompacted("ses_1")
    expect(reset.socketGeneration("ses_1")).toBe("1")
    // Only the first handshake after the summary gets the new socket.
    expect(reset.socketGeneration("ses_1")).toBe("1")
    expect(reset.socketGeneration("ses_1")).toBe("1")
  })

  test("a second summary advances again", () => {
    const reset = new ContinuationReset()
    reset.markCompacted("ses_1")
    expect(reset.socketGeneration("ses_1")).toBe("1")
    reset.markCompacted("ses_1")
    expect(reset.socketGeneration("ses_1")).toBe("2")
  })

  test("keeps sessions independent", () => {
    const reset = new ContinuationReset()
    reset.markCompacted("ses_1")
    expect(reset.socketGeneration("ses_2")).toBe("0")
    expect(reset.socketGeneration("ses_1")).toBe("1")
  })

  test("forget drops a pending summary without moving the generation", () => {
    const reset = new ContinuationReset()
    reset.markCompacted("ses_1")
    reset.forget("ses_1")
    expect(reset.socketGeneration("ses_1")).toBe("0")
  })

  test("uses a plugin-owned header name", () => {
    expect(SOCKET_HEADER).toBe("x-oc2cpa-socket")
  })
})
