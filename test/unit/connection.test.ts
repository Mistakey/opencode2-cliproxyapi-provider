import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PROVIDER_ID,
  ENV_API_KEY,
  ENV_BASE_URL,
  RESPONSES_PACKAGE,
  planConnection,
  readCredential,
  readExplicitConfig,
  redactKey,
} from "../../src/connection"
import { DEFAULT_BASE_URL } from "../../src/address"

describe("readExplicitConfig", () => {
  test("prefers plugin options over the environment", () => {
    const config = readExplicitConfig(
      { baseURL: "http://option.test", apiKey: "option-key", providerID: "acme", providerName: "Acme" },
      { [ENV_BASE_URL]: "http://env.test", [ENV_API_KEY]: "env-key" },
    )
    expect(config).toMatchObject({
      baseURL: "http://option.test",
      apiKey: "option-key",
      providerID: "acme",
      providerName: "Acme",
      package: RESPONSES_PACKAGE,
    })
  })

  test("falls back to the environment and to documented defaults", () => {
    const fromEnv = readExplicitConfig({}, { [ENV_BASE_URL]: "http://env.test", [ENV_API_KEY]: "env-key" })
    expect(fromEnv.baseURL).toBe("http://env.test")
    expect(fromEnv.apiKey).toBe("env-key")
    expect(fromEnv.providerID).toBe(DEFAULT_PROVIDER_ID)

    const empty = readExplicitConfig(undefined, {})
    expect(empty.baseURL).toBeUndefined()
    expect(empty.apiKey).toBeUndefined()
    expect(empty.providerName).toBe("CLIProxyAPI")
  })

  test("ignores blank option values", () => {
    expect(readExplicitConfig({ apiKey: "   " }, {}).apiKey).toBeUndefined()
  })
})

describe("planConnection", () => {
  const active = { connection: { type: "credential" as const, id: "cred_1" }, key: "stored-key", baseURL: "http://stored.test" }

  test("uses the stored connection when nothing is configured", () => {
    const result = planConnection({ explicit: {}, active })
    expect(result).toEqual({
      ok: true,
      plan: { mode: "connection", key: "stored-key", address: "http://stored.test", store: false },
    })
  })

  test("refuses to run without any key", () => {
    const result = planConnection({ explicit: {} })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain(ENV_API_KEY)
  })

  test("stores a new explicit pair once", () => {
    const result = planConnection({ explicit: { baseURL: "http://new.test", apiKey: "new-key" }, active })
    expect(result).toEqual({
      ok: true,
      plan: { mode: "explicit", key: "new-key", address: "http://new.test", store: true },
    })
  })

  test("reuses an identical explicit pair without writing another credential", () => {
    const result = planConnection({ explicit: { baseURL: "http://stored.test", apiKey: "stored-key" }, active })
    expect(result).toEqual({
      ok: true,
      plan: { mode: "explicit", key: "stored-key", address: "http://stored.test", store: false },
    })
  })

  test("rewrites the stored address when the explicit address changed", () => {
    const result = planConnection({ explicit: { baseURL: "http://moved.test", apiKey: "stored-key" }, active })
    expect(result.ok === true && result.plan.store).toBe(true)
  })

  test("uses the stored key for an address-only override", () => {
    const result = planConnection({ explicit: { baseURL: "http://override.test" }, active })
    expect(result).toEqual({
      ok: true,
      plan: { mode: "explicit", key: "stored-key", address: "http://override.test", store: false },
    })
  })

  test("refuses an address without any key to pair it with", () => {
    const result = planConnection({ explicit: { baseURL: "http://override.test" } })
    expect(result.ok).toBe(false)
  })

  test("falls back to the documented default address only in explicit mode", () => {
    const result = planConnection({ explicit: { apiKey: "fresh-key" } })
    expect(result.ok === true && result.plan.address).toBe(DEFAULT_BASE_URL)
  })
})

describe("readCredential", () => {
  test("reads a key credential and its stored address", () => {
    const resolved = readCredential({ type: "credential", id: "cred_1" }, {
      type: "key",
      key: "sk-fake",
      configuration: { baseURL: "http://stored.test" },
    })
    expect(resolved).toEqual({
      connection: { type: "credential", id: "cred_1" },
      key: "sk-fake",
      baseURL: "http://stored.test",
    })
  })

  test("ignores oauth credentials and blank keys", () => {
    expect(readCredential({}, { type: "oauth" } as never)).toBeUndefined()
    expect(readCredential({}, { type: "key", key: "  " })).toBeUndefined()
  })
})

describe("redactKey", () => {
  test("never renders the key itself", () => {
    expect(redactKey("sk-fake-secret")).toBe("(redacted, 14 chars)")
    expect(redactKey(undefined)).toBe("(none)")
  })
})
