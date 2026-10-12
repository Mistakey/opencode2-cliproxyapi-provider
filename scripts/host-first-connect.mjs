#!/usr/bin/env node
/**
 * Isolated host evidence for the first connect after an unconfigured boot.
 *
 * When no key is configured (or the first directory read fails), the plugin
 * registers no provider binding at boot. This script starts the real OpenCode v2
 * service in that state, connects the first CPA pair, and checks the two-phase
 * boundary on the real host: the snapshot reports the binding as applied, and
 * the runtime really dispatches the newly registered model without a location
 * reload. The host compiles an empty boot registry, so a later registration is
 * effective on its own; this is the "empty-table" host behaviour the D11
 * reload boundary must not contradict.
 *
 * Nothing here contacts a real CPA and no real credential is used.
 *
 * Usage: bun scripts/host-first-connect.mjs   (node also works)
 * Env:   OPENCODE_CLI    path to the opencode executable
 *        OC2CPA_SANDBOX  sandbox root (default: <repo>/.forge/local/oc2cpa-bya/sandbox/oc2cpa-bya.21)
 */

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { startMockCpa } from "../test/support/mock-cpa.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SANDBOX = process.env.OC2CPA_SANDBOX ?? join(ROOT, ".forge", "local", "oc2cpa-bya", "sandbox", "oc2cpa-bya.21")
const OPENCODE = process.env.OPENCODE_CLI ?? "opencode"
const HOME_DIR = join(SANDBOX, "home")
const WORKSPACE = join(SANDBOX, "ws")

const PROVIDER_ID = "cliproxyapi"
const KEY = "sk-fake-first-0123456789"
const MODEL_ID = "first-model"

const checks = []
const record = (name, ok, detail = "") => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const hostEnv = {
  ...process.env,
  HOME: HOME_DIR,
  USERPROFILE: HOME_DIR,
  APPDATA: join(SANDBOX, "appdata"),
  LOCALAPPDATA: join(SANDBOX, "localappdata"),
  XDG_CONFIG_HOME: join(SANDBOX, "config"),
  XDG_DATA_HOME: join(SANDBOX, "data"),
  XDG_CACHE_HOME: join(SANDBOX, "cache"),
  XDG_STATE_HOME: join(SANDBOX, "state"),
  TMP: join(SANDBOX, "tmp"),
  TEMP: join(SANDBOX, "tmp"),
}
const clearKeyEnv = () => {
  delete hostEnv.CLIPROXYAPI_API_KEY
  delete hostEnv.CLIPROXYAPI_BASE_URL
}
clearKeyEnv()

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function runOpencode(args, options = {}) {
  return new Promise((settle) => {
    const child = spawn(OPENCODE, args, {
      cwd: options.cwd ?? WORKSPACE,
      env: hostEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 180_000)
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

function serviceState() {
  return JSON.parse(readFileSync(join(SANDBOX, "state", "opencode", "service.json"), "utf8"))
}

function writePluginConfig(options) {
  writeFileSync(
    join(SANDBOX, "config", "opencode", "opencode.json"),
    `${JSON.stringify(
      { $schema: "https://opencode.ai/config.json", plugins: [{ package: join(ROOT, "src"), options }] },
      null,
      2,
    )}\n`,
  )
}

async function resetSandbox() {
  for (const relative of ["home", "appdata", "localappdata", "tmp", "config/opencode", "ws"]) {
    mkdirSync(join(SANDBOX, relative), { recursive: true })
  }
  await runOpencode(["service", "stop"], { cwd: HOME_DIR })
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
}

async function startService() {
  await runOpencode(["service", "set", "port", String(await freePort())], { cwd: HOME_DIR })
  const started = await runOpencode(["service", "start"], { cwd: HOME_DIR })
  const state = serviceState()
  const client = OpenCode.make({
    baseUrl: state.url,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}` },
  })
  return { started, state, client }
}

function makeRpc(client) {
  const at = { location: { directory: WORKSPACE } }
  return async (method, input) => (await client.rpc.call({ rpcID: PROVIDER_ID, method, input, ...at })).output
}

const runModel = (sessionID) =>
  runOpencode(["run", "-s", sessionID, "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "reply with one short word"])

async function main() {
  await resetSandbox()

  // --- Phase A: unconfigured boot, then the first wizard connect -------------
  clearKeyEnv()
  const mockA = await startMockCpa({ models: [{ slug: MODEL_ID, display_name: "First Model" }] })
  writePluginConfig({ modelsDev: false })
  console.log(`mock A: ${mockA.url}`)
  console.log(`sandbox: ${SANDBOX}`)

  const serviceA = await startService()
  record(
    "isolated background service started",
    serviceA.started.code === 0 && serviceA.started.out.includes("http://127.0.0.1"),
    serviceA.started.out.trim().split("\n").slice(-1)[0],
  )
  const rpcA = makeRpc(serviceA.client)
  try {
    const before = await rpcA("status", {})
    record(
      "the unconfigured boot registers no provider binding",
      before?.keySaved === false && (before?.catalogModels ?? 0) === 0,
      JSON.stringify({ keySaved: before?.keySaved, models: before?.catalogModels }),
    )

    const connected = await rpcA("connect", { address: mockA.url, key: KEY })
    record(
      "the first wizard connect verifies and saves the pair",
      connected?.ok === true && connected?.snapshot?.keySaved === true && connected?.snapshot?.verified === "ok",
      JSON.stringify({ ok: connected?.ok, verified: connected?.snapshot?.verified, models: connected?.models }),
    )

    const after = await rpcA("status", {})
    record(
      "the first connect is reported as applied, not as a pending reload",
      after?.applied === true && after?.reloadRequired === false && after?.catalogModels === 1,
      JSON.stringify({ applied: after?.applied, reloadRequired: after?.reloadRequired, models: after?.catalogModels }),
    )

    const requestsBefore = mockA.responses().length
    const run = await runModel("ses_first_connect")
    record(
      "the runtime dispatches the newly registered model without a location reload",
      mockA.responses().length > requestsBefore && run.code === 0,
      `responses +${mockA.responses().length - requestsBefore}: ${run.out.trim().split("\n").slice(-1)[0]}`,
    )
  } finally {
    await runOpencode(["service", "stop"], { cwd: HOME_DIR })
    await mockA.close()
  }

  // --- Phase B: the first directory read fails, then recovers ----------------
  await resetSandbox()
  let up = false
  const mockB = await startMockCpa({
    directory: () => (up ? { status: 200, body: { models: [{ slug: MODEL_ID, display_name: "First Model" }] } } : { status: 503, body: { error: "down" } }),
  })
  hostEnv.CLIPROXYAPI_API_KEY = KEY
  writePluginConfig({ baseURL: mockB.url, modelsDev: false })

  const serviceB = await startService()
  const rpcB = makeRpc(serviceB.client)
  try {
    const failed = await rpcB("status", {})
    record(
      "a failing first directory read is saved but not verified",
      failed?.keySaved === true && failed?.verified === "failed" && (failed?.catalogModels ?? 0) === 0,
      JSON.stringify({ keySaved: failed?.keySaved, verified: failed?.verified, models: failed?.catalogModels }),
    )

    up = true
    const recovered = await rpcB("refresh", {})
    record(
      "the first successful read after a failed boot is reported as applied",
      recovered?.ok === true &&
        recovered?.snapshot?.applied === true &&
        recovered?.snapshot?.reloadRequired === false &&
        recovered?.models === 1,
      JSON.stringify({ ok: recovered?.ok, applied: recovered?.snapshot?.applied, models: recovered?.models }),
    )

    const requestsBefore = mockB.responses().length
    const run = await runModel("ses_recovered_connect")
    record(
      "the runtime dispatches the recovered directory without a location reload",
      mockB.responses().length > requestsBefore && run.code === 0,
      `responses +${mockB.responses().length - requestsBefore}: ${run.out.trim().split("\n").slice(-1)[0]}`,
    )
  } finally {
    await runOpencode(["service", "stop"], { cwd: HOME_DIR })
    await mockB.close()
  }

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
