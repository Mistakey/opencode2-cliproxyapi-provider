/**
 * Native Responses WebSocket channel coverage.
 *
 * These tests drive the host's own Responses WebSocket channel
 * (`@opencode/ai/route/transport/websocket` + the native OpenAI Responses
 * route) against a mock CPA that models CPA's transcript state machine. The
 * transport, the continuation/checkpoint logic and the event parsing are the
 * host's code; the assertions are about the frames that would reach CPA and the
 * transcript CPA would have built from them.
 *
 * The host keeps one socket per session and reuses it across model calls, so the
 * tests use a connector that does the same instead of the per-call default
 * executor. That reuse is what makes the incremental continuation observable.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Socket } from "effect/unstable/socket"
import { AIClient, LLM, LLMClient, Message, ToolCallPart, ToolResultPart } from "@opencode/ai"
import type { StreamOptions } from "@opencode/ai/route/client"
import {
  WebSocketTransport,
  type WebSocketConnection,
  type WebSocketRequest,
} from "@opencode/ai/route/transport/websocket"
import { model } from "@opencode/ai/providers/openai/responses"
import { startMockCpaWs } from "../support/mock-cpa-ws.mjs"

const API_KEY = "sk-fake-ws-0001"

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

let mock: Awaited<ReturnType<typeof startMockCpaWs>> | undefined
let session: Awaited<ReturnType<typeof sessionExecutor>> | undefined

afterEach(async () => {
  await session?.close()
  session = undefined
  await mock?.close()
  mock = undefined
})

/** Per-call executor: opens and closes one socket per model call. */
async function callExecutor() {
  return Effect.runPromise(
    WebSocketTransport.direct.pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  )
}

type ChannelExecutor = NonNullable<StreamOptions["webSocket"]>
type Exchange = Parameters<ChannelExecutor["execute"]>[0]
type Checkpoint = Parameters<Exchange["driver"]["create"]>[0]

/**
 * Session executor: keeps one socket across model calls and remembers the
 * continuation checkpoint, which is what the host does. The channel and
 * continuation logic stays the host runtime's; this only supplies the socket
 * and the checkpoint plumbing so the runtime can decide full vs incremental.
 */
async function sessionExecutor() {
  let live: WebSocketConnection | undefined
  let checkpoint: Checkpoint
  const open = (input: WebSocketRequest) =>
    Effect.promise(async () => {
      if (!live) {
        live = await Effect.runPromise(
          WebSocketTransport.open(input).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
        )
      }
      return live
    })
  const executor: ChannelExecutor = {
    execute: (exchange: Exchange) =>
      Effect.gen(function* () {
        const connection = yield* Effect.acquireRelease(open(exchange.connect), () => Effect.void)
        const create = yield* exchange.driver.create(checkpoint)
        yield* connection.sendText(create.message)
        const decoder = new TextDecoder()
        let completed: Checkpoint
        const frames = connection.messages.pipe(
          Stream.map((message) => WebSocketTransport.messageText(message, decoder)),
          Stream.mapEffect((frame) => exchange.driver.observe(create, frame)),
          Stream.takeUntil((observation) => observation.type !== "frame"),
          Stream.mapEffect((observation) => {
            if (
              observation.type === "frame" ||
              observation.type === "completed" ||
              observation.type === "incomplete"
            ) {
              if (observation.type === "completed") completed = observation.checkpoint
              return Effect.succeed(observation.frame)
            }
            return Effect.fail(observation.error)
          }),
        )
        return {
          frames,
          complete: Effect.sync(() => {
            checkpoint = completed
          }),
        }
      }),
  }
  return {
    executor,
    close: async () => {
      if (live) await Effect.runPromise(live.close)
      live = undefined
    },
  }
}

type Executor = Awaited<ReturnType<typeof callExecutor>>

async function collect(request: Parameters<typeof LLM.stream>[0], webSocket: Executor) {
  const chunk = await Effect.runPromise(
    LLM.stream(request, { webSocket }).pipe(Stream.runCollect, Effect.provide(AIClient.layer)),
  )
  return [...chunk] as Record<string, unknown>[]
}

function languageModel(url: string, modelID = "gpt-5.2-codex") {
  return model(modelID, { baseURL: `${url}/v1`, apiKey: API_KEY })
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** True when a WebSocket handshake at `url` completes. */
function wsOpens(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const socket = new WebSocket(url)
    socket.addEventListener("open", () => {
      socket.close()
      done(true)
    })
    socket.addEventListener("error", () => done(false))
    timer = setTimeout(() => {
      try {
        socket.close()
      } catch {
        // The socket may already be closed.
      }
      done(false)
    }, 2000)
  })
}

describe("mock CPA WebSocket route contract", () => {
  test("serves only the exact root /v1 routes and refuses extra prefixes", async () => {
    mock = await startMockCpaWs({ responses: () => ({ text: "ws pong" }) })
    const status = async (method: string, path: string, body?: string) =>
      (await fetch(`${mock!.url}${path}`, { method, ...(body !== undefined ? { body } : {}) })).status

    expect(await status("GET", "/v1/models")).toBe(200)
    expect(await status("POST", "/v1/responses", "{}")).toBe(200)
    expect(await status("POST", "/v1/responses/compact", "{}")).toBe(200)

    // A dropped `/v1`, an extra prefix or a doubled `/v1` is a 404.
    for (const path of ["/models", "/wrong/models", "/wrong/v1/models", "/v1/v1/models"]) {
      expect(await status("GET", path)).toBe(404)
    }
    for (const path of [
      "/responses",
      "/wrong/responses",
      "/wrong/v1/responses",
      "/v1/v1/responses",
      "/responses/compact",
    ]) {
      expect(await status("POST", path, "{}")).toBe(404)
    }

    // The WebSocket upgrade follows the same rule: the wrong path never reaches
    // the upgrade branch.
    const before = mock.state.upgrades
    expect(await wsOpens(`ws://${new URL(mock.url).host}/wrong/v1/responses`)).toBe(false)
    expect(mock.state.upgrades).toBe(before)
    expect(await wsOpens(`ws://${new URL(mock.url).host}/v1/responses`)).toBe(true)
    expect(mock.state.upgrades).toBe(before + 1)
  })

  test("serves a configured reverse-proxy base path and refuses the root or another prefix", async () => {
    mock = await startMockCpaWs({ basePath: "/cpa", responses: () => ({ text: "ws pong" }) })
    expect(new URL(mock.url).pathname).toBe("/cpa")
    const origin = new URL(mock.url).origin
    const status = async (method: string, path: string, body?: string) =>
      (await fetch(`${origin}${path}`, { method, ...(body !== undefined ? { body } : {}) })).status

    expect(await status("GET", "/cpa/v1/models")).toBe(200)
    expect(await status("POST", "/cpa/v1/responses", "{}")).toBe(200)
    expect(await status("POST", "/cpa/v1/responses/compact", "{}")).toBe(200)

    // The root `/v1` routes and any other prefix are not served.
    for (const path of ["/v1/models", "/other/v1/models", "/cpa/v1/v1/models", "/cpa/models"]) {
      expect(await status("GET", path)).toBe(404)
    }
    for (const path of ["/v1/responses", "/other/v1/responses", "/cpa/v1/v1/responses"]) {
      expect(await status("POST", path, "{}")).toBe(404)
    }

    // The WebSocket upgrade is bound to the same base path.
    const before = mock.state.upgrades
    expect(await wsOpens(`ws://${new URL(mock.url).host}/v1/responses`)).toBe(false)
    expect(await wsOpens(`ws://${new URL(mock.url).host}/other/v1/responses`)).toBe(false)
    expect(mock.state.upgrades).toBe(before)
    expect(await wsOpens(`ws://${new URL(mock.url).host}/cpa/v1/responses`)).toBe(true)
    expect(mock.state.upgrades).toBe(before + 1)
  })
})

describe("native Responses WebSocket channel against a stateful mock CPA", () => {
  test("sends a full response.create frame for the first request", async () => {
    mock = await startMockCpaWs({ responses: () => ({ text: "ws pong" }) })
    session = await sessionExecutor()
    const lm = languageModel(mock.url)

    const events = await collect(LLM.request({ model: lm, prompt: "say pong" }), session.executor)

    expect(mock.state.upgrades).toBe(1)
    expect(mock.state.frames).toHaveLength(1)
    const frame = mock.state.frames[0]!
    expect(frame.mode).toBe("create")
    expect(frame.body.type).toBe("response.create")
    expect(frame.body.previous_response_id).toBeUndefined()
    expect(frame.body.model).toBe("gpt-5.2-codex")
    expect(frame.body.stream).toBeUndefined()
    expect(frame.body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "say pong" }],
    })
    const text = events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("")
    expect(text).toBe("ws pong")
  })

  test("sends only the delta with previous_response_id and the server transcript stays correct", async () => {
    mock = await startMockCpaWs({ responses: () => ({ text: "ws pong" }) })
    session = await sessionExecutor()
    const lm = languageModel(mock.url)

    await collect(LLM.request({ model: lm, messages: [Message.user("first")] }), session.executor)
    await collect(
      LLM.request({
        model: lm,
        messages: [Message.user("first"), Message.assistant("ws pong"), Message.user("second")],
      }),
      session.executor,
    )

    expect(mock.state.upgrades).toBe(1)
    expect(mock.state.frames).toHaveLength(2)
    const second = mock.state.frames[1]!
    expect(second.mode).toBe("incremental")
    expect(second.body.previous_response_id).toBe("resp_ws_1")
    // The incremental frame carries the new turn only, not the whole history.
    expect(second.appended).toHaveLength(1)
    expect(JSON.stringify(second.appended)).toContain("second")
    // CPA appends it to what it already stored, so its transcript is the full one.
    expect(JSON.stringify(second.effective)).toContain("first")
    expect(JSON.stringify(second.effective)).toContain("ws pong")
  })

  test("a compacted transcript is sent full and replaces the server transcript", async () => {
    mock = await startMockCpaWs({ responses: () => ({ text: "ws pong" }) })
    session = await sessionExecutor()
    const lm = languageModel(mock.url)

    await collect(LLM.request({ model: lm, messages: [Message.user("first")] }), session.executor)
    await collect(
      LLM.request({
        model: lm,
        messages: [Message.user("first"), Message.assistant("ws pong"), Message.user("second")],
      }),
      session.executor,
    )
    expect(mock.state.frames[1]!.mode).toBe("incremental")

    // What OpenCode sends after a summary compaction: the checkpoint replaces the
    // history and the replayed assistant turn is part of the new transcript.
    const checkpoint =
      "<conversation-checkpoint>\n<summary>\n## Objective\n- keep ponging\n</summary>\n</conversation-checkpoint>"
    await collect(
      LLM.request({
        model: lm,
        messages: [
          Message.user(checkpoint),
          Message.assistant("ws pong"),
          Message.user("after compaction"),
        ],
      }),
      session.executor,
    )

    const third = mock.state.frames[2]!
    expect(third.mode).toBe("replace")
    expect(third.body.previous_response_id).toBeUndefined()
    expect(third.body.type).toBe("response.create")
    // CPA replaces, so the stale turn is not appended a second time.
    expect(JSON.stringify(third.effective)).toContain("keep ponging")
    expect(JSON.stringify(third.effective)).not.toContain("first")
    expect(third.effective).toHaveLength(3)
  })

  test("round-trips a tool call and its result over the socket", async () => {
    mock = await startMockCpaWs({
      responses: (_request, index) =>
        index === 0
          ? { tool: { callId: "call_ws_1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }
          : { text: "the file says hello" },
    })
    session = await sessionExecutor()
    const lm = languageModel(mock.url)

    const first = await collect(LLM.request({ model: lm, prompt: "read a.txt", tools: [READ_TOOL] }), session.executor)
    const call = first.find((event) => event.type === "tool-call") as { id: string; name: string; input: unknown }
    expect(call.name).toBe("read")
    expect(call.id).toBe("call_ws_1")
    expect(call.input).toEqual({ path: "a.txt" })

    await collect(
      LLM.request({
        model: lm,
        messages: [
          Message.user("read a.txt"),
          Message.assistant([ToolCallPart.make({ id: call.id, name: call.name, input: call.input })]),
          Message.tool(ToolResultPart.make({ id: call.id, name: call.name, result: "file says hello" })),
        ],
        tools: [READ_TOOL],
      }),
      session.executor,
    )

    const second = mock.state.frames[1]!
    expect(second.mode).toBe("incremental")
    // The runtime already sent the call, so only the result is new.
    const appended = JSON.stringify(second.appended)
    expect(appended).toContain('"function_call_output"')
    expect(appended).toContain('"call_id":"call_ws_1"')
    // CPA's stored transcript still pairs the call with its result exactly once.
    expect(second.effective!.filter((item) => item.type === "function_call")).toHaveLength(1)
    expect(second.effective!.filter((item) => item.type === "function_call_output")).toHaveLength(1)
  })

  test("an invalid previous_response_id is reported instead of being silently replayed", async () => {
    mock = await startMockCpaWs({
      responses: (_request, index) => (index === 0 ? { text: "first" } : { fail: "previous_response_not_found" }),
    })
    session = await sessionExecutor()
    const lm = languageModel(mock.url)

    await collect(LLM.request({ model: lm, messages: [Message.user("first")] }), session.executor)
    const failure = await collect(
      LLM.request({
        model: lm,
        messages: [Message.user("first"), Message.assistant("first"), Message.user("second")],
      }),
      session.executor,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("previous_response_not_found")
    // The default channel executor does not replay by itself: exactly one frame
    // per request, so an output that already reached the client is never re-sent.
    expect(mock.state.frames).toHaveLength(2)
  })

  test("the native compaction endpoint returns a checkpoint the runtime accepts", async () => {
    mock = await startMockCpaWs({ responses: () => ({ text: "ws pong" }) })
    const lm = languageModel(mock.url)

    const response = await Effect.runPromise(
      LLMClient.compact(
        LLM.request({
          model: lm,
          messages: [Message.user("first"), Message.assistant("ws pong"), Message.user("second")],
        }),
        { mechanism: "endpoint" },
      ).pipe(Effect.provide(AIClient.layer)),
    )

    expect(mock.state.compactions).toHaveLength(1)
    expect(mock.state.compactions[0]!.json.model).toBe("gpt-5.2-codex")
    expect(JSON.stringify(response.replacement)).toContain("compaction")
  })

  test("closing the stream releases the socket", async () => {
    mock = await startMockCpaWs({ responses: () => ({ text: "ws pong" }) })
    const lm = languageModel(mock.url)
    const webSocket = await callExecutor()

    const firstEvent = await Effect.runPromise(
      LLM.stream(LLM.request({ model: lm, prompt: "one" }), { webSocket }).pipe(
        Stream.runHead,
        Effect.provide(AIClient.layer),
      ),
    )
    expect(firstEvent._tag).toBe("Some")
    // The acquisition scope ends with the stream, so the connection is closed.
    for (let attempt = 0; attempt < 20 && mock.state.open > 0; attempt += 1) await sleep(25)
    expect(mock.state.open).toBe(0)
    expect(mock.state.closed).toBe(1)
  })

  test("a refused upgrade surfaces as a transport error rather than a silent HTTP request", async () => {
    mock = await startMockCpaWs({ rejectUpgrade: true })
    const lm = languageModel(mock.url)
    const webSocket = await callExecutor()

    const failure = await collect(LLM.request({ model: lm, prompt: "one" }), webSocket).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toMatch(/WebSocket|websocket/i)
    expect(mock.state.httpResponses).toBe(0)
  })
})
