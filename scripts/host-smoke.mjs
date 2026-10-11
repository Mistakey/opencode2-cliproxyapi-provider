#!/usr/bin/env node
/**
 * Isolated host smoke run for opencode2-cliproxyapi-provider.
 *
 * Loads the plugin into the real OpenCode v2 binary with an isolated
 * config/data/cache/state/home/appdata root and a mock CPA, then checks the
 * wire:
 *
 *   1. the enhanced directory is read with this client's `client_version`
 *   2. a session runs text, a tool call and its result over Responses HTTP/SSE
 *   3. `session.compact` makes OpenCode itself ask the model for a summary and
 *      the next request carries that summary back
 *   4. the fictional key never reaches the host log
 *
 * Nothing here talks to a real CPA and no real credential is used.
 *
 * Usage: bun scripts/host-smoke.mjs   (node also works)
 * Env:   OPENCODE_CLI   path to the opencode executable
 *        OC2CPA_SANDBOX sandbox root (default: <repo>/.forge/local/oc2cpa-bya/sandbox/oc2cpa-bya.1)
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SUMMARY_PROMPT_MARKER, startMockCpa, textReply, toolCallReply } from "../test/support/mock-cpa.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SANDBOX = process.env.OC2CPA_SANDBOX ?? join(ROOT, ".forge", "local", "oc2cpa-bya", "sandbox", "oc2cpa-bya.1")
const OPENCODE = process.env.OPENCODE_CLI ?? "opencode"

const FAKE_KEY = "sk-fake-smoke-0123456789abcdef"
const PROVIDER_ID = "cliproxyapi"
const MODEL_ID = "smoke-model"
const SESSION_ID = "ses_smoke_host"
/** OpenCode validates the summary against its own template, so the mock answers in that shape. */
const SUMMARY_TEXT = [
  "## Objective",
  "- SMOKE-SUMMARY-MARKER: the user asked for pong",
  "",
  "## Requirements",
  "- (none)",
  "",
  "## Decisions",
  "- (none)",
  "",
  "## Work State",
  "- Completed: read smoke.txt",
  "",
  "## Next Move",
  "- none",
].join("\n")
const FILE_LINE = "smoke-file-line"

const checks = []
const record = (name, ok, detail = "") => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const hostEnv = {
  ...process.env,
  HOME: join(SANDBOX, "home"),
  USERPROFILE: join(SANDBOX, "home"),
  APPDATA: join(SANDBOX, "appdata"),
  LOCALAPPDATA: join(SANDBOX, "localappdata"),
  XDG_CONFIG_HOME: join(SANDBOX, "config"),
  XDG_DATA_HOME: join(SANDBOX, "data"),
  XDG_CACHE_HOME: join(SANDBOX, "cache"),
  XDG_STATE_HOME: join(SANDBOX, "state"),
  TMP: join(SANDBOX, "tmp"),
  TEMP: join(SANDBOX, "tmp"),
  CLIPROXYAPI_API_KEY: FAKE_KEY,
}

/**
 * Run one host command asynchronously: the mock CPA lives in this process, so a
 * synchronous wait would stop it from answering the host it is waiting for.
 */
function runOpencode(args, options = {}) {
  return new Promise((settle) => {
    const child = spawn(OPENCODE, args, {
      cwd: options.cwd ?? join(SANDBOX, "ws"),
      env: hostEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 240_000)
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      settle({ status: 1, stdout, stderr: `${stderr}${String(error)}`, output: `${stdout}${stderr}${String(error)}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      settle({ status: code, stdout, stderr, output: `${stdout}${stderr}` })
    })
  })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Reserve a port so two sandboxes in one project cannot fight over the default. */
async function freePort() {
  const probe = createServer()
  await new Promise((done) => probe.listen(0, "127.0.0.1", done))
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  return port
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(500)
  }
  console.log(`      (timed out waiting for ${label})`)
  return false
}

function requestText(request) {
  return request.raw ?? ""
}

async function main() {
  // Create the sandbox first: the host needs the cwd to exist before it runs,
  // and a leftover isolated service holds the data directory.
  for (const relative of ["home", "appdata", "localappdata", "tmp", "config/opencode", "ws"]) {
    mkdirSync(join(SANDBOX, relative), { recursive: true })
  }
  await runOpencode(["service", "stop"])
  await sleep(500)
  for (const relative of ["data", "cache", "state"]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(join(SANDBOX, relative), { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 20) throw error
        await sleep(250)
      }
    }
  }
  writeFileSync(join(SANDBOX, "ws", "smoke.txt"), `${FILE_LINE}\nsecond line\n`)

  let primaryRequests = 0
  const mock = await startMockCpa({
    models: [
      {
        slug: MODEL_ID,
        display_name: "Smoke Model",
        context_window: 128_000,
        max_output_tokens: 8_192,
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
      },
    ],
    responses: (request) => {
      const body = request.json ?? {}
      const instructions = typeof body.instructions === "string" ? body.instructions : ""
      const input = JSON.stringify(body.input ?? [])
      if (instructions.includes("title generator")) return textReply("smoke")
      if (input.includes(SUMMARY_PROMPT_MARKER)) {
        // Keep the host's own summary prompt as evidence that OpenCode, not the
        // plugin, drives compaction.
        writeFileSync(join(SANDBOX, "summary-prompt.txt"), input)
        return textReply(SUMMARY_TEXT)
      }
      primaryRequests += 1
      if (primaryRequests === 1) {
        const readTool = (body.tools ?? []).find((tool) => tool.name === "read")
        const pathKey = Object.keys(readTool?.parameters?.properties ?? {}).find((key) =>
          ["filePath", "path", "file"].includes(key),
        )
        const args = { [pathKey ?? "filePath"]: join(SANDBOX, "ws", "smoke.txt") }
        return toolCallReply({ callId: "call_smoke_read", name: "read", arguments: JSON.stringify(args) })
      }
      return textReply("smoke pong")
    },
  })

  writeFileSync(
    join(SANDBOX, "config", "opencode", "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugins: [{ package: join(ROOT, "src"), options: { baseURL: mock.url } }],
      },
      null,
      2,
    )}\n`,
  )

  console.log(`mock CPA: ${mock.url}`)
  console.log(`sandbox:  ${SANDBOX}`)
  console.log(`host:     ${OPENCODE}`)

  const version = await runOpencode(["--version"])
  record("host reports its version", version.status === 0, version.output.trim().split("\n")[0])

  const port = await freePort()
  await runOpencode(["service", "set", "port", String(port)])
  const started = await runOpencode(["service", "start"])
  record(
    "isolated background service started",
    started.status === 0 && started.output.includes(String(port)),
    started.output.trim().split("\n").slice(-1)[0],
  )

  try {
    const first = await runOpencode([
      "run",
      "-s",
      SESSION_ID,
      "-m",
      `${PROVIDER_ID}/${MODEL_ID}`,
      "--auto",
      "Use the read tool on smoke.txt, then tell me what the first line says.",
    ])
    record("first session run completed", first.status === 0, first.output.trim().split("\n").slice(-1)[0])

    // The location's plugins load with the first session, so the catalog is only
    // in the registry from here on.
    const directory = mock.requests.find((request) => request.method === "GET")
    record(
      "enhanced directory read with this client version",
      Boolean(directory?.query.client_version?.startsWith("opencode2-cliproxyapi-provider/")),
    )
    record("directory request carried the bearer key", directory?.headers.authorization === `Bearer ${FAKE_KEY}`)

    const primary = mock.responses().find((request) => !requestText(request).includes("title generator"))
    record("primary request kept the real CPA model id", primary?.json?.model === MODEL_ID, String(primary?.json?.model))
    record("primary request carried the bearer key", primary?.headers.authorization === `Bearer ${FAKE_KEY}`)

    const toolResult = mock.responses().find((request) => requestText(request).includes('"function_call_output"'))
    record("tool call result was sent back to CPA", Boolean(toolResult))
    record(
      "tool result carried the file content",
      Boolean(toolResult) && requestText(toolResult).includes(FILE_LINE),
    )

    const compact = await runOpencode(["api", "session.compact", "--param", `sessionID=${SESSION_ID}`, "--data", "{}"])
    record("manual compaction was accepted", compact.status === 0, compact.output.trim().slice(0, 200))

    // Compaction runs at the next step boundary, so one more prompt advances it.
    const advance = await runOpencode([
      "run",
      "-s",
      SESSION_ID,
      "-m",
      `${PROVIDER_ID}/${MODEL_ID}`,
      "--auto",
      "Continue from where we were.",
    ])
    record("continuation run completed", advance.status === 0, advance.output.trim().split("\n").slice(-1)[0])

    const sawSummary = await waitFor(
      () => mock.responses().some((request) => requestText(request).includes(SUMMARY_PROMPT_MARKER)),
      90_000,
      "the summary request",
    )
    record("OpenCode asked the model for its own summary over HTTP", sawSummary)

    const after = await runOpencode([
      "run",
      "-s",
      SESSION_ID,
      "-m",
      `${PROVIDER_ID}/${MODEL_ID}`,
      "--auto",
      "One more question: what did we do so far?",
    ])
    record("post-compaction run completed", after.status === 0, after.output.trim().split("\n").slice(-1)[0])

    const summaryIndex = mock.responses().findIndex((request) => requestText(request).includes(SUMMARY_PROMPT_MARKER))
    const carried = mock
      .responses()
      .slice(summaryIndex + 1)
      .some((request) => requestText(request).includes("SMOKE-SUMMARY-MARKER"))
    record("compacted session continued from OpenCode's summary", carried)

    // The session above only ran because the catalog advertised `smoke-model`; an
    // id the directory never listed is refused. A separate session keeps the
    // negative control from touching the compacted one. (`opencode models` and
    // `model.list` resolve a location of their own and are not used as evidence.)
    const bogus = await runOpencode([
      "run",
      "-s",
      "ses_smoke_unknown",
      "-m",
      `${PROVIDER_ID}/not-in-the-directory`,
      "--auto",
      "hi",
    ])
    record(
      "host refuses a model the directory never listed",
      bogus.output.includes("Model unavailable"),
      bogus.output.trim().split("\n").slice(-1)[0],
    )

    for (const [index, request] of mock.responses().entries()) {
      const body = request.json ?? {}
      const marker = requestText(request).includes(SUMMARY_PROMPT_MARKER)
        ? "summary-request"
        : requestText(request).includes("SMOKE-SUMMARY-MARKER")
          ? "carries-summary"
          : String(body.instructions ?? "").includes("title generator")
            ? "title"
            : "primary"
      console.log(`      [${index}] ${marker} input=${Array.isArray(body.input) ? body.input.length : 0} items`)
      if (process.env.SMOKE_DEBUG) console.log(`          ${JSON.stringify(body.input).slice(0, 2000)}`)
    }

    const logPath = join(SANDBOX, "data", "opencode", "log", "opencode.log")
    const hostLog = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
    record("host log exists and holds no key material", hostLog.length > 0 && !hostLog.includes(FAKE_KEY))
    record(
      "mock log holds no real credential",
      !mock.requests.some((request) => JSON.stringify(request.headers).includes("sk-real")),
    )
  } finally {
    const stopped = await runOpencode(["service", "stop"])
    record("background service stopped", stopped.status === 0 || stopped.output.includes("not running"))
    await mock.close()
  }

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
