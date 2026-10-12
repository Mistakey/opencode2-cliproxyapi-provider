#!/usr/bin/env node
/**
 * Minimal real-host combination check: the pause gate and the stats under the
 * WebSocket transport, after a summary, and through the Fast reload path.
 *
 * The single-slice checks live in `host-pause.mjs` and `host-stats.mjs`. This
 * script only covers where the slices meet:
 *
 *   1. the WebSocket transport is actually selected (upgrade + frame)
 *   2. pause holds the next request before any frame, resume sends it
 *   3. interrupting a paused WebSocket session ends the wait without a frame
 *   4. after a summary (compaction) the gate and the stats still work
 *   5. a remote client re-reads the pause snapshot after a disconnect
 *   6. the Fast toggle's location reload cancels a held request (no frame)
 *   7. the stats boundary: a reload starts a new generation, so the old
 *      session's stats are gone (in-memory, per generation)
 *
 * Nothing here talks to a real CPA and no real credential is used.
 *
 * Usage: bun scripts/host-pause-ws.mjs
 * Env:   OPENCODE_CLI   path to the opencode executable
 *        OC2CPA_SANDBOX sandbox directory
 */

import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startMockCpaWs } from "../test/support/mock-cpa-ws.mjs"
import { SUMMARY_PROMPT_MARKER } from "../test/support/mock-cpa.mjs"
import { createChecks, createSandbox, sleep, waitFor } from "../test/support/host-sandbox.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_KEY = "sk-fake-pause-ws-0123456789"
const PROVIDER_ID = "cliproxyapi"
const MODEL_ID = "ws-pause-model"
const SUMMARY_TEXT = [
  "## Objective",
  "- WS-PAUSE-SUMMARY-MARKER: keep answering",
  "",
  "## Requirements",
  "- (none)",
  "",
  "## Decisions",
  "- (none)",
  "",
  "## Work State",
  "- done",
  "",
  "## Next Move",
  "- none",
].join("\n")

const { record, finish } = createChecks()

async function main() {
  let summarySeen = false
  const mock = await startMockCpaWs({
    models: [{ slug: MODEL_ID, display_name: "WS Pause Model", prefer_websockets: true }],
    responses: (request) => {
      const body = request.json ?? {}
      const instructions = typeof body.instructions === "string" ? body.instructions : ""
      const input = JSON.stringify(body.input ?? [])
      if (instructions.includes(SUMMARY_PROMPT_MARKER) || input.includes(SUMMARY_PROMPT_MARKER)) {
        summarySeen = true
        return { text: SUMMARY_TEXT }
      }
      return { text: "ws pong" }
    },
  })

  const sandbox = createSandbox({
    root: ROOT,
    name: "oc2cpa-bya.6-pause-ws",
  })
  await sandbox.prepare()
  sandbox.writeConfig([
    {
      package: join(ROOT, "src"),
      options: { baseURL: mock.url, apiKey: FAKE_KEY, modelsDev: false, transport: "websocket" },
    },
  ])

  const location = ROOT
  const at = { location: { directory: location } }
  console.log(`mock CPA (ws): ${mock.url}`)
  console.log(`sandbox:       ${sandbox.directory}`)

  try {
    const started = await sandbox.startService()
    const client = started.client
    record(
      "isolated background service started",
      started.started.code === 0 && started.started.out.includes("http://127.0.0.1"),
      started.started.out.trim().split("\n").slice(-1)[0],
    )

    const rpc = async (method, input = {}) => (await client.rpc.call({ rpcID: PROVIDER_ID, method, input, ...at })).output
    const pauseState = () => rpc("pauseState")
    const stats = (sessionID) => rpc("stats", { sessionID })
    await client.model.list(at)

    // 1: the transport really is WebSocket, and a session completes over it.
    const first = await sandbox.run(
      ["run", "-s", "ses_ws_first", "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "say pong"],
      { cwd: location },
    )
    record(
      "the WebSocket transport is selected and a session completes",
      first.code === 0 && mock.state.upgrades >= 1 && mock.state.frames.length >= 1,
      `exit ${first.code}, upgrades=${mock.state.upgrades}, frames=${mock.state.frames.length}`,
    )
    const handshakeUrl = mock.state.handshakes.at(-1)?.url
    let handshakePath
    try {
      handshakePath = typeof handshakeUrl === "string" ? new URL(handshakeUrl).pathname : undefined
    } catch {
      handshakePath = undefined
    }
    record(
      "the WebSocket handshake used the normalized /v1/responses path",
      handshakePath === "/v1/responses",
      String(handshakeUrl),
    )
    const wsStats = (await stats("ses_ws_first")).stats
    record(
      "the WebSocket session carries stats",
      wsStats?.turns === 1 && wsStats?.steps >= 1 && wsStats?.tokens?.output > 0 && wsStats?.lastTurn?.tps > 0,
      JSON.stringify({ turns: wsStats?.turns, steps: wsStats?.steps, tps: wsStats?.lastTurn?.tps }),
    )

    // 2: pause holds the next WebSocket request before any frame is sent.
    await rpc("pause")
    const held = sandbox.run(
      ["run", "-s", "ses_ws_held", "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "say pong"],
      { cwd: location },
    )
    const sawWait = await waitFor(async () => (await pauseState()).waiting >= 1, 90_000, "the paused WebSocket call")
    const framesWhileHeld = mock.state.frames.length
    const upgradesWhileHeld = mock.state.upgrades
    await sleep(2000)
    record(
      "a paused WebSocket request sends no frame",
      sawWait && mock.state.frames.length === framesWhileHeld && mock.state.upgrades === upgradesWhileHeld,
      `frames=${mock.state.frames.length} upgrades=${mock.state.upgrades}`,
    )
    await rpc("resume")
    const heldRun = await held
    record(
      "resume releases the WebSocket request and the session completes",
      heldRun.code === 0 && mock.state.frames.length > framesWhileHeld,
      `exit ${heldRun.code}, frames=${mock.state.frames.length}`,
    )

    // 3: interrupting a paused WebSocket session ends the wait without a frame.
    await rpc("pause")
    const session = await client.session.create({ model: { providerID: PROVIDER_ID, id: MODEL_ID }, ...at })
    const prompt = client.session
      .prompt({ sessionID: session.id, text: "hello" }, at)
      .then(() => "settled")
      .catch(() => "rejected")
    const sawCancelWait = await waitFor(async () => (await pauseState()).waiting >= 1, 60_000, "the paused call")
    await sleep(500)
    const framesBeforeInterrupt = mock.state.frames.length
    await client.session.interrupt({ sessionID: session.id }, at)
    const waitEnded = await waitFor(async () => (await pauseState()).waiting === 0, 60_000, "the wait to end")
    record(
      "interrupting a paused WebSocket session ends the wait without a frame",
      sawCancelWait && waitEnded && mock.state.frames.length === framesBeforeInterrupt,
      `frames=${mock.state.frames.length}`,
    )
    await prompt
    await rpc("resume")

    // 4: after a summary the gate and the stats still work.
    await sandbox.run(
      ["run", "-s", "ses_ws_summary", "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "remember the marker"],
      { cwd: location },
    )
    await client.session
      .compact({ sessionID: "ses_ws_summary" }, at)
      .then(() => "accepted")
      .catch((error) => `error ${String(error)}`)
    const afterSummary = await sandbox.run(
      ["run", "-s", "ses_ws_summary", "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "what did we do?"],
      { cwd: location },
    )
    const summaryStats = (await stats("ses_ws_summary")).stats
    await rpc("pause")
    const postSummary = sandbox.run(
      ["run", "-s", "ses_ws_post_summary", "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "say pong"],
      { cwd: location },
    )
    const sawPostSummaryWait = await waitFor(async () => (await pauseState()).waiting >= 1, 90_000, "the paused call")
    const framesPostSummary = mock.state.frames.length
    await rpc("resume")
    const postSummaryRun = await postSummary
    record(
      "after a summary the gate still holds and releases without a deadlock",
      summarySeen &&
        afterSummary.code === 0 &&
        sawPostSummaryWait &&
        postSummaryRun.code === 0 &&
        mock.state.frames.length > framesPostSummary,
      `summary-seen=${summarySeen}, exit ${postSummaryRun.code}`,
    )
    record(
      "the summarized session still carries stats",
      summaryStats?.turns >= 1 && summaryStats?.steps >= 1,
      JSON.stringify({ turns: summaryStats?.turns, steps: summaryStats?.steps, retries: summaryStats?.retries }),
    )

    // 5: a remote client re-reads the pause snapshot after a disconnect.
    const controller = new AbortController()
    const events = []
    const subscription = (async () => {
      try {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          if (event.type === `rpc.${PROVIDER_ID}.pause.changed`) events.push(event)
        }
      } catch {
        // The disconnect is the point of this check.
      }
    })()
    await sleep(300)
    await rpc("pause")
    await sleep(500)
    record(
      "a remote client receives the pause event with its location",
      events.length > 0 && events.at(-1)?.location?.directory === location,
      `${events.length} event(s)`,
    )
    controller.abort()
    await subscription
    await rpc("resume")
    await sleep(300)
    const reread = await pauseState()
    record(
      "a reconnected client re-reads the authoritative pause snapshot",
      reread?.paused === false && reread?.waiting === 0,
      JSON.stringify(reread),
    )

    // 6 + 7: the Fast toggle reloads the location; a held request is cancelled,
    // and the reload starts a new generation with empty in-memory stats.
    await rpc("pause")
    const fastHeld = sandbox.run(
      ["run", "-s", "ses_ws_fast", "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "say pong"],
      { cwd: location },
    )
    const sawFastWait = await waitFor(async () => (await pauseState()).waiting >= 1, 90_000, "the paused call")
    const framesBeforeFast = mock.state.frames.length
    const fastReport = await rpc("setFast", { enabled: true })
    // The TUI performs the reload itself after persisting the preference; the
    // server RPC only stores it. This is the same sequence the TUI runs.
    await client.location.reload().catch((error) => console.log(`reload error ${String(error)}`))
    const fastHeldRun = await fastHeld
    await sleep(3000)
    record(
      "the Fast reload cancels the held request instead of sending it",
      sawFastWait && fastReport?.ok === true && mock.state.frames.length === framesBeforeFast,
      `exit ${fastHeldRun.code}, frames=${mock.state.frames.length}`,
    )
    record(
      "the Fast reload ends the held session instead of leaving it waiting",
      fastHeldRun.code !== null,
      `exit ${fastHeldRun.code}`,
    )
    const afterFast = await pauseState()
    record(
      "the reloaded location starts running, not inheriting the old pause",
      afterFast?.paused === false && afterFast?.waiting === 0,
      JSON.stringify(afterFast),
    )
    const resetStats = await stats("ses_ws_first")
    record(
      "the stats boundary: a reload starts a new generation, so old in-memory stats are gone",
      resetStats?.stats === undefined,
      JSON.stringify(resetStats),
    )

    const log = sandbox.hostLog()
    record("the host log exists and holds no key material", log.length > 0 && !log.includes(FAKE_KEY))
  } finally {
    await sandbox.stopService()
    mock.close()
  }

  finish()
}

await main()
