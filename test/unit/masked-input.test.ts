import { describe, expect, test } from "bun:test"
import { applyMaskedKey, maskedDisplay } from "../../src/masked-input"

describe("applyMaskedKey", () => {
  test("accumulates printable characters and paste sequences", () => {
    expect(applyMaskedKey("", { name: "s", sequence: "s" })).toEqual({ kind: "value", value: "s" })
    expect(applyMaskedKey("sk-", { name: "paste", sequence: "fake-key" })).toEqual({
      kind: "value",
      value: "sk-fake-key",
    })
  })

  test("edits with backspace and delete", () => {
    expect(applyMaskedKey("sk-f", { name: "backspace" })).toEqual({ kind: "value", value: "sk-" })
    expect(applyMaskedKey("sk-f", { name: "delete" })).toEqual({ kind: "value", value: "sk-" })
    expect(applyMaskedKey("", { name: "backspace" })).toEqual({ kind: "value", value: "" })
  })

  test("submits and cancels", () => {
    expect(applyMaskedKey("sk-fake", { name: "return" })).toEqual({ kind: "submit", value: "sk-fake" })
    expect(applyMaskedKey("sk-fake", { name: "enter" })).toEqual({ kind: "submit", value: "sk-fake" })
    expect(applyMaskedKey("sk-fake", { name: "escape" })).toEqual({ kind: "cancel" })
  })

  test("ignores modifiers and control characters", () => {
    expect(applyMaskedKey("sk-", { name: "c", sequence: "c", ctrl: true })).toEqual({ kind: "ignore" })
    expect(applyMaskedKey("sk-", { name: "x", sequence: "x", meta: true })).toEqual({ kind: "ignore" })
    expect(applyMaskedKey("sk-", { name: "tab", sequence: "\t" })).toEqual({ kind: "ignore" })
    expect(applyMaskedKey("sk-", { name: "up" })).toEqual({ kind: "ignore" })
  })
})

describe("maskedDisplay", () => {
  test("shows one bullet per character and never the key", () => {
    expect(maskedDisplay(0)).toBe("(typing is hidden)")
    expect(maskedDisplay(3)).toBe("\u2022\u2022\u2022")
    expect(maskedDisplay(0, "empty")).toBe("empty")
    expect(maskedDisplay(24)).not.toContain("s")
  })
})
