// Loopback mock CPA with a real Responses WebSocket endpoint.
//
// This is the piece that makes the WebSocket regression meaningful: it is not an
// echo. It models the state machine the real CPA applies to a WebSocket
// transcript (see CLIProxyAPI `openai_responses_websocket_requests.go`):
//
//   * a request carrying `previous_response_id` is appended to the stored
//     transcript;
//   * a request without it that already contains assistant or function_call
//     items replaces the transcript (this is the post-compaction case);
//   * anything else is appended with the last response id.
//
// Every frame is recorded with the mode it took and the transcript the server
// would have sent upstream, so a test can assert on what CPA would have seen
// rather than on what the client sent.
//
// Bun-only: it uses `Bun.serve`'s WebSocket support. The HTTP side of the mock
// stays in `mock-cpa.mjs`, which also runs under node.

import { sseBody, textEvents, toolCallEvents } from "./mock-cpa.mjs"

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/** CPA's `shouldReplaceWebsocketTranscript`, minus the Codex-local summary special case. */
export function inputIsFullTranscript(input) {
  if (!Array.isArray(input)) return false
  for (const item of input) {
    if (!isRecord(item)) continue
    const type = typeof item.type === "string" ? item.type : ""
    if (type === "function_call" || type === "custom_tool_call") return true
    if (type === "message" && item.role === "assistant") return true
  }
  return false
}

/**
 * Apply CPA's WebSocket normalization to one request.
 *
 * `previous` is the connection state: `{ effective, responseID, output }`.
 */
export function normalizeRequest(body, previous) {
  const input = Array.isArray(body.input) ? body.input : []
  if (previous === undefined) {
    return { mode: "create", effective: input, appended: input }
  }
  if (typeof body.previous_response_id === "string" && body.previous_response_id.length > 0) {
    return { mode: "incremental", effective: [...previous.effective, ...input], appended: input }
  }
  if (inputIsFullTranscript(input)) {
    return { mode: "replace", effective: input, appended: input }
  }
  return { mode: "append", effective: [...previous.effective, ...input], appended: input }
}

function sendEvents(ws, events) {
  for (const event of events) ws.send(JSON.stringify(event))
}

function assistantItem(id, text) {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  }
}

/** A native compaction checkpoint, as the Responses `compaction_trigger` expects. */
function checkpointEvents(responseId) {
  const item = { id: "cmp_native_1", type: "compaction", status: "completed", encrypted_content: "enc-native-checkpoint-1" }
  return [
    { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      },
    },
  ]
}

/** True when the frame asks for a native compaction checkpoint. */
export function requestsCompactionCheckpoint(body) {
  return Array.isArray(body?.input) && body.input.some((item) => isRecord(item) && item.type === "compaction_trigger")
}

/**
 * Start the WebSocket mock.
 *
 * Options:
 *   models        enhanced directory listing
 *   requireKey    reject a directory request whose bearer differs
 *   responses     (request, index, info) => reply; reply is one of
 *                 { events }, { text }, { tool }, { fail: code }, { close: "before" | "after-output" }
 */
export async function startMockCpaWs(options = {}) {
  const state = {
    connections: 0,
    open: 0,
    closed: 0,
    upgrades: 0,
    httpRequests: [],
    httpResponses: 0,
    frames: [],
    effective: [],
    compactions: [],
    handshakes: [],
    /** When true the directory answers 503, as an unreachable CPA would. */
    directoryDown: false,
  }
  const models = options.models ?? [{ slug: "probe-model", display_name: "Probe Model", prefer_websockets: true }]
  const replyFor = options.responses ?? (() => ({ text: "ws pong" }))

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        state.httpRequests.push({ method: "GET", path: url.pathname, authorization: req.headers.get("authorization") })
        if (state.directoryDown) return new Response("directory down", { status: 503 })
        if (options.requireKey && req.headers.get("authorization") !== `Bearer ${options.requireKey}`) {
          return Response.json({ error: { message: "invalid api key" } }, { status: 401 })
        }
        return Response.json({ models })
      }
      if (req.method === "POST" && url.pathname.endsWith("/responses/compact")) {
        const raw = await req.text()
        state.httpRequests.push({ method: "POST", path: url.pathname, authorization: req.headers.get("authorization"), raw })
        state.compactions.push({ raw, json: safeJson(raw) })
        return Response.json({
          object: "response.compaction",
          output: [
            { type: "compaction", id: "cmp_1", encrypted_content: "enc-checkpoint-1" },
            {
              type: "message",
              id: "cmp_msg_1",
              role: "user",
              content: [{ type: "input_text", text: "COMPACTION-SUMMARY-MARKER" }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        })
      }
      if (req.method === "POST" && url.pathname.endsWith("/responses")) {
        const raw = await req.text()
        state.httpResponses += 1
        state.httpRequests.push({ method: "POST", path: url.pathname, authorization: req.headers.get("authorization"), raw })
        const reply = await replyFor(
          { raw, json: safeJson(raw) },
          state.httpResponses - 1,
          { transport: "http" },
        )
        if (reply.close) return new Response(null, { status: 204 })
        if (reply.raw !== undefined) {
          return new Response(reply.raw, { status: reply.status ?? 200, headers: { "content-type": reply.contentType ?? "application/json" } })
        }
        if (reply.events) {
          return new Response(sseBody(reply.events), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
        }
        if (reply.status && reply.status >= 400) {
          return Response.json(reply.body ?? { error: { message: "failed" } }, { status: reply.status })
        }
        return new Response(sseBody(textEvents(reply.text ?? "http pong")), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }
      if (url.pathname.endsWith("/responses") && (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        state.upgrades += 1
        state.handshakes.push({ authorization: req.headers.get("authorization"), url: req.url })
        if (options.rejectUpgrade) return new Response("no websocket here", { status: 400 })
        if (srv.upgrade(req, { data: { previous: undefined, count: 0 } })) return undefined
        return new Response("upgrade failed", { status: 400 })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        state.connections += 1
        state.open += 1
      },
      async message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message)
        const body = safeJson(raw)
        const index = state.frames.length
        const previous = ws.data.previous
        const normalized = normalizeRequest(body, previous)
        const responseId = `resp_ws_${index + 1}`
        const record = {
          transport: "ws",
          body,
          mode: normalized.mode,
          effective: normalized.effective,
          appended: normalized.appended,
          previousResponseID: body?.previous_response_id,
        }
        state.frames.push(record)

        const reply = await replyFor({ raw, json: body }, index, { transport: "ws", normalized, ws })
        const trigger = requestsCompactionCheckpoint(body)
        if (reply.fail) {
          ws.data.previous = { effective: normalized.effective, responseID: responseId, output: [] }
          ws.send(
            JSON.stringify({
              type: "response.failed",
              response: { id: responseId, status: "failed", error: { code: reply.fail, message: reply.message ?? reply.fail } },
            }),
          )
          return
        }
        if (reply.close === "before") {
          ws.close(1011, "dropped before the first frame")
          return
        }

        const text = reply.text ?? "ws pong"
        const item = assistantItem(`msg_ws_${index + 1}`, text)
        let events
        if (trigger) {
          events = checkpointEvents(responseId)
        } else if (reply.events) {
          events = reply.events
        } else if (reply.tool) {
          events = toolCallEvents(reply.tool)
        } else {
          events = [
            { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
            { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
            { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response: { id: responseId, object: "response", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
          ]
        }

        if (reply.close === "after-output") {
          sendEvents(ws, events.slice(0, 2))
          ws.close(1011, "dropped after output")
          return
        }
        sendEvents(ws, events)
        const output = events
          .filter((event) => event.type === "response.output_item.done" && event.item)
          .map((event) => event.item)
        ws.data.previous = { effective: [...normalized.effective, ...output], responseID: responseId, output }
      },
      close() {
        state.closed += 1
        state.open -= 1
      },
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    close: () => server.stop(true),
  }
}

function safeJson(raw) {
  try {
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}
