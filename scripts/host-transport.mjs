#!/usr/bin/env node
/**
 * Isolated host evidence for the transport, failure-recovery and
 * summary-continuation slice.
 *
 * Loads the plugin into the real OpenCode v2 binary with its own
 * config/data/cache/state/home root and a loopback mock CPA that serves both
 * Responses HTTP/SSE and a real Responses WebSocket. The mock is not an echo:
 * it applies CPA's WebSocket transcript state machine, so the checks can assert
 * what CPA would have seen.
 *
 * Covered:
 *   1. `auto` selects WebSocket from the directory preference and reuses one socket
 *   2. a summary reopens the socket so the next turn starts a fresh server state
 *   3. no directory preference keeps HTTP/SSE, and no WebSocket is opened
 *   4. a WebSocket request against an HTTP-only runtime package is diagnosed
 *   5. a refused upgrade does not silently look like a success
 *   6. an invalid previous_response_id is retried with a full transcript
 *   7. stopping the service releases the sockets
 *
 * Nothing here contacts a real CPA and no real credential is used.
 *
 * Bun-only (the mock uses `Bun.serve`).
 *
 * Usage: bun scripts/host-transport.mjs
 * Env:   OPENCODE_CLI    path to the opencode executable
 *        OC2CPA_SANDBOX  sandbox root (default: <repo>/.forge/local/oc2cpa-bya/sandbox/oc2cpa-bya.3)
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { SUMMARY_PROMPT_MARKER } from "../test/support/mock-cpa.mjs"
import { startMockCpaWs } from "../test/support/mock-cpa-ws.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SANDBOX_ROOT =
  process.env.OC2CPA_SANDBOX ?? join(ROOT, ".forge", "local", "oc2cpa-bya", "sandbox", "oc2cpa-bya.3")
const OPENCODE = process.env.OPENCODE_CLI ?? "opencode"

const FAKE_KEY = "sk-fake-transport-0123456789"
const PROVIDER_ID = "cliproxyapi"
const MODEL_ID = "transport-model"
const HTTP_ONLY_PACKAGE = "@opencode/ai/providers/openai-compatible/responses"

const checks = []
const record = (name, ok, detail = "") => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function hostEnv(sandbox, key = FAKE_KEY) {
  const env = {
    ...process.env,
    HOME: join(sandbox, "home"),
    USERPROFILE: join(sandbox, "home"),
    APPDATA: join(sandbox, "appdata"),
    LOCALAPPDATA: join(sandbox, "localappdata"),
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"),
    TMP: join(sandbox, "tmp"),
    TEMP: join(sandbox, "tmp"),
    CLIPROXYAPI_API_KEY: key,
  }
  delete env.CLIPROXYAPI_BASE_URL
  return env
}

function runOpencode(env, cwd, args, timeoutMs = 240_000) {
  return new Promise((settle) => {
    const child = spawn(OPENCODE, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      settle({ code: 1, out: `${out}${String(error)}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      settle({ code, out })
    })
  })
}

async function freePort() {
  const probe = createServer()
  await new Promise((done) => probe.listen(0, "127.0.0.1", done))
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  return port
}

const SUMMARY_TEXT = [
  "## Objective",
  "- TRANSPORT-SUMMARY-MARKER: keep answering",
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

/** Run one isolated host session against its own mock CPA. */
async function withHost(label, config, body) {
  const sandbox = join(SANDBOX_ROOT, label)
  for (const relative of ["home", "appdata", "localappdata", "tmp", "config/opencode", "ws"]) {
    mkdirSync(join(sandbox, relative), { recursive: true })
  }
  const env = hostEnv(sandbox, config.key ?? FAKE_KEY)
  if (config.key === null) delete env.CLIPROXYAPI_API_KEY
  const mock = await startMockCpaWs(config.mock)
  const second = config.secondMock ? await startMockCpaWs(config.secondMock) : undefined
  // Explicit options win over the stored connection, so a rotation scenario must
  // leave them out to be able to switch the connection through the RPC.
  const options = config.noExplicit ? (config.options ?? {}) : { baseURL: mock.url, ...(config.options ?? {}) }
  writeFileSync(
    join(sandbox, "config", "opencode", "opencode.json"),
    `${JSON.stringify(
      { $schema: "https://opencode.ai/config.json", plugins: [{ package: join(ROOT, "src"), options }] },
      null,
      2,
    )}\n`,
  )

  await runOpencode(env, join(sandbox, "ws"), ["service", "stop"])
  await sleep(400)
  for (const relative of ["data", "cache", "state"]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(join(sandbox, relative), { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 20) throw error
        await sleep(200)
      }
    }
  }
  await runOpencode(env, join(sandbox, "ws"), ["service", "set", "port", String(await freePort())])
  const started = await runOpencode(env, join(sandbox, "ws"), ["service", "start"])
  if (started.code !== 0) record(`${label}: isolated service started`, false, started.out.trim().slice(-200))
  try {
    return await body({ sandbox, env, mock, second })
  } finally {
    await runOpencode(env, join(sandbox, "ws"), ["service", "stop"])
    mock.close()
    second?.close()
  }
}

const prompt = (env, sandbox, session, text) =>
  runOpencode(env, join(sandbox, "ws"), [
    "run",
    "-s",
    session,
    "-m",
    `${PROVIDER_ID}/${MODEL_ID}`,
    "--auto",
    text,
  ])

const logText = (sandbox) => {
  const path = join(sandbox, "data", "opencode", "log", "opencode.log")
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

/** Read the plugin's own connection snapshot over the host's RPC. */
async function rpcClient(sandbox) {
  const state = JSON.parse(readFileSync(join(sandbox, "state", "opencode", "service.json"), "utf8"))
  return OpenCode.make({
    baseUrl: state.url,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}` },
  })
}

async function rpcStatus(sandbox, directory) {
  const client = await rpcClient(sandbox)
  const result = await client.rpc.call({
    rpcID: PROVIDER_ID,
    method: "status",
    input: {},
    location: { directory },
  })
  return result.output
}

/** Switch the active connection through the plugin's own RPC. */
async function rpcConnect(sandbox, directory, address, key) {
  const client = await rpcClient(sandbox)
  const result = await client.rpc.call({
    rpcID: PROVIDER_ID,
    method: "connect",
    input: { address, key },
    location: { directory },
  })
  return result.output
}

/** Ask the host to re-resolve the location's plugins after a connection switch. */
async function reloadLocation(sandbox) {
  const client = await rpcClient(sandbox)
  await client.location.reload().catch(() => undefined)
}

async function main() {
  const only = process.env.OC2CPA_ONLY
  const wants = (name) => !only || only === name
  if (wants("ws")) await mainWebSocketAndSummary()
  if (wants("http")) await mainHttp()
  if (wants("diagnostic")) await mainDiagnostics()
  if (wants("recovery")) await mainRecovery()
  if (wants("native")) await mainNative()
  if (wants("parallel")) await mainParallel()
  if (wants("rotation")) await mainRotation()

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

/** 1 + 2: auto -> WebSocket, socket reuse, and a fresh socket after a summary. */
async function mainWebSocketAndSummary() {
  const model = {
    slug: MODEL_ID,
    display_name: "Transport Model",
    prefer_websockets: true,
    context_window: 128_000,
    max_output_tokens: 8_192,
  }
  let primary = 0
  await withHost(
    "transport-ws",
    {
      mock: {
        models: [model],
        responses: (request, _index, info) => {
          const body = request.json ?? {}
          if (typeof body.instructions === "string" && body.instructions.includes("title generator")) {
            return { text: "transport" }
          }
          if (JSON.stringify(body.input ?? []).includes(SUMMARY_PROMPT_MARKER)) return { text: SUMMARY_TEXT }
          primary += 1
          return { text: `answer ${primary}` }
        },
      },
    },
    async ({ sandbox, env, mock }) => {
      const first = await prompt(env, sandbox, "ses_transport", "FIRST-QUESTION: say one")
      record("websocket session run completed", first.code === 0, first.out.trim().split("\n").slice(-1)[0])
      const second = await prompt(env, sandbox, "ses_transport", "SECOND-QUESTION: say two")
      record("second websocket turn completed", second.code === 0, second.out.trim().split("\n").slice(-1)[0])

      record("auto opened a WebSocket from the directory preference", mock.state.upgrades === 1, `upgrades=${mock.state.upgrades}`)
      record("the session reused one socket across turns", mock.state.connections === 1, `connections=${mock.state.connections}`)

      const snapshot = await rpcStatus(sandbox, join(sandbox, "ws"))
      record(
        "the snapshot reports the WebSocket transport and its source",
        snapshot.transport === "websocket" && snapshot.transportSource === "directory",
        `${snapshot.transport}/${snapshot.transportSource}`,
      )
      record(
        "the second turn was sent as an incremental continuation",
        mock.state.frames[1]?.mode === "incremental" && mock.state.frames[1]?.previousResponseID === "resp_ws_1",
        `mode=${mock.state.frames[1]?.mode} prev=${mock.state.frames[1]?.previousResponseID ?? "-"}`,
      )

      const compact = await runOpencode(env, join(sandbox, "ws"), [
        "api",
        "session.compact",
        "--param",
        "sessionID=ses_transport",
        "--data",
        "{}",
      ])
      record("manual compaction was accepted", compact.code === 0, compact.out.trim().slice(0, 120))
      const third = await prompt(env, sandbox, "ses_transport", "THIRD-QUESTION: say three")
      record("post-compaction turn completed", third.code === 0, third.out.trim().split("\n").slice(-1)[0])
      await sleep(1000)

      const summaryRequest = mock.state.httpRequests.some(
        (request) => request.method === "POST" && (request.raw ?? "").includes(SUMMARY_PROMPT_MARKER),
      )
      record("OpenCode produced its own summary", summaryRequest)

      const after = mock.state.frames.at(-1)
      record(
        "the post-compaction turn opened a fresh socket",
        mock.state.upgrades === 2 && mock.state.connections === 2,
        `upgrades=${mock.state.upgrades} connections=${mock.state.connections}`,
      )
      record(
        "the compacted transcript replaced the server state instead of appending to it",
        after?.mode === "create" && after?.previousResponseID === undefined,
        `mode=${after?.mode} prev=${after?.previousResponseID ?? "-"}`,
      )
      const effective = JSON.stringify(after?.effective ?? [])
      record("the old history is gone from the post-compaction transcript", !effective.includes("FIRST-QUESTION"), `${effective.length} chars`)
      record("the summary carried into the post-compaction transcript", effective.includes("TRANSPORT-SUMMARY-MARKER"))

      const stopped = await runOpencode(env, join(sandbox, "ws"), ["service", "stop"])
      for (let attempt = 0; attempt < 40 && mock.state.open > 0; attempt += 1) await sleep(100)
      record("stopping the service released the sockets", stopped.code === 0 && mock.state.open === 0, `open=${mock.state.open}`)
      record("the host log holds no key material", !logText(sandbox).includes(FAKE_KEY))
    },
  )
}

/** 3: no directory preference keeps HTTP/SSE. */
async function mainHttp() {
  await withHost(
    "transport-http",
    {
      mock: {
        models: [{ slug: MODEL_ID, display_name: "Transport Model", context_window: 128_000, max_output_tokens: 8_192 }],
        responses: () => ({ text: "http answer" }),
      },
    },
    async ({ sandbox, env, mock }) => {
      const run = await prompt(env, sandbox, "ses_http", "say one")
      record("http session run completed", run.code === 0, run.out.trim().split("\n").slice(-1)[0])
      record("no WebSocket was opened without a directory preference", mock.state.upgrades === 0, `upgrades=${mock.state.upgrades}`)
      record("the request used HTTP/SSE", mock.state.httpResponses >= 1, `responses=${mock.state.httpResponses}`)
    },
  )
}

/** 4: a WebSocket request against an HTTP-only runtime package is diagnosed. */
async function mainDiagnostics() {
  await withHost(
    "transport-diagnostic",
    {
      options: { transport: "websocket", websocketPackage: HTTP_ONLY_PACKAGE },
      mock: {
        models: [{ slug: MODEL_ID, display_name: "Transport Model", prefer_websockets: true }],
        responses: () => ({ text: "http answer" }),
      },
    },
    async ({ sandbox, env, mock }) => {
      const run = await prompt(env, sandbox, "ses_diag", "say one")
      record("the forced-websocket run still completed", run.code === 0, run.out.trim().split("\n").slice(-1)[0])
      const snapshot = await rpcStatus(sandbox, join(sandbox, "ws"))
      record(
        "the plugin keeps the requested WebSocket transport in the snapshot",
        snapshot.transport === "websocket" && snapshot.transportSource === "option",
        `${snapshot.transport}/${snapshot.transportSource}`,
      )
      record(
        "the plugin diagnoses that the runtime package cannot carry a WebSocket",
        String(snapshot.transportNote ?? "").includes("has no WebSocket channel"),
        snapshot.transportNote ?? "no note",
      )
      record("the request fell back to HTTP/SSE", mock.state.upgrades === 0 && mock.state.httpResponses >= 1, `upgrades=${mock.state.upgrades}`)
    },
  )
}

/** 5 + 6: refused upgrade, and an invalid previous_response_id. */
async function mainRecovery() {
  const recovery = { retried: false }
  await withHost(
    "transport-recovery",
    {
      mock: {
        models: [{ slug: MODEL_ID, display_name: "Transport Model", prefer_websockets: true }],
        responses: (request, index, info) => {
          const body = request.json ?? {}
          if (typeof body.instructions === "string" && body.instructions.includes("title generator")) {
            return { text: "transport" }
          }
          if (info.transport === "ws" && info.normalized.mode === "incremental" && !recovery.retried) {
            recovery.retried = true
            return { fail: "previous_response_not_found" }
          }
          return { text: `answer ${index}` }
        },
      },
    },
    async ({ sandbox, env, mock }) => {
      const first = await prompt(env, sandbox, "ses_recovery", "RECOVERY-FIRST: say one")
      record("first recovery turn completed", first.code === 0, first.out.trim().split("\n").slice(-1)[0])
      const second = await prompt(env, sandbox, "ses_recovery", "RECOVERY-SECOND: say two")
      record("the turn after an invalid continuation completed", second.code === 0, second.out.trim().split("\n").slice(-1)[0])
      await sleep(500)

      const retry = mock.state.frames.find(
        (frame, index) => index > 0 && frame.previousResponseID === undefined && frame.body?.type === "response.create",
      )
      record(
        "the invalid previous_response_id was retried with a full transcript",
        Boolean(retry),
        mock.state.frames.map((frame) => `${frame.mode}${frame.previousResponseID ? "(prev)" : ""}`).join(","),
      )
      const effective = JSON.stringify(retry?.effective ?? [])
      record("the retried transcript is not duplicated", (effective.match(/RECOVERY-SECOND/g) ?? []).length <= 1)
    },
  )

  await withHost(
    "transport-refused",
    {
      mock: {
        rejectUpgrade: true,
        models: [{ slug: MODEL_ID, display_name: "Transport Model", prefer_websockets: true }],
        responses: () => ({ text: "http answer" }),
      },
    },
    async ({ sandbox, env, mock }) => {
      const run = await prompt(env, sandbox, "ses_refused", "say one")
      const fellBack = mock.state.httpResponses >= 1
      record(
        "a refused upgrade either falls back to HTTP or fails, never silently succeeds",
        run.code !== 0 || fellBack,
        `code=${run.code} http=${mock.state.httpResponses} out=${run.out.trim().split("\n").slice(-1)[0]}`,
      )
    },
  )
}

/** native: opt-in provider-side compaction, bounded attempt against CPA's `/responses/compact`. */
async function mainNative() {
  await withHost(
    "transport-native",
    {
      options: { compaction: "native" },
      mock: {
        models: [
          {
            slug: MODEL_ID,
            display_name: "Transport Model",
            prefer_websockets: true,
            context_window: 128_000,
            max_output_tokens: 8_192,
          },
        ],
        responses: (request) => {
          const body = request.json ?? {}
          if (typeof body.instructions === "string" && body.instructions.includes("title generator")) {
            return { text: "transport" }
          }
          return { text: "native answer" }
        },
      },
    },
    async ({ sandbox, env, mock }) => {
      const first = await prompt(env, sandbox, "ses_native", "NATIVE-FIRST: say one")
      record("native session run completed", first.code === 0, first.out.trim().split("\n").slice(-1)[0])
      const snapshot = await rpcStatus(sandbox, join(sandbox, "ws"))
      record("the plugin declared native compaction", snapshot.compaction === "native", String(snapshot.compaction))

      const compact = await runOpencode(env, join(sandbox, "ws"), [
        "api",
        "session.compact",
        "--param",
        "sessionID=ses_native",
        "--data",
        "{}",
      ])
      record("native compaction was accepted", compact.code === 0, compact.out.trim().slice(0, 160))
      const after = await prompt(env, sandbox, "ses_native", "NATIVE-SECOND: say two")
      record("the session continued after native compaction", after.code === 0, after.out.trim().split("\n").slice(-1)[0])
      record(
        "the host requested a native compaction checkpoint",
        mock.state.frames.some((frame) =>
          (frame.body?.input ?? []).some((item) => item?.type === "compaction_trigger"),
        ),
        mock.state.frames.map((frame) => (frame.body?.input ?? []).map((item) => item?.type).join("+")).join(","),
      )
      const carried = mock.state.frames
        .slice(1)
        .some((frame) => (frame.body?.input ?? []).some((item) => item?.type === "compaction"))
      record("the native checkpoint is carried into the next turn", carried)
      const lastFrame = mock.state.frames.at(-1)
      record(
        "the native checkpoint turn started a fresh server state",
        lastFrame?.mode === "create" && lastFrame?.previousResponseID === undefined,
        `mode=${lastFrame?.mode} prev=${lastFrame?.previousResponseID ?? "-"}`,
      )
      record(
        "the native continuation does not replay the model's earlier answer",
        !JSON.stringify(lastFrame?.body?.input ?? []).includes("native answer"),
      )
      if (process.env.SMOKE_DEBUG) {
        console.log(
          JSON.stringify(
            {
              upgrades: mock.state.upgrades,
              http: mock.state.httpRequests.map((request) => [request.method, request.path, (request.raw ?? "").slice(0, 120)]),
              frames: mock.state.frames.map((frame) => [frame.mode, (frame.body?.input ?? []).map((item) => item.type), (frame.body?.type ?? "")]),
              lastInput: mock.state.frames.at(-1)?.body?.input,
            },
            null,
            1,
          ),
        )
      }
    },
  )
}

/** Parallel sessions over WebSocket must not share or corrupt each other's socket. */
async function mainParallel() {
  await withHost(
    "transport-parallel",
    {
      mock: {
        models: [{ slug: MODEL_ID, display_name: "Transport Model", prefer_websockets: true }],
        responses: () => ({ text: "parallel answer" }),
      },
    },
    async ({ sandbox, env, mock }) => {
      const [a, b] = await Promise.all([
        prompt(env, sandbox, "ses_parallel_a", "PARALLEL-A: say a"),
        prompt(env, sandbox, "ses_parallel_b", "PARALLEL-B: say b"),
      ])
      record("parallel websocket sessions both completed", a.code === 0 && b.code === 0, `${a.code}/${b.code}`)
      record("parallel sessions did not share a socket", mock.state.connections >= 2, `connections=${mock.state.connections}`)
      record(
        "every socket handshake carried the bearer key",
        mock.state.handshakes.length >= 2 &&
          mock.state.handshakes.every((handshake) => handshake.authorization === `Bearer ${FAKE_KEY}`),
        mock.state.handshakes.map((handshake) => handshake.authorization).join(","),
      )
    },
  )
}

/** Credential rotation: a switched connection must be used by the next socket. */
async function mainRotation() {
  const keyA = "sk-fake-rotate-a-0001"
  const keyB = "sk-fake-rotate-b-0002"
  await withHost(
    "transport-rotation",
    {
      key: null,
      noExplicit: true,
      mock: {
        requireKey: keyA,
        models: [{ slug: MODEL_ID, display_name: "Rotation A", prefer_websockets: true }],
        responses: () => ({ text: "A answer" }),
      },
      secondMock: {
        requireKey: keyB,
        models: [{ slug: MODEL_ID, display_name: "Rotation B", prefer_websockets: true }],
        responses: () => ({ text: "B answer" }),
      },
    },
    async ({ sandbox, env, mock, second }) => {
      const workspace = join(sandbox, "ws")
      const connectedA = await rpcConnect(sandbox, workspace, mock.url, keyA)
      record("the first connection was saved through the RPC", connectedA.ok === true, String(connectedA.kind))
      await reloadLocation(sandbox)
      await sleep(800)

      const first = await prompt(env, sandbox, "ses_rotate_1", "ROTATE-ONE: say one")
      record("the pre-rotation websocket session completed", first.code === 0, first.out.trim().split("\n").slice(-1)[0])
      record(
        "the pre-rotation socket carried the first key",
        mock.state.handshakes.at(-1)?.authorization === `Bearer ${keyA}`,
        String(mock.state.handshakes.at(-1)?.authorization),
      )

      const connectedB = await rpcConnect(sandbox, workspace, second.url, keyB)
      record("the connection switch was accepted", connectedB.ok === true, String(connectedB.kind))
      await reloadLocation(sandbox)
      await sleep(800)

      const after = await prompt(env, sandbox, "ses_rotate_2", "ROTATE-TWO: say two")
      record("the post-rotation websocket session completed", after.code === 0, after.out.trim().split("\n").slice(-1)[0])
      record(
        "the new socket used the rotated key against the new address",
        second.state.handshakes.at(-1)?.authorization === `Bearer ${keyB}`,
        String(second.state.handshakes.at(-1)?.authorization),
      )
      record(
        "no new socket was opened against the replaced connection",
        mock.state.upgrades === 1,
        `upgrades=${mock.state.upgrades}`,
      )
    },
  )
}

await main()