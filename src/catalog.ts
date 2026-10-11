/**
 * CPA enhanced directory parsing and OpenCode model mapping.
 *
 * The directory is the primary capability source. A missing field is treated as
 * unknown, never as proven support: limits fall back to conservative values and
 * image input is only declared when the directory says so.
 */

import { Model, Provider } from "@opencode/plugin"

/** Conservative fallback used when the directory reports no context window. */
export const DEFAULT_CONTEXT_WINDOW = 128_000
/** Conservative fallback used when the directory reports no output limit. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
/** The service tier a Fast-capable model is asked for. */
export const FAST_SERVICE_TIER = "priority"

export class CatalogError extends Error {
  readonly kind: "http" | "format"
  readonly status?: number

  constructor(kind: "http" | "format", message: string, status?: number) {
    super(message)
    this.name = "CatalogError"
    this.kind = kind
    this.status = status
  }
}

export interface CatalogEntry {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly inputModalities?: readonly string[]
  readonly reasoningLevels?: readonly string[]
  /** Declared service tiers; a non-empty list is the Fast capability signal. */
  readonly serviceTiers?: readonly string[]
  readonly hidden?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = positiveNumber(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/** `input_modalities`-style lists: keep only what OpenCode can map, text first. */
function normalizeModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const modalities: string[] = []
  for (const item of value) {
    const normalized = nonEmptyString(item)?.toLowerCase()
    if ((normalized === "text" || normalized === "image") && !modalities.includes(normalized)) {
      modalities.push(normalized)
    }
  }
  if (modalities.length === 0) return undefined
  if (!modalities.includes("text")) modalities.unshift("text")
  return modalities
}

/** `supported_reasoning_levels`: `"high"` or `{ effort: "high" }`. */
function normalizeReasoningLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const levels: string[] = []
  for (const item of value) {
    const raw = isRecord(item) ? item.effort : item
    const level = nonEmptyString(raw)?.toLowerCase()
    if (level && !levels.includes(level)) levels.push(level)
  }
  return levels.length > 0 ? levels : undefined
}

/**
 * `service_tiers`: `"priority"` or `{ id: "priority" }`. `additional_speed_tiers`
 * is a different field and is deliberately not read as a capability signal.
 */
function normalizeServiceTiers(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tiers: string[] = []
  for (const item of value) {
    const raw = isRecord(item) ? (item.id ?? item.name) : item
    const tier = nonEmptyString(raw)?.toLowerCase()
    if (tier && !tiers.includes(tier)) tiers.push(tier)
  }
  return tiers.length > 0 ? tiers : undefined
}

function parseEntry(value: unknown): CatalogEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = nonEmptyString(value.slug) ?? nonEmptyString(value.id)
  if (!id) return undefined
  const visibility = nonEmptyString(value.visibility)?.toLowerCase()
  return {
    id,
    name: nonEmptyString(value.display_name) ?? nonEmptyString(value.name),
    contextWindow: firstPositive(value.context_window, value.max_context_window),
    maxOutputTokens: firstPositive(value.max_tokens, value.max_output_tokens, value.max_completion_tokens),
    inputModalities: normalizeModalities(value.input_modalities),
    reasoningLevels: normalizeReasoningLevels(value.supported_reasoning_levels),
    serviceTiers: normalizeServiceTiers(value.service_tiers),
    hidden: visibility === "hide",
  }
}

/**
 * Parse a directory payload.
 *
 * Accepts the CPA enhanced envelope (`{ models: [...] }`) and the plain OpenAI
 * listing (`{ data: [...] }`). Anything else is a format error: a broken or
 * unrelated response must never be published as an empty catalog.
 */
export function parseCatalogPayload(payload: unknown): CatalogEntry[] {
  if (!isRecord(payload)) {
    throw new CatalogError("format", "directory response is not a JSON object")
  }
  const list = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : undefined
  if (!list) {
    throw new CatalogError("format", "directory response has neither a models nor a data array")
  }

  const entries: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const entry = parseEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

export interface FetchCatalogInput {
  readonly modelsURL: string
  readonly apiKey: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

export const DEFAULT_CATALOG_TIMEOUT_MS = 10_000

/** Read and parse the directory. Throws `CatalogError` for transport, HTTP and format failures. */
export async function fetchCatalog(input: FetchCatalogInput): Promise<CatalogEntry[]> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const doFetch = input.fetchImpl ?? fetch

  let response: Response
  try {
    response = await doFetch(input.modelsURL, {
      headers: { authorization: `Bearer ${input.apiKey}`, accept: "application/json" },
      signal,
    })
  } catch (error) {
    throw new CatalogError("http", `directory request failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) {
    throw new CatalogError("http", `directory request failed with ${response.status}`, response.status)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new CatalogError("format", `directory response is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  return parseCatalogPayload(payload)
}

function resolveLimit(entry: CatalogEntry): Model.Info["limit"] {
  const context = entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const requestedOutput = entry.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  return { context, output: Math.min(requestedOutput, context) }
}

/**
 * The directory's declared Fast capability. A non-empty `service_tiers` is the
 * signal the official plugin uses; it describes the reference implementation,
 * not a guarantee that the server honours priority.
 */
export function supportsFastServiceTier(entry: Pick<CatalogEntry, "serviceTiers">): boolean {
  return (entry.serviceTiers?.length ?? 0) > 0
}

/** How many of these entries actually receive the priority parameter under this preference. */
export function fastEffectiveCount(entries: readonly CatalogEntry[], fast: boolean): number {
  return fast ? entries.filter(supportsFastServiceTier).length : 0
}

export interface ModelMappingOptions {
  /** Apply the Fast preference; only a declared-capable model receives the parameter. */
  readonly fast?: boolean
  /** Price estimate for one entry, already matched for the Fast preference. */
  readonly cost?: (entry: CatalogEntry) => Model.Info["cost"] | undefined
}

/** Map one directory entry onto an OpenCode model definition. */
export function toModelInfo(
  providerID: Provider.ID,
  entry: CatalogEntry,
  options: ModelMappingOptions = {},
): Model.Info {
  const modelID = Model.ID.make(entry.id)
  const defaults = Model.Info.default(providerID, modelID)
  const levels = entry.reasoningLevels ?? []
  const fast = options.fast === true && supportsFastServiceTier(entry)
  const cost = options.cost?.(entry)
  return {
    ...defaults,
    modelID,
    name: entry.name ?? entry.id,
    capabilities: {
      tools: true,
      input: entry.inputModalities ?? ["text"],
      output: ["text"],
    },
    variants: levels.map((level) => ({
      id: Model.VariantID.make(level),
      settings: { reasoningEffort: level },
    })),
    // Fast is the v2 semantic parameter; the runtime maps it to `service_tier`.
    ...(fast ? { settings: { serviceTier: FAST_SERVICE_TIER } } : {}),
    ...(cost && cost.length > 0 ? { cost } : {}),
    limit: resolveLimit(entry),
    enabled: entry.hidden !== true,
  }
}

export function toModelInfos(
  providerID: Provider.ID,
  entries: readonly CatalogEntry[],
  options: ModelMappingOptions = {},
): Model.Info[] {
  return entries.map((entry) => toModelInfo(providerID, entry, options))
}
