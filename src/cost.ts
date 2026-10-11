/**
 * models.dev price matching.
 *
 * Prices are an estimate taken from the public models.dev catalog, not CPA
 * billing. The matching rules are the ones the official Pi plugin uses: an
 * explicit alias table, namespace stripping, a normalized fallback key, a
 * provider preference when several resellers publish the same model, and no
 * arbitrary pick when the remaining prices disagree.
 *
 * A missing Fast price keeps the standard rate instead of inventing a
 * multiplier, and an unknown model has no cost at all.
 */

import type { Model } from "@opencode/plugin"

/** Rates in USD per million tokens. */
export interface CostRates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** A context-tiered rate; applies once input-side usage exceeds the threshold. */
export interface CostTier extends CostRates {
  readonly inputTokensAbove: number
}

export interface ModelCost extends CostRates {
  readonly tiers?: readonly CostTier[]
}

export interface ModelsDevCostEntry {
  readonly providerId: string
  readonly modelId: string
  readonly standard: ModelCost
  /** Published Fast-mode price; absent when models.dev does not list one. */
  readonly fast?: ModelCost
}

export interface ModelsDevCatalog {
  readonly exact: ReadonlyMap<string, readonly ModelsDevCostEntry[]>
  readonly normalized: ReadonlyMap<string, readonly ModelsDevCostEntry[]>
}

/**
 * Explicit aliases for proxy-specific model ids whose billable base model is
 * known. Kept identical to the official Pi plugin's table.
 */
const MODEL_PRICE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "gemini-pro-agent": ["gemini-3.1-pro-preview"],
  "gemini-3.1-pro-low": ["gemini-3.1-pro-preview"],
  "gemini-3.6-flash-high": ["gemini-3.6-flash"],
  "gemini-3-flash-agent": ["gemini-3.5-flash"],
  "grok-composer-2.5-fast": ["grok-4.3"],
  "grok-3-mini": ["xai/grok-3-mini"],
}

const MODEL_NAMESPACE_PREFIX =
  /^(openai|anthropic|google(?:-vertex)?|xai|deepseek|mistral|cohere|zhipuai|moonshotai|minimax|meta)[/:.]/i

/** Provider that publishes the authoritative price for a model family. */
const MODEL_PROVIDER_PREFERENCES: readonly { readonly pattern: RegExp; readonly providers: readonly string[] }[] = [
  { pattern: /^(?:gpt-|o[134](?:-|$)|chatgpt-|codex-)/, providers: ["openai", "openai-codex", "opencode"] },
  { pattern: /^claude-/, providers: ["anthropic"] },
  { pattern: /^(?:gemini-|gemma-)/, providers: ["google", "google-vertex"] },
  { pattern: /^grok-/, providers: ["xai"] },
  { pattern: /^deepseek-/, providers: ["deepseek"] },
  { pattern: /^mistral-/, providers: ["mistral"] },
  { pattern: /^command-/, providers: ["cohere"] },
  { pattern: /^glm-/, providers: ["zhipuai"] },
  { pattern: /^(?:kimi-|moonshot-)/, providers: ["moonshotai"] },
  { pattern: /^minimax-/, providers: ["minimax"] },
  { pattern: /^llama-/, providers: ["meta"] },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)))
}

function stripModelNamespace(modelId: string): string {
  return modelId.trim().toLowerCase().replace(MODEL_NAMESPACE_PREFIX, "")
}

function normalizeModelKey(modelId: string): string {
  return stripModelNamespace(modelId).replace(/[^a-z0-9]/g, "")
}

function readRate(source: Record<string, unknown>, key: keyof CostRates, fallback: number): number {
  const snake = key === "cacheRead" ? "cache_read" : key === "cacheWrite" ? "cache_write" : key
  return finiteNumber(source[key] ?? source[snake]) ?? fallback
}

/** Read one `cost` object, including `tiers` and the legacy `context_over_200k` shortcut. */
function parseCost(raw: unknown): ModelCost | undefined {
  if (!isRecord(raw)) return undefined
  const input = finiteNumber(raw.input)
  const output = finiteNumber(raw.output)
  if (input === undefined && output === undefined) return undefined

  const cost: ModelCost = {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: readRate(raw, "cacheRead", 0),
    cacheWrite: readRate(raw, "cacheWrite", 0),
  }

  const tiers = new Map<number, CostTier>()
  const addTier = (rawTier: unknown, fallbackThreshold?: number): void => {
    if (!isRecord(rawTier)) return
    const descriptor = isRecord(rawTier.tier) ? rawTier.tier : undefined
    if (descriptor?.type !== undefined && descriptor.type !== "context") return
    const threshold =
      finiteNumber(rawTier.inputTokensAbove) ?? finiteNumber(descriptor?.size) ?? fallbackThreshold
    if (threshold === undefined || threshold <= 0) return
    tiers.set(threshold, {
      input: readRate(rawTier, "input", cost.input),
      output: readRate(rawTier, "output", cost.output),
      cacheRead: readRate(rawTier, "cacheRead", cost.cacheRead),
      cacheWrite: readRate(rawTier, "cacheWrite", cost.cacheWrite),
      inputTokensAbove: threshold,
    })
  }

  if (Array.isArray(raw.tiers)) for (const tier of raw.tiers) addTier(tier)
  if (tiers.size === 0) addTier(raw.context_over_200k, 200_000)
  const ordered = Array.from(tiers.values()).sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
  return ordered.length > 0 ? { ...cost, tiers: ordered } : cost
}

function preferredProvidersForModel(modelId: string): string[] {
  const normalizedId = stripModelNamespace(modelId)
  const namespace = modelId.trim().toLowerCase().match(MODEL_NAMESPACE_PREFIX)?.[1]
  const familyProviders = MODEL_PROVIDER_PREFERENCES.find(({ pattern }) => pattern.test(normalizedId))?.providers ?? []
  return uniqueStrings([namespace ?? "", ...familyProviders])
}

function addEntry(target: Map<string, ModelsDevCostEntry[]>, key: string, entry: ModelsDevCostEntry): void {
  if (!key) return
  const entries = target.get(key) ?? []
  if (!entries.some((candidate) => candidate.providerId === entry.providerId && candidate.modelId === entry.modelId)) {
    entries.push(entry)
    target.set(key, entries)
  }
}

function sameCostVariants(entries: readonly ModelsDevCostEntry[]): boolean {
  const fingerprints = new Set(entries.map((entry) => JSON.stringify({ standard: entry.standard, fast: entry.fast })))
  return fingerprints.size === 1
}

/** Pick one entry, or nothing when reseller prices disagree and no provider is preferred. */
function selectEntry(entries: readonly ModelsDevCostEntry[], modelId: string): ModelsDevCostEntry | undefined {
  if (entries.length === 0) return undefined
  for (const providerId of preferredProvidersForModel(modelId)) {
    const match = entries.find((entry) => entry.providerId === providerId)
    if (match) return match
  }
  if (entries.length === 1 || sameCostVariants(entries)) {
    return [...entries].sort((a, b) => a.providerId.localeCompare(b.providerId))[0]
  }
  return undefined
}

function findEntry(modelId: string, catalog: ModelsDevCatalog): ModelsDevCostEntry | undefined {
  const rawId = modelId.trim().toLowerCase()
  const lookupIds = uniqueStrings([rawId, ...(MODEL_PRICE_ALIASES[rawId] ?? [])])
  for (const lookupId of lookupIds) {
    for (const key of uniqueStrings([lookupId, stripModelNamespace(lookupId)])) {
      const match = selectEntry(catalog.exact.get(key) ?? [], modelId)
      if (match) return match
    }
    const match = selectEntry(catalog.normalized.get(normalizeModelKey(lookupId)) ?? [], modelId)
    if (match) return match
  }
  return undefined
}

/** Index a raw models.dev `api.json` payload. */
export function buildModelsDevCatalog(payload: unknown): ModelsDevCatalog {
  const exact = new Map<string, ModelsDevCostEntry[]>()
  const normalized = new Map<string, ModelsDevCostEntry[]>()
  if (!isRecord(payload)) return { exact, normalized }

  for (const [providerId, providerValue] of Object.entries(payload)) {
    if (!isRecord(providerValue) || !isRecord(providerValue.models)) continue
    for (const [modelId, modelValue] of Object.entries(providerValue.models)) {
      if (!isRecord(modelValue)) continue
      const standard = parseCost(modelValue.cost)
      if (!standard) continue
      const modes = isRecord(modelValue.experimental) ? modelValue.experimental.modes : undefined
      const fast = isRecord(modes) && isRecord(modes.fast) ? parseCost(modes.fast.cost) : undefined
      const entry: ModelsDevCostEntry = { providerId, modelId, standard, ...(fast ? { fast } : {}) }
      for (const key of uniqueStrings([modelId.trim().toLowerCase(), stripModelNamespace(modelId)])) {
        addEntry(exact, key, entry)
      }
      addEntry(normalized, normalizeModelKey(modelId), entry)
    }
  }
  return { exact, normalized }
}

/**
 * Price for one model id. `fast` selects the published Fast price when there is
 * one and otherwise keeps the standard rate; it never scales the standard rate.
 */
export function matchModelCost(modelId: string, catalog: ModelsDevCatalog, fast = false): ModelCost | undefined {
  const entry = findEntry(modelId, catalog)
  if (!entry) return undefined
  return fast && entry.fast ? entry.fast : entry.standard
}

/** Map matched rates onto the model `cost` array OpenCode understands. */
export function toModelCost(cost: ModelCost): Model.Info["cost"] {
  const base = { input: cost.input, output: cost.output, cache: { read: cost.cacheRead, write: cost.cacheWrite } }
  const tiers = (cost.tiers ?? []).map((tier) => ({
    tier: { type: "context" as const, size: tier.inputTokensAbove },
    input: tier.input,
    output: tier.output,
    cache: { read: tier.cacheRead, write: tier.cacheWrite },
  }))
  // `Money.USDPerMillionTokens` is a phantom brand: the host decodes these plain
  // numbers while registering the model.
  return [base, ...tiers] as unknown as Model.Info["cost"]
}
