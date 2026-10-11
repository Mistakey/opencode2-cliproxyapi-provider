import { describe, expect, test } from "bun:test"
import { fastStorageKey, parseFastPreference, readFastPreference, writeFastPreference } from "../../src/fast"

describe("Fast preference", () => {
  test("defaults to off and reads a boolean or an enabled flag", () => {
    expect(parseFastPreference(undefined)).toBe(false)
    expect(parseFastPreference("yes")).toBe(false)
    expect(parseFastPreference(0)).toBe(false)
    expect(parseFastPreference(true)).toBe(true)
    expect(parseFastPreference(false)).toBe(false)
    expect(parseFastPreference({ enabled: true })).toBe(true)
    expect(parseFastPreference({ enabled: false })).toBe(false)
    expect(parseFastPreference({})).toBe(false)
  })

  test("scopes the durable key to the provider", () => {
    expect(fastStorageKey("cliproxyapi")).toBe("cliproxyapi.fast.cliproxyapi")
    expect(fastStorageKey("one")).not.toBe(fastStorageKey("two"))
  })

  test("round-trips through storage and stays off when the store is unreadable", async () => {
    const values = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: boolean) => {
        values.set(key, value)
      },
    }
    expect(await readFastPreference(storage, "k")).toBe(false)
    await writeFastPreference(storage, "k", true)
    expect(await readFastPreference(storage, "k")).toBe(true)
    await writeFastPreference(storage, "k", false)
    expect(await readFastPreference(storage, "k")).toBe(false)

    const broken = {
      get: async () => {
        throw new Error("storage down")
      },
      set: async () => undefined,
    }
    expect(await readFastPreference(broken, "k")).toBe(false)
  })
})
