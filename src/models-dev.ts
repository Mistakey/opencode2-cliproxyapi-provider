/**
 * models.dev catalog fetch.
 *
 * Price is a supplement: the fetch runs beside the CPA directory request and a
 * failure only means the registered models carry no price estimate. Nothing is
 * invented to fill the gap.
 */

import { buildModelsDevCatalog, type ModelsDevCatalog } from "./cost"

export const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json"
export const DEFAULT_MODELS_DEV_TIMEOUT_MS = 5_000

export interface ModelsDevInput {
  readonly url: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

export type ModelsDevResult =
  | { readonly ok: true; readonly catalog: ModelsDevCatalog }
  | { readonly ok: false; readonly message: string }

/** Fetch and index the catalog. Never throws; an unreadable catalog is reported. */
export async function fetchModelsDevCatalog(input: ModelsDevInput): Promise<ModelsDevResult> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_MODELS_DEV_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const doFetch = input.fetchImpl ?? fetch

  let response: Response
  try {
    response = await doFetch(input.url, { headers: { accept: "application/json" }, signal })
  } catch (error) {
    return { ok: false, message: `request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) {
    return { ok: false, message: `request failed with ${response.status}` }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    return { ok: false, message: `response is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }

  const catalog = buildModelsDevCatalog(payload)
  if (catalog.exact.size === 0 && catalog.normalized.size === 0) {
    return { ok: false, message: "response holds no priced models" }
  }
  return { ok: true, catalog }
}
