// Mock CPA server used by the integration tests and the isolated host smoke
// run. Plain ESM with no dependencies so `bun` and `node` can both run it.
//
// It implements just enough of the CPA surface this slice touches:
//   GET  /v1/models?client_version=...  -> enhanced directory or plain listing
//   POST /v1/responses                  -> Responses SSE
// Every request is recorded so a test can assert on the wire, not on a mock
// client object.

import { createServer } from "node:http"

export const SUMMARY_PROMPT_MARKER = "You MUST summarize the conversation above into a structured summary"

const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

export function sseBody(events) {
  return events.map(sse).join("")
}

/** Completed text response, in the event order the Responses stream uses. */
export function textEvents(text, options = {}) {
  const itemId = options.itemId ?? "msg_1"
  const responseId = options.responseId ?? "resp_1"
  const item = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  }
  return [
    { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text },
    {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    },
  ]
}

/** Function-call response that asks OpenCode to run one tool. */
export function toolCallEvents(options) {
  const { callId, name, arguments: args } = options
  const itemId = options.itemId ?? "fc_1"
  const responseId = options.responseId ?? "resp_1"
  const item = { id: itemId, type: "function_call", status: "completed", call_id: callId, name, arguments: args }
  return [
    { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: itemId, type: "function_call", status: "in_progress", call_id: callId, name, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: args,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: args,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    },
  ]
}

export const textReply = (text, options) => ({ events: textEvents(text, options) })
export const toolCallReply = (options) => ({ events: toolCallEvents(options) })

function sendReply(res, reply) {
  if (reply.raw !== undefined) {
    res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json" })
    res.end(reply.raw)
    return
  }
  if (reply.events) {
    res.writeHead(reply.status ?? 200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.end(sseBody(reply.events))
    return
  }
  res.writeHead(reply.status ?? 200, { "content-type": "application/json" })
  res.end(JSON.stringify(reply.body ?? {}))
}

/**
 * Start the mock on an ephemeral port.
 *
 * `directory` and `responses` may be a reply object or a function of the
 * recorded request, and the function may return a promise so a test can delay
 * one request while another is in flight. `models` is shorthand for an
 * enhanced directory listing.
 */
export async function startMockCpa(options = {}) {
  const requests = []
  const directoryReply = options.directory ?? { status: 200, body: { models: options.models ?? [] } }
  const responsesReply = options.responses ?? (() => textReply("pong"))

  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      let json
      try {
        json = raw ? JSON.parse(raw) : undefined
      } catch {
        json = undefined
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const record = {
        method: req.method,
        url: req.url,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        raw,
        json,
      }
      requests.push(record)

      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        sendReply(res, await (typeof directoryReply === "function" ? directoryReply(record) : directoryReply))
        return
      }
      if (req.method === "POST" && url.pathname.endsWith("/responses")) {
        const index = requests.filter((entry) => entry.method === "POST").length - 1
        sendReply(res, await (typeof responsesReply === "function" ? responsesReply(record, index) : responsesReply))
        return
      }
      sendReply(res, { status: 404, body: { error: "not found" } })
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    /** Requests that reached the Responses endpoint, in order. */
    responses: () => requests.filter((entry) => entry.method === "POST"),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
