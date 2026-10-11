import { describe, expect, test } from "bun:test"
import {
  MAX_HOST_MAJOR,
  MIN_HOST_VERSION,
  REQUIRED_FUNCTIONS,
  TESTED_HOST_VERSION,
  checkHostInterfaces,
  checkHostVersion,
  inspectHost,
  parseVersion,
} from "../../src/host"

function completeContext(): Record<string, unknown> {
  const fn = () => undefined
  return {
    app: { version: TESTED_HOST_VERSION },
    options: {},
    integration: {
      transform: fn,
      connect: { key: fn },
      connection: { active: fn, resolve: fn },
    },
    provider: { transform: fn },
    rpc: { register: fn },
    session: { hook: fn },
    storage: { get: fn, set: fn, remove: fn },
    event: { subscribe: fn },
  }
}

describe("parseVersion", () => {
  test("reads dotted versions with an optional prefix", () => {
    expect(parseVersion("2.0.26")).toEqual([2, 0, 26])
    expect(parseVersion("v2.0.26-beta.1")).toEqual([2, 0, 26])
    expect(parseVersion("latest")).toBeUndefined()
    expect(parseVersion(undefined)).toBeUndefined()
  })
})

describe("checkHostVersion", () => {
  test("accepts the tested release", () => {
    expect(checkHostVersion(TESTED_HOST_VERSION)).toBeUndefined()
  })

  test("rejects older, newer-major and unreadable versions", () => {
    expect(checkHostVersion("2.0.25")?.code).toBe("version")
    expect(checkHostVersion("1.18.29")?.code).toBe("version")
    expect(checkHostVersion(`${MAX_HOST_MAJOR}.0.0`)?.code).toBe("version")
    expect(checkHostVersion("nonsense")?.code).toBe("version")
  })

  test("keeps the minimum version next to the tested one", () => {
    expect(MIN_HOST_VERSION.join(".")).toBe(TESTED_HOST_VERSION)
  })
})

describe("checkHostInterfaces", () => {
  test("accepts a complete context", () => {
    expect(checkHostInterfaces(completeContext())).toEqual([])
  })

  test("names every missing interface", () => {
    for (const path of REQUIRED_FUNCTIONS) {
      const ctx = completeContext()
      const keys = path.split(".")
      let cursor = ctx as Record<string, unknown>
      for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>
      delete cursor[keys[keys.length - 1] as string]
      const issues = checkHostInterfaces(ctx)
      expect(issues.map((issue) => issue.detail)).toContain(`context.${path} is not a function`)
    }
  })

  test("reports a missing app version and missing options", () => {
    const ctx = completeContext()
    delete ctx.app
    expect(checkHostInterfaces(ctx).map((issue) => issue.detail)).toContain("context.app.version is not a string")

    const withoutOptions = completeContext()
    delete withoutOptions.options
    expect(checkHostInterfaces(withoutOptions).map((issue) => issue.detail)).toContain("context.options is not an object")
  })
})

describe("inspectHost", () => {
  test("reports version and interface issues together", () => {
    const ctx = completeContext()
    delete (ctx as { provider?: unknown }).provider
    const report = inspectHost({ version: "1.0.0", ctx })
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toEqual(["version", "interface"])
  })

  test("accepts the tested host", () => {
    expect(inspectHost({ version: TESTED_HOST_VERSION, ctx: completeContext() })).toEqual({ ok: true, issues: [] })
  })
})
