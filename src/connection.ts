/**
 * CPA connection resolution.
 *
 * A connection is one address plus one API key. The key is always owned by
 * OpenCode: the plugin stores an explicitly configured key through the native
 * key method and reads it back from the active credential, so no plugin file
 * ever holds a secret and provider settings never carry one.
 */

import { Integration } from "@opencode/plugin"
import type { Credential } from "@opencode/plugin"
import { DEFAULT_BASE_URL } from "./address"

export const ENV_BASE_URL = "CLIPROXYAPI_BASE_URL"
export const ENV_API_KEY = "CLIPROXYAPI_API_KEY"

export const DEFAULT_PROVIDER_ID = "cliproxyapi"
export const DEFAULT_INTEGRATION_ID = "cliproxyapi"
export const RESPONSES_PACKAGE = "@opencode/ai/providers/openai-compatible/responses"

/** Where one half of a connection came from, highest precedence first. */
export type ConfigSource = "options" | "env" | "stored" | "default" | "wizard"

/** Which explicit source supplied each half of the configured pair. */
export interface ConfigSources {
  readonly baseURL?: "options" | "env"
  readonly apiKey?: "options" | "env"
}

export interface ExplicitConfig {
  readonly baseURL?: string
  readonly apiKey?: string
  readonly sources: ConfigSources
  readonly providerID: string
  readonly providerName: string
  readonly integrationID: Integration.ID
  readonly package: string
  readonly catalogTimeoutMs?: number
  /** Retention window for models missing from the directory; advanced/testing knob. */
  readonly catalogStaleTtlMs?: number
}

function optionString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function optionPositiveNumber(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key]
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read explicit, no-UI configuration: plugin options first, then environment. */
export function readExplicitConfig(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = process.env,
): ExplicitConfig {
  const opts = options ?? {}
  const envBaseURL = typeof env[ENV_BASE_URL] === "string" && env[ENV_BASE_URL]!.trim() ? env[ENV_BASE_URL]!.trim() : undefined
  const envApiKey = typeof env[ENV_API_KEY] === "string" && env[ENV_API_KEY]!.trim() ? env[ENV_API_KEY]!.trim() : undefined
  const optionBaseURL = optionString(opts, "baseURL")
  const optionApiKey = optionString(opts, "apiKey")
  const baseURL = optionBaseURL ?? envBaseURL
  const apiKey = optionApiKey ?? envApiKey
  return {
    baseURL,
    apiKey,
    sources: {
      ...(baseURL !== undefined ? { baseURL: optionBaseURL !== undefined ? "options" : "env" } : {}),
      ...(apiKey !== undefined ? { apiKey: optionApiKey !== undefined ? "options" : "env" } : {}),
    } as ConfigSources,
    providerID: optionString(opts, "providerID") ?? DEFAULT_PROVIDER_ID,
    providerName: optionString(opts, "providerName") ?? "CLIProxyAPI",
    integrationID: Integration.ID.make(optionString(opts, "integrationID") ?? DEFAULT_INTEGRATION_ID),
    package: optionString(opts, "package") ?? RESPONSES_PACKAGE,
    catalogTimeoutMs: optionPositiveNumber(opts, "catalogTimeoutMs"),
    catalogStaleTtlMs: optionPositiveNumber(opts, "catalogStaleTtlMs"),
  }
}

export interface ResolvedCredential<Connection = unknown> {
  readonly connection: Connection
  readonly key: string
  /** Address stored beside the key, when the connection carried one. */
  readonly baseURL?: string
}

/** Read the key and stored address of an already resolved credential. */
export function readCredential<Connection>(
  connection: Connection,
  credential: Credential.Value | undefined,
): ResolvedCredential<Connection> | undefined {
  if (!credential || credential.type !== "key") return undefined
  const key = credential.key.trim()
  if (!key) return undefined
  const configured = credential.configuration?.baseURL
  const baseURL = typeof configured === "string" && configured.trim() ? configured.trim() : undefined
  return { connection, key, baseURL }
}

export interface ConnectionPlan {
  /** Explicit configuration, or the stored connection when nothing is configured. */
  readonly mode: "explicit" | "connection"
  readonly key: string
  /** Address to use, before normalization. */
  readonly address: string
  /** Whether the explicit pair must be written to the native credential store. */
  readonly store: boolean
  /** Where the effective address came from, so the active source is never implicit. */
  readonly addressSource: ConfigSource
  /** Where the effective key came from. */
  readonly keySource: ConfigSource
}

export type ConnectionPlanResult = { ok: true; plan: ConnectionPlan } | { ok: false; reason: string }

/**
 * Decide which address and key to use.
 *
 * An explicitly configured address or key always wins, so an environment
 * variable can never be silently mixed with an unrelated stored connection. The
 * stored address only fills a gap an explicit configuration leaves open.
 */
export function planConnection(input: {
  explicit: Pick<ExplicitConfig, "baseURL" | "apiKey"> & { sources?: ConfigSources }
  active?: ResolvedCredential<unknown>
}): ConnectionPlanResult {
  const { explicit, active } = input
  const sources = explicit.sources ?? {}
  const hasExplicit = explicit.baseURL !== undefined || explicit.apiKey !== undefined

  if (!hasExplicit) {
    if (!active) {
      return { ok: false, reason: `no CPA API key configured; set ${ENV_API_KEY} or connect CLIProxyAPI` }
    }
    if (!active.baseURL) {
      return { ok: false, reason: "stored CPA connection has no address; configure baseURL or connect again" }
    }
    return {
      ok: true,
      plan: {
        mode: "connection",
        key: active.key,
        address: active.baseURL,
        store: false,
        addressSource: "stored",
        keySource: "stored",
      },
    }
  }

  // A configured address with no key anywhere is a partial configuration: it is
  // refused rather than completed from an unrelated source. A configured key
  // without an address keeps the stored address when there is one, and is
  // otherwise reported as the default address.
  const key = explicit.apiKey ?? active?.key
  if (!key) {
    return { ok: false, reason: `CPA address is configured without an API key; set ${ENV_API_KEY}` }
  }
  const keySource: ConfigSource = explicit.apiKey !== undefined ? (sources.apiKey ?? "options") : "stored"
  const addressSource: ConfigSource =
    explicit.baseURL !== undefined ? (sources.baseURL ?? "options") : active?.baseURL ? "stored" : "default"
  const address = explicit.baseURL ?? active?.baseURL ?? DEFAULT_BASE_URL
  const store =
    keySource !== "stored" && (active === undefined || active.key !== key || active.baseURL !== address)
  return { ok: true, plan: { mode: "explicit", key, address, store, addressSource, keySource } }
}

/** Never render a key: logs and errors may only carry its length. */
export function redactKey(key: string | undefined): string {
  if (!key) return "(none)"
  return `(redacted, ${key.length} chars)`
}
