import { describe, expect, test } from "bun:test"
import { Provider } from "@opencode/plugin"
import {
  CatalogError,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  fetchCatalog,
  parseCatalogPayload,
  toModelInfo,
} from "../../src/catalog"

const providerID = Provider.ID.make("cliproxyapi")

describe("parseCatalogPayload", () => {
  test("reads the CPA enhanced directory", () => {
    const entries = parseCatalogPayload({
      models: [
        {
          slug: "gpt-5.2-codex",
          display_name: "GPT-5.2 Codex",
          context_window: 272_000,
          max_output_tokens: 128_000,
          input_modalities: ["text", "image"],
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, "max"],
          visibility: "list",
        },
      ],
    })
    expect(entries).toEqual([
      {
        id: "gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        contextWindow: 272_000,
        maxOutputTokens: 128_000,
        inputModalities: ["text", "image"],
        reasoningLevels: ["low", "high", "max"],
        hidden: false,
      },
    ])
  })

  test("reads the plain OpenAI listing with conservative gaps", () => {
    const entries = parseCatalogPayload({ object: "list", data: [{ id: "plain-model", object: "model" }] })
    expect(entries).toEqual([{ id: "plain-model", hidden: false }])
  })

  test("accepts the alternate limit and modality field names", () => {
    const entries = parseCatalogPayload({
      models: [
        {
          id: "alt",
          max_context_window: 64_000,
          max_completion_tokens: 4_000,
          input_modalities: ["image"],
        },
      ],
    })
    expect(entries[0]?.contextWindow).toBe(64_000)
    expect(entries[0]?.maxOutputTokens).toBe(4_000)
    // Text is always part of the mapping when the directory lists an image.
    expect(entries[0]?.inputModalities).toEqual(["text", "image"])
  })

  test("marks hidden entries instead of dropping them", () => {
    const entries = parseCatalogPayload({ models: [{ slug: "hidden-one", visibility: "hide" }] })
    expect(entries).toEqual([{ id: "hidden-one", hidden: true }])
  })

  test("keeps the first entry for a duplicated id and skips entries without one", () => {
    const entries = parseCatalogPayload({
      models: [{ slug: "dup", display_name: "First" }, { slug: "dup", display_name: "Second" }, { name: "no id" }],
    })
    expect(entries.map((entry) => entry.name)).toEqual(["First"])
  })

  test("treats an empty directory as empty, and anything else as an error", () => {
    expect(parseCatalogPayload({ models: [] })).toEqual([])
    expect(parseCatalogPayload({ data: [] })).toEqual([])
    expect(() => parseCatalogPayload({})).toThrow(CatalogError)
    expect(() => parseCatalogPayload({ models: {} })).toThrow(CatalogError)
    expect(() => parseCatalogPayload("not json")).toThrow(CatalogError)
    expect(() => parseCatalogPayload(null)).toThrow(CatalogError)
    expect(() => parseCatalogPayload({ error: "boom" })).toThrow(CatalogError)
  })
})

describe("toModelInfo", () => {
  test("keeps the real CPA id and declares only observed capabilities", () => {
    const model = toModelInfo(providerID, { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" })
    expect(String(model.id)).toBe("claude-sonnet-4-5")
    expect(String(model.modelID)).toBe("claude-sonnet-4-5")
    expect(model.name).toBe("Claude Sonnet 4.5")
    expect(model.enabled).toBe(true)
    expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
    expect(model.limit).toEqual({ context: DEFAULT_CONTEXT_WINDOW, output: DEFAULT_MAX_OUTPUT_TOKENS })
    expect(model.variants).toEqual([])
    expect(model.cost).toEqual([])
  })

  test("declares image input only when the directory does", () => {
    const withImage = toModelInfo(providerID, { id: "vision", inputModalities: ["text", "image"] })
    expect(withImage.capabilities.input).toEqual(["text", "image"])
    const withoutImage = toModelInfo(providerID, { id: "text-only" })
    expect(withoutImage.capabilities.input).toEqual(["text"])
  })

  test("maps reasoning levels onto variants and clamps the output limit", () => {
    const model = toModelInfo(providerID, {
      id: "reasoner",
      contextWindow: 32_000,
      maxOutputTokens: 64_000,
      reasoningLevels: ["low", "high"],
      hidden: true,
    })
    expect(model.variants.map((variant) => String(variant.id))).toEqual(["low", "high"])
    expect(model.variants[0]?.settings).toEqual({ reasoningEffort: "low" })
    expect(model.limit).toEqual({ context: 32_000, output: 32_000 })
    expect(model.enabled).toBe(false)
  })
})

describe("fetchCatalog", () => {
  test("reports HTTP failures with their status", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch
    const failure = await fetchCatalog({ modelsURL: "http://cpa.test/v1/models", apiKey: "k", fetchImpl }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(CatalogError)
    expect((failure as CatalogError).kind).toBe("http")
    expect((failure as CatalogError).status).toBe(401)
  })

  test("rejects a body that is not the directory shape", async () => {
    const fetchImpl = (async () => new Response("<html>proxy error</html>", { status: 200 })) as unknown as typeof fetch
    const failure = await fetchCatalog({ modelsURL: "http://cpa.test/v1/models", apiKey: "k", fetchImpl }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(CatalogError)
    expect((failure as CatalogError).kind).toBe("format")
  })

  test("sends the bearer token and accepts the enhanced directory", async () => {
    let seen: RequestInit | undefined
    let seenURL: string | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenURL = url
      seen = init
      return new Response(JSON.stringify({ models: [{ slug: "m1" }] }), { status: 200 })
    }) as unknown as typeof fetch

    const entries = await fetchCatalog({
      modelsURL: "http://cpa.test/v1/models?client_version=x",
      apiKey: "sk-fake-test-key",
      fetchImpl,
    })
    expect(entries).toEqual([{ id: "m1", hidden: false }])
    expect(seenURL).toBe("http://cpa.test/v1/models?client_version=x")
    expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer sk-fake-test-key")
  })
})
