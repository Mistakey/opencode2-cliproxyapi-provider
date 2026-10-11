/**
 * Host identification and capability checks.
 *
 * The plugin talks to OpenCode v2 only. It must refuse to load when the host is
 * outside the tested major line or does not expose the interfaces it registers
 * against, instead of failing later with an unclear runtime error.
 */

export const PLUGIN_ID = "opencode2-cliproxyapi-provider"
export const PLUGIN_NAME = "CLIProxyAPI"
export const PLUGIN_VERSION = "0.1.0"

/** Value sent as `client_version` when reading the CPA directory. */
export const CLIENT_VERSION = `${PLUGIN_ID}/${PLUGIN_VERSION}`

/** Host release this slice was verified against. */
export const TESTED_HOST_VERSION = "2.0.26"
/** Lowest host release with the interfaces used here. */
export const MIN_HOST_VERSION: readonly number[] = [2, 0, 26]
/** Exclusive upper bound of the supported host line. */
export const MAX_HOST_MAJOR = 3

export interface HostIssue {
  readonly code: "version" | "interface"
  readonly detail: string
}

export interface HostReport {
  readonly ok: boolean
  readonly issues: readonly HostIssue[]
}

/** Parse `2.0.26` / `v2.0.26-beta.1` into `[2, 0, 26]`; `undefined` when unparseable. */
export function parseVersion(value: unknown): number[] | undefined {
  if (typeof value !== "string") return undefined
  const match = /^v?(\d+(?:\.\d+)*)/.exec(value.trim())
  if (!match) return undefined
  return match[1].split(".").map((part) => Number.parseInt(part, 10))
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  const size = Math.max(left.length, right.length)
  for (let index = 0; index < size; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** `undefined` when supported, otherwise the reason the host version is refused. */
export function checkHostVersion(version: unknown): HostIssue | undefined {
  const parsed = parseVersion(version)
  if (!parsed) {
    return { code: "version", detail: `unreadable OpenCode version ${JSON.stringify(version)}` }
  }
  if (compareVersion(parsed, MIN_HOST_VERSION) < 0) {
    return {
      code: "version",
      detail: `OpenCode ${version} is older than the supported ${MIN_HOST_VERSION.join(".")}`,
    }
  }
  if ((parsed[0] ?? 0) >= MAX_HOST_MAJOR) {
    return {
      code: "version",
      detail: `OpenCode ${version} is outside the supported ${MIN_HOST_VERSION.join(".")} < v${MAX_HOST_MAJOR} line`,
    }
  }
  return undefined
}

function readPath(input: unknown, path: string): unknown {
  let current: unknown = input
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Interfaces this plugin registers against or reads during setup. */
export const REQUIRED_FUNCTIONS: readonly string[] = [
  "integration.transform",
  "integration.connect.key",
  "integration.connection.active",
  "integration.connection.resolve",
  "provider.transform",
]

/** Plain data the plugin reads during setup. */
export const REQUIRED_OBJECTS: readonly string[] = ["options"]

export function checkHostInterfaces(ctx: unknown): HostIssue[] {
  const issues: HostIssue[] = []
  for (const path of REQUIRED_FUNCTIONS) {
    if (typeof readPath(ctx, path) !== "function") {
      issues.push({ code: "interface", detail: `context.${path} is not a function` })
    }
  }
  for (const path of REQUIRED_OBJECTS) {
    const value = readPath(ctx, path)
    if (typeof value !== "object" || value === null) {
      issues.push({ code: "interface", detail: `context.${path} is not an object` })
    }
  }
  if (typeof readPath(ctx, "app.version") !== "string") {
    issues.push({ code: "interface", detail: "context.app.version is not a string" })
  }
  return issues
}

export function inspectHost(input: { version: unknown; ctx: unknown }): HostReport {
  const issues = checkHostInterfaces(input.ctx)
  const versionIssue = checkHostVersion(input.version)
  if (versionIssue) issues.unshift(versionIssue)
  return { ok: issues.length === 0, issues }
}

export function describeIssues(issues: readonly HostIssue[]): string {
  return issues.map((issue) => issue.detail).join("; ")
}
