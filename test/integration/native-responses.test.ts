/**
 * Native runtime coverage.
 *
 * These tests drive the real OpenCode Responses provider package
 * (`@opencode/ai/providers/openai-compatible/responses`) over real HTTP against
 * the mock CPA. Serialization and SSE parsing are the host's own code, and the
 * address comes from the plugin's own `resolveEndpoints`, so the assertions are
 * about the wire and the stream events rather than a stubbed context.
 */

import { afterEach, describe, expect, test } from "bun:test"
import * as AI from "@opencode/ai/promise"
import { Media, Message, ToolCallPart, ToolResultPart } from "@opencode/ai"
import { model } from "@opencode/ai/providers/openai-compatible/responses"
import { OpenAICompatibleResponses } from "@opencode/ai/protocols/openai-compatible-responses"
import { OpenResponsesChannel } from "@opencode/ai/protocols/open-responses-channel"
import { resolveEndpoints } from "../../src/address"
import { fetchCatalog } from "../../src/catalog"
import { SUMMARY_PROMPT_MARKER, startMockCpa, textReply, toolCallReply } from "../support/mock-cpa.mjs"

const API_KEY = "sk-fake-native-0001"
const ai = AI.make()

const READ_TOOL = {
  name: "read",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="

let mock: Awaited<ReturnType<typeof startMockCpa>> | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
})

async function collect(stream: AsyncIterable<Record<string, unknown>>) {
  const events: Record<string, unknown>[] = []
  for await (const event of stream) events.push(event as Record<string, unknown>)
  return events
}

function languageModel(url: string, modelID = "gpt-5.2-codex", options: Record<string, unknown> = {}) {
  const endpoints = resolveEndpoints(url)
  return { endpoints, languageModel: model(modelID, { baseURL: endpoints.baseURL, apiKey: API_KEY, ...options }) }
}

/**
 * Build a WebSocket `response.create` frame with the native channel serializer.
 * No socket is opened: `prepare` produces the frame the runtime would send, and
 * the driver exposes it without executing the connection.
 */
async function webSocketFrame(providerOptions: Record<string, unknown>, baseURL = "http://127.0.0.1:1/v1") {
  const route = OpenAICompatibleResponses.route.with({ provider: "cliproxyapi", endpoint: { baseURL } })
  const request = ai.llm.request({
    model: route.model({ id: "gpt-5.2-codex" }),
    prompt: "hi",
    providerOptions,
  })
  const body = await ai.run(route.body.from(request))
  // `Body` is not inferable from the transport options, so bind it to the body
  // the native serializer produced.
  const transport = OpenResponsesChannel.transport<typeof body>({ id: "cliproxyapi", name: "CLIProxyAPI" })
  type PrepareInput = Parameters<typeof transport.prepare>[0]
  const prepared = await ai.run(
    transport.prepare({
      body,
      request,
      endpoint: route.endpoint,
      auth: route.auth,
      encodeBody: (value) => JSON.stringify(value),
      // `prepare` only needs the executor to be present; the frame is read from
      // the driver before any connection is made.
      webSocket: {} as unknown as NonNullable<PrepareInput["webSocket"]>,
    }),
  )
  const create = await ai.run(prepared.channel!.driver.create(undefined))
  return JSON.parse(create.message) as Record<string, unknown>
}

describe("native Responses runtime against the mock CPA", () => {
  test("sends the real model id and bearer key and parses the streamed text", async () => {
    mock = await startMockCpa({ responses: textReply("pong from CPA") })
    const { endpoints, languageModel: lm } = languageModel(mock.url)

    const events = await collect(
      ai.llm.stream({
        model: lm,
        system: "You are a test agent.",
        prompt: "say pong",
        tools: [READ_TOOL],
        generation: { maxTokens: 4096 },
      }) as AsyncIterable<Record<string, unknown>>,
    )

    const request = mock.responses()[0]!
    expect(request.path).toBe("/v1/responses")
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(request.json.model).toBe("gpt-5.2-codex")
    expect(request.json.instructions).toBe("You are a test agent.")
    expect(request.json.input[0].content[0]).toEqual({ type: "input_text", text: "say pong" })
    expect(request.json.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: READ_TOOL.inputSchema,
        strict: false,
      },
    ])
    expect(request.json.store).toBe(false)
    expect(request.json.include).toContain("reasoning.encrypted_content")
    expect(request.json.max_output_tokens).toBe(4096)
    expect(endpoints.baseURL).toBe(`${mock.url}/v1`)

    const text = events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("")
    expect(text).toBe("pong from CPA")
    expect(events.some((event) => event.type === "finish")).toBe(true)
  })

  test("carries a declared image input as a Responses image part", async () => {
    mock = await startMockCpa({ responses: textReply("I see one pixel") })
    const { languageModel: lm } = languageModel(mock.url)
    const image = new Media.Asset({ source: { type: "base64", data: PNG_BASE64, mediaType: "image/png" } })

    const events = await collect(
      ai.llm.stream({
        model: lm,
        prompt: [Message.text("what is in this image"), Message.media(image)],
      }) as AsyncIterable<Record<string, unknown>>,
    )

    const content = mock.responses()[0]!.json.input[0].content
    expect(content[0]).toEqual({ type: "input_text", text: "what is in this image" })
    expect(content[1].type).toBe("input_image")
    expect(content[1].image_url).toBe(`data:image/png;base64,${PNG_BASE64}`)
    expect(events.some((event) => event.type === "text-delta")).toBe(true)
  })

  test("round-trips a tool call and its result in the follow-up request", async () => {
    mock = await startMockCpa({
      responses: (request: { json: { input: unknown[] } }, index: number) =>
        index === 0
          ? toolCallReply({ callId: "call_read_1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) })
          : textReply("the file says hello"),
    })
    const { languageModel: lm } = languageModel(mock.url)

    const first = await collect(
      ai.llm.stream({ model: lm, prompt: "read a.txt", tools: [READ_TOOL] }) as AsyncIterable<Record<string, unknown>>,
    )
    const call = first.find((event) => event.type === "tool-call") as { id: string; name: string; input: unknown }
    expect(call.name).toBe("read")
    expect(call.id).toBe("call_read_1")
    expect(call.input).toEqual({ path: "a.txt" })

    const second = await collect(
      ai.llm.stream({
        model: lm,
        messages: [
          Message.user("read a.txt"),
          Message.assistant([ToolCallPart.make({ id: call.id, name: call.name, input: call.input })]),
          Message.tool(ToolResultPart.make({ id: call.id, name: call.name, result: "file says hello" })),
        ],
        tools: [READ_TOOL],
      }) as AsyncIterable<Record<string, unknown>>,
    )

    const followUp = mock.responses()[1]!
    expect(followUp.json.input[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "read a.txt" }] })
    expect(followUp.json.input[1]).toEqual({
      type: "function_call",
      call_id: "call_read_1",
      name: "read",
      arguments: JSON.stringify({ path: "a.txt" }),
    })
    expect(followUp.json.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_read_1",
      // The native runtime JSON-encodes a non-content tool result.
      output: JSON.stringify("file says hello"),
    })
    const text = second
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("")
    expect(text).toBe("the file says hello")
  })

  test("sends a summary request as an ordinary model call and keeps the returned summary", async () => {
    const summaryText = "## Objective\n- keep ponging"
    mock = await startMockCpa({
      responses: (request: { json: { input: { content: { text: string }[] }[] } }) =>
        JSON.stringify(request.json.input).includes(SUMMARY_PROMPT_MARKER)
          ? textReply(summaryText)
          : textReply("pong"),
    })
    const { languageModel: lm } = languageModel(mock.url)

    const compact = await collect(
      ai.llm.stream({
        model: lm,
        messages: [
          Message.user("first message about pong"),
          Message.assistant("probe pong"),
          Message.user(SUMMARY_PROMPT_MARKER + "\n<template>## Objective</template>"),
        ],
      }) as AsyncIterable<Record<string, unknown>>,
    )
    const summary = compact
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("")
    expect(summary).toBe(summaryText)

    const followUp = await collect(
      ai.llm.stream({
        model: lm,
        messages: [
          Message.user("first message about pong"),
          Message.assistant("probe pong"),
          Message.user("second message"),
        ],
      }) as AsyncIterable<Record<string, unknown>>,
    )
    expect(JSON.stringify(mock.responses()[1]!.json.input)).not.toContain(SUMMARY_PROMPT_MARKER)
    expect(followUp.some((event) => event.type === "text-delta")).toBe(true)
  })

  test("keeps a reverse proxy subpath on both the directory and the response request", async () => {
    mock = await startMockCpa({
      basePath: "/cpa",
      models: [{ slug: "gpt-5.2-codex", display_name: "GPT-5.2 Codex" }],
      responses: textReply("pong behind the proxy"),
    })
    const endpoints = resolveEndpoints(`${mock.url}/cpa`)
    expect(endpoints.baseURL).toBe(`${mock.url}/cpa/v1`)

    const entries = await fetchCatalog({ modelsURL: endpoints.modelsURL, apiKey: API_KEY })
    expect(entries.map((entry) => entry.id)).toEqual(["gpt-5.2-codex"])

    const lm = model("gpt-5.2-codex", { baseURL: endpoints.baseURL, apiKey: API_KEY })
    const events = await collect(ai.llm.stream({ model: lm, prompt: "say pong" }) as AsyncIterable<Record<string, unknown>>)

    const directory = mock.requests.find((request) => request.method === "GET")!
    expect(directory.path).toBe("/cpa/v1/models")
    expect(directory.query.client_version).toStartWith("opencode2-cliproxyapi-provider/")

    const request = mock.responses()[0]!
    expect(request.path).toBe("/cpa/v1/responses")
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(request.json.model).toBe("gpt-5.2-codex")
    expect(events.some((event) => event.type === "text-delta")).toBe(true)
  })

  test("rejects a Responses request that drops the /v1 segment", async () => {
    mock = await startMockCpa({ responses: textReply("pong") })

    // The address regression this mock must catch: a client that appends
    // `/responses` to the origin root instead of to `{root}/v1`.
    const wrong = await fetch(`${mock.url}/responses`, { method: "POST", body: "{}" })
    expect(wrong.status).toBe(404)
    expect(mock.responses()).toHaveLength(1)
    expect(mock.responses()[0]!.path).toBe("/responses")

    const right = await fetch(`${mock.url}/v1/responses`, { method: "POST", body: "{}" })
    expect(right.status).toBe(200)
    expect(mock.responses()).toHaveLength(2)
  })

  test("surfaces a provider error instead of an empty result", async () => {
    mock = await startMockCpa({ responses: { status: 401, body: { error: { message: "invalid key" } } } })
    const { languageModel: lm } = languageModel(mock.url)

    const failure = await collect(ai.llm.stream({ model: lm, prompt: "hello" }) as AsyncIterable<Record<string, unknown>>).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("invalid key")
    expect(mock.responses()).toHaveLength(1)
  })

  test("sends the semantic serviceTier as service_tier on every request kind", async () => {
    mock = await startMockCpa({ responses: textReply("pong") })
    const { languageModel: lm } = languageModel(mock.url, "gpt-5.2-codex", {
      serviceTier: "priority",
      reasoningEffort: "high",
    })

    // primary conversation
    await collect(ai.llm.stream({ model: lm, prompt: "say pong" }) as AsyncIterable<Record<string, unknown>>)
    // summary/compaction request, as OpenCode builds it
    await collect(
      ai.llm.stream({
        model: lm,
        messages: [Message.user("earlier turn"), Message.user(SUMMARY_PROMPT_MARKER + "\n<template></template>")],
      }) as AsyncIterable<Record<string, unknown>>,
    )
    // title/generate-shaped request: a system instruction and one short prompt
    await collect(
      ai.llm.stream({ model: lm, system: "You are a title generator", prompt: "name this session" }) as AsyncIterable<
        Record<string, unknown>
      >,
    )

    const requests = mock.responses()
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(request.json.service_tier).toBe("priority")
      expect(request.json.reasoning).toEqual({ effort: "high" })
    }
    expect(JSON.stringify(requests[1]!.json.input)).toContain(SUMMARY_PROMPT_MARKER)
  })

  test("omits service_tier when Fast is off", async () => {
    mock = await startMockCpa({ responses: textReply("pong") })
    const { languageModel: lm } = languageModel(mock.url)

    await collect(ai.llm.stream({ model: lm, prompt: "say pong" }) as AsyncIterable<Record<string, unknown>>)
    expect(mock.responses()[0]!.json.service_tier).toBeUndefined()
    expect(mock.responses()[0]!.json.reasoning).toBeUndefined()
  })

  test("carries the same priority parameter in a native WebSocket response.create frame", async () => {
    const on = await webSocketFrame({ serviceTier: "priority", reasoningEffort: "high" })
    expect(on.type).toBe("response.create")
    expect(on.service_tier).toBe("priority")
    expect(on.reasoning).toEqual({ effort: "high" })
    // The channel frame drops the HTTP-only streaming flags.
    expect(on.stream).toBeUndefined()
    expect(on.stream_options).toBeUndefined()

    const off = await webSocketFrame({})
    expect(off.type).toBe("response.create")
    expect(off.service_tier).toBeUndefined()
    expect(off.model).toBe("gpt-5.2-codex")
  })
})
