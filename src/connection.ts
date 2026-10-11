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
import { DEFAULT_BASE_URL, resolveEndpoints } from "./address"
import { WEBSOCKET_RUNTIME_PACKAGE, readCompactionPreference, readTransportPreference, type CompactionPreference, type TransportPreference } from "./transport"

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
  readonly websocketPackage: string
  readonly transport: TransportPreference
  /** Set when the configured `transport` value was not accepted. */
  readonly transportInvalid?: string
  readonly compaction: CompactionPreference
  /** Set when the configured `compaction` value was not accepted. */
  readonly compactionInvalid?: string
  readonly catalogTimeoutMs?: number
  /** Retention window for models missing from the directory; advanced/testing knob. */
  readonly catalogStaleTtlMs?: number
  /** Price estimate source; `false` disables the models.dev lookup. */
  readonly modelsDev?: boolean
  readonly modelsDevURL?: string
  readonly modelsDevTimeoutMs?: number
}

function optionString(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function optionPositiveNumber(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key]
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function optionBoolean(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key]
  return typeof value === "boolean" ? value : undefined
}

/**
 * Pair the explicit address and key across plugin options and the environment.
 *
 * The address wins its key: a key is only taken from the other source when that
 * source does not configure a different address. That keeps the documented
 * per-field precedence (an option address with an environment key is fine when
 * the environment has no address of its own) while refusing to pair an address
 * with a key that was configured for another address.
 */
function pairExplicit(input: {
  optionBaseURL?: string
  optionApiKey?: string
  envBaseURL?: string
  envApiKey?: string
}): { baseURL?: string; apiKey?: string; sources: ConfigSources } {
  const { optionBaseURL, optionApiKey, envBaseURL, envApiKey } = input
  const baseURL = optionBaseURL ?? envBaseURL
  const addressSource: ConfigSource | undefined =
    baseURL === undefined ? undefined : optionBaseURL !== undefined ? "options" : "env"
  let apiKey: string | undefined
  let keySource: ConfigSource | undefined
  if (addressSource === "options") {
    if (optionApiKey !== undefined) {
      apiKey = optionApiKey
      keySource = "options"
    } else if (envApiKey !== undefined && (envBaseURL === undefined || sameAddress(envBaseURL, optionBaseURL!))) {
      apiKey = envApiKey
      keySource = "env"
    }
  } else if (addressSource === "env") {
    if (envApiKey !== undefined) {
      apiKey = envApiKey
      keySource = "env"
    } else if (optionApiKey !== undefined) {
      apiKey = optionApiKey
      keySource = "options"
    }
  } else if (optionApiKey !== undefined) {
    apiKey = optionApiKey
    keySource = "options"
  } else if (envApiKey !== undefined) {
    apiKey = envApiKey
    keySource = "env"
  }
  return {
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    sources: {
      ...(addressSource !== undefined ? { baseURL: addressSource } : {}),
      ...(keySource !== undefined ? { apiKey: keySource } : {}),
    } as ConfigSources,
  }
}

/** Read explicit, no-UI configuration: plugin options first, then environment. */
export function readExplicitConfig(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = process.env,
): ExplicitConfig {
  const opts = options ?? {}
  const envBaseURL = typeof env[ENV_BASE_URL] === "string" && env[ENV_BASE_URL]!.trim() ? env[ENV_BASE_URL]!.trim() : undefined
  const envApiKey = typeof env[ENV_API_KEY] === "string" && env[ENV_API_KEY]!.trim() ? env[ENV_API_KEY]!.trim() : undefined
  const pair = pairExplicit({
    optionBaseURL: optionString(opts, "baseURL"),
    optionApiKey: optionString(opts, "apiKey"),
    ...(envBaseURL !== undefined ? { envBaseURL } : {}),
    ...(envApiKey !== undefined ? { envApiKey } : {}),
  })
  const transport = readTransportPreference(opts)
  const compaction = readCompactionPreference(opts)
  return {
    baseURL: pair.baseURL,
    apiKey: pair.apiKey,
    sources: pair.sources,
    providerID: optionString(opts, "providerID") ?? DEFAULT_PROVIDER_ID,
    providerName: optionString(opts, "providerName") ?? "CLIProxyAPI",
    integrationID: Integration.ID.make(optionString(opts, "integrationID") ?? DEFAULT_INTEGRATION_ID),
    package: optionString(opts, "package") ?? RESPONSES_PACKAGE,
    websocketPackage: optionString(opts, "websocketPackage") ?? WEBSOCKET_RUNTIME_PACKAGE,
    transport: transport.preference,
    ...(transport.invalid !== undefined ? { transportInvalid: transport.invalid } : {}),
    compaction: compaction.preference,
    ...(compaction.invalid !== undefined ? { compactionInvalid: compaction.invalid } : {}),
    catalogTimeoutMs: optionPositiveNumber(opts, "catalogTimeoutMs"),
    catalogStaleTtlMs: optionPositiveNumber(opts, "catalogStaleTtlMs"),
    modelsDev: optionBoolean(opts, "modelsDev"),
    modelsDevURL: optionString(opts, "modelsDevURL"),
    modelsDevTimeoutMs: optionPositiveNumber(opts, "modelsDevTimeoutMs"),
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
 * Whether two configured addresses denote the same CPA connection endpoint.
 *
 * A stored credential carries the address it was saved with. Borrowing its key
 * for a different explicit address would send that key to an address it was
 * never configured for, so the two must be compared after normalization.
 */
function sameAddress(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true
  try {
    return resolveEndpoints(left).baseURL === resolveEndpoints(right).baseURL
  } catch {
    return false
  }
}

/**
 * Decide which address and key to use.
 *
 * A connection is a pair. An explicit address or key always wins, but the stored
 * credential may only supply the half an explicit configuration leaves open when
 * it belongs to the same address; a stored key is never lent to a different
 * address. The stored address only fills the gap an explicit key leaves open.
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

  // A configured address with no configured key is completed only from a stored
  // credential saved for that same address. Anything else is a partial
  // configuration and is refused rather than paired with an unrelated key.
  if (explicit.baseURL !== undefined && explicit.apiKey === undefined) {
    if (!active || !active.baseURL || !sameAddress(explicit.baseURL, active.baseURL)) {
      return { ok: false, reason: `CPA address is configured without an API key; set ${ENV_API_KEY}` }
    }
    return {
      ok: true,
      plan: {
        mode: "explicit",
        key: active.key,
        address: explicit.baseURL,
        store: false,
        addressSource: sources.baseURL ?? "options",
        keySource: "stored",
      },
    }
  }

  // A configured key with no configured address keeps the stored address when
  // there is one, and otherwise reports the default address.
  const key = explicit.apiKey ?? active?.key
  if (!key) {
    return { ok: false, reason: `no CPA API key configured; set ${ENV_API_KEY} or connect CLIProxyAPI` }
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
