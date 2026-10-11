import { describe, expect, test } from "bun:test"
import { buildModelsDevCatalog, matchModelCost, toModelCost } from "../../src/cost"
import { fetchModelsDevCatalog } from "../../src/models-dev"

/** A models.dev-shaped payload: providers -> models -> cost (+ experimental fast mode). */
const payload = {
  openai: {
    models: {
      "gpt-5.2": { cost: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 1.5 } },
    },
  },
  anthropic: {
    models: {
      "claude-sonnet-4-5": {
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
          tiers: [{ inputTokensAbove: 200_000, input: 6, output: 22.5, cache_read: 0.6, cache_write: 7.5 }],
        },
      },
    },
  },
  "reseller-a": { models: { "claude-sonnet-4-5": { cost: { input: 9, output: 45 } } } },
  "reseller-b": { models: { "claude-sonnet-4-5": { cost: { input: 8, output: 40 } } } },
  xai: {
    models: {
      "grok-4.3": {
        cost: { input: 3, output: 15 },
        experimental: { modes: { fast: { cost: { input: 6, output: 30 } } } },
      },
      "xai/grok-3-mini": { cost: { input: 0.3, output: 0.5 } },
    },
  },
  google: { models: { "gemini-3.1-pro-preview": { cost: { input: 1.25, output: 10 } } } },
  "reseller-c": { models: { "mystery-model-9": { cost: { input: 1, output: 2 } } } },
  "reseller-d": { models: { "mystery-model-9": { cost: { input: 3, output: 6 } } } },
  "reseller-e": { models: { "twin-model": { cost: { input: 1, output: 2 } } } },
  "reseller-f": { models: { "twin-model": { cost: { input: 1, output: 2 } } } },
}

const catalog = buildModelsDevCatalog(payload)

describe("buildModelsDevCatalog and matchModelCost", () => {
  test("reads the standard rate and ignores an unrelated provider", () => {
    expect(matchModelCost("gpt-5.2", catalog)).toEqual({
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 1.5,
    })
    expect(matchModelCost("not-a-model", catalog)).toBeUndefined()
  })

  test("strips a provider namespace and falls back to a normalized key", () => {
    expect(matchModelCost("openai/gpt-5.2", catalog)?.input).toBe(1.25)
    expect(matchModelCost("gpt5.2", catalog)?.input).toBe(1.25)
    expect(matchModelCost("GPT-5.2", catalog)?.input).toBe(1.25)
  })

  test("uses the published Fast price when there is one", () => {
    expect(matchModelCost("grok-4.3", catalog)?.output).toBe(15)
    expect(matchModelCost("grok-4.3", catalog, true)).toEqual({ input: 6, output: 30, cacheRead: 0, cacheWrite: 0 })
  })

  test("keeps the standard rate when Fast has no published price, without inventing a multiplier", () => {
    const standard = matchModelCost("gpt-5.2", catalog)
    expect(matchModelCost("gpt-5.2", catalog, true)).toEqual(standard)
  })

  test("keeps context tiers and sorts them by threshold", () => {
    const cost = matchModelCost("claude-sonnet-4-5", catalog)
    expect(cost?.tiers?.map((tier) => tier.inputTokensAbove)).toEqual([200_000])
    expect(cost?.tiers?.[0]).toEqual({
      input: 6,
      output: 22.5,
      cacheRead: 0.6,
      cacheWrite: 7.5,
      inputTokensAbove: 200_000,
    })
  })

  test("reads the legacy context_over_200k shortcut as a tier", () => {
    const legacy = buildModelsDevCatalog({
      openai: { models: { "legacy-model": { cost: { input: 1, output: 2, context_over_200k: { input: 2, output: 4 } } } } },
    })
    expect(matchModelCost("legacy-model", legacy)?.tiers).toEqual([
      { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 200_000 },
    ])
  })

  test("follows an explicit alias to the billable base model", () => {
    expect(matchModelCost("gemini-pro-agent", catalog)?.input).toBe(1.25)
    expect(matchModelCost("grok-3-mini", catalog)?.input).toBe(0.3)
  })

  test("prefers the authoritative provider over a reseller", () => {
    expect(matchModelCost("claude-sonnet-4-5", catalog)?.input).toBe(3)
  })

  test("refuses to pick between disagreeing resellers, but accepts identical prices", () => {
    expect(matchModelCost("mystery-model-9", catalog)).toBeUndefined()
    expect(matchModelCost("twin-model", catalog)?.input).toBe(1)
  })

  test("maps rates onto the model cost array with the context tier entry", () => {
    const cost = matchModelCost("claude-sonnet-4-5", catalog)
    expect(toModelCost(cost!) as unknown as unknown[]).toEqual([
      { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      {
        tier: { type: "context", size: 200_000 },
        input: 6,
        output: 22.5,
        cache: { read: 0.6, write: 7.5 },
      },
    ])
  })

  test("ignores providers or models without a usable cost", () => {
    const empty = buildModelsDevCatalog({
      openai: { models: { "no-cost": { name: "No cost" } } },
      broken: "not a provider",
    })
    expect(empty.exact.size).toBe(0)
    expect(buildModelsDevCatalog(null).exact.size).toBe(0)
  })
})

describe("fetchModelsDevCatalog", () => {
  const okFetch = (async () =>
    new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch

  test("indexes a served catalog", async () => {
    const result = await fetchModelsDevCatalog({ url: "http://models.test/api.json", fetchImpl: okFetch })
    expect(result.ok).toBe(true)
    if (result.ok) expect(matchModelCost("gpt-5.2", result.catalog)?.input).toBe(1.25)
  })

  test("reports transport, status, format and empty-catalog failures instead of inventing prices", async () => {
    const down = await fetchModelsDevCatalog({
      url: "http://models.test/api.json",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })
    expect(down).toEqual({ ok: false, message: expect.stringContaining("ECONNREFUSED") })

    const failing = await fetchModelsDevCatalog({
      url: "http://models.test/api.json",
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    })
    expect(failing.ok).toBe(false)

    const broken = await fetchModelsDevCatalog({
      url: "http://models.test/api.json",
      fetchImpl: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    })
    expect(broken.ok).toBe(false)

    const empty = await fetchModelsDevCatalog({
      url: "http://models.test/api.json",
      fetchImpl: (async () => new Response(JSON.stringify({ openai: { models: {} } }), { status: 200 })) as unknown as typeof fetch,
    })
    expect(empty).toEqual({ ok: false, message: expect.stringContaining("no priced models") })
  })
})
