#!/usr/bin/env node
/**
 * Isolated host evidence for the CPA connection slice.
 *
 * Runs the real OpenCode v2 binary against a loopback mock CPA and checks the
 * parts of the connection experience that only exist in a host: the native key
 * and address form, saving through OpenCode's own credential store, the
 * difference between "saved" and "verified", verify-before-save, switching a
 * connection without leaking the previous directory, per-location RPC state, and
 * a remote client that re-reads the snapshot after a disconnect.
 *
 * Nothing here contacts a real CPA and no real credential is used.
 *
 * Usage: bun scripts/host-connection.mjs   (node also works)
 * Env:   OPENCODE_CLI    path to the opencode executable
 *        OC2CPA_SANDBOX  sandbox root (default: <repo>/.forge/local/oc2cpa-bya/sandbox/oc2cpa-bya.2)
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { startMockCpa } from "../test/support/mock-cpa.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SANDBOX = process.env.OC2CPA_SANDBOX ?? join(ROOT, ".forge", "local", "oc2cpa-bya", "sandbox", "oc2cpa-bya.2")
const OPENCODE = process.env.OPENCODE_CLI ?? "opencode"
const HOME_DIR = join(SANDBOX, "home")
const WORKSPACE = join(SANDBOX, "ws")

const PROVIDER_ID = "cliproxyapi"
const KEY_A = "sk-fake-alpha-0123456789"
const KEY_B = "sk-fake-bravo-9876543210"
const WRONG_KEY = "sk-fake-wrong-0000000000"

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
delete hostEnv.CLIPROXYAPI_API_KEY
delete hostEnv.CLIPROXYAPI_BASE_URL

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function runOpencode(args, cwd = HOME_DIR) {
  return new Promise((settle) => {
    const child = spawn(OPENCODE, args, { cwd, env: hostEnv, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    const timer = setTimeout(() => child.kill(), 120_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      settle({ code, out })
    })
  })
}

/** Directory reply that only answers for one key, so 401 is observable. */
function keyedDirectory(key, models) {
  return (request) => {
    if (request.headers.authorization !== `Bearer ${key}`) {
      return { status: 401, body: { error: { message: "invalid api key" } } }
    }
    return { status: 200, body: { models } }
  }
}

/** A loopback port with nothing listening. */
async function closedPort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return `http://127.0.0.1:${port}`
}

/** Reserve a port so two sandboxes cannot fight over the default one. */
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

async function main() {
  // Create the sandbox first: the host needs the cwd to exist before it runs,
  // and any leftover isolated service holds the data directory.
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

  const mockA = await startMockCpa({ directory: keyedDirectory(KEY_A, [{ slug: "alpha-model", display_name: "Alpha" }]) })
  const mockB = await startMockCpa({ directory: keyedDirectory(KEY_B, [{ slug: "beta-model", display_name: "Bravo" }]) })
  const emptyMock = await startMockCpa({ directory: keyedDirectory(KEY_A, []) })
  const brokenMock = await startMockCpa({ directory: { raw: "<html>proxy error</html>", contentType: "text/html" } })
  const authMock = await startMockCpa({ directory: { status: 401, body: { error: { message: "invalid api key" } } } })
  const downMock = await startMockCpa({ directory: { status: 503, body: { error: { message: "upstream down" } } } })
  const goneURL = await closedPort()

  writeFileSync(
    join(SANDBOX, "config", "opencode", "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugins: [{ package: join(ROOT, "src"), options: { baseURL: mockA.url, modelsDev: false } }],
      },
      null,
      2,
    )}\n`,
  )

  console.log(`mock A: ${mockA.url}  mock B: ${mockB.url}`)
  console.log(`sandbox: ${SANDBOX}`)

  await runOpencode(["service", "set", "port", String(await freePort())])
  const started = await runOpencode(["service", "start"])
  record(
    "isolated background service started",
    started.code === 0 && started.out.includes("http://127.0.0.1"),
    started.out.trim().split("\n").slice(-1)[0],
  )

  const state = serviceState()
  const client = OpenCode.make({
    baseUrl: state.url,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}` },
  })
  const at = (directory) => ({ location: { directory } })

  const rpc = async (method, input, directory) => {
    const result = await client.rpc.call({ rpcID: PROVIDER_ID, method, input, location: { directory } })
    return result.output
  }
  const status = (directory) => rpc("status", {}, directory)
  const reload = async () => {
    await client.location.reload().catch(() => undefined)
    await sleep(300)
  }
  const cliproxyapiModels = async (directory) => {
    const response = await client.model.list(at(directory))
    return response.data.filter((model) => model.providerID === PROVIDER_ID).map((model) => model.modelID)
  }

  try {
    // 1. The native key + address form, as the host shows it.
    const integrations = await client.integration.list(at(HOME_DIR))
    const cliproxyapi = integrations.data.find((entry) => entry.id === PROVIDER_ID)
    const keyMethod = cliproxyapi?.methods.find((method) => method.type === "key")
    const addressField = keyMethod?.form?.find((field) => field.key === "baseURL")
    record("host shows the CPA integration with a native key method", Boolean(keyMethod), cliproxyapi?.name)
    record(
      "the native key form carries the CPA address field",
      addressField?.required === true && addressField?.title === "Address",
      JSON.stringify(addressField),
    )

    // 2. The standard entry: OpenCode saves first, the plugin then reports
    //    whether that saved connection actually works.
    await client.integration.connect.key({
      integrationID: PROVIDER_ID,
      key: WRONG_KEY,
      answer: { baseURL: mockA.url },
      ...at(HOME_DIR),
    })
    await reload()
    const savedBad = await status(HOME_DIR)
    record(
      "standard entry saves a bad key and reports it as saved but not verified",
      savedBad?.keySaved === true && savedBad?.verified === "failed" && savedBad?.verifyKind === "auth",
      JSON.stringify({ saved: savedBad?.keySaved, verified: savedBad?.verified, kind: savedBad?.verifyKind }),
    )

    await client.integration.connect.key({
      integrationID: PROVIDER_ID,
      key: KEY_A,
      answer: { baseURL: mockA.url },
      ...at(HOME_DIR),
    })
    await reload()
    const savedGood = await status(HOME_DIR)
    record(
      "standard entry with the right key is saved and verified",
      savedGood?.keySaved === true && savedGood?.verified === "ok" && savedGood?.catalogModels === 1,
      JSON.stringify({ saved: savedGood?.keySaved, verified: savedGood?.verified, models: savedGood?.catalogModels }),
    )
    record(
      "the snapshot reports the connection without the key",
      savedGood?.keyHint === `(redacted, ${KEY_A.length} chars)` && !JSON.stringify(savedGood).includes(KEY_A),
      savedGood?.keyHint,
    )
    record(
      "the snapshot names the configuration sources",
      savedGood?.addressSource === "options" && savedGood?.keySource === "stored",
      `${savedGood?.addressSource}/${savedGood?.keySource}`,
    )

    // 3. verify distinguishes every outcome the acceptance names.
    const outcomes = []
    outcomes.push(["ok", await rpc("verify", { address: mockA.url, key: KEY_A }, HOME_DIR)])
    outcomes.push(["auth", await rpc("verify", { address: mockA.url, key: WRONG_KEY }, HOME_DIR)])
    outcomes.push(["unreachable-http", await rpc("verify", { address: downMock.url, key: KEY_A }, HOME_DIR)])
    outcomes.push(["unreachable-closed", await rpc("verify", { address: goneURL, key: KEY_A }, HOME_DIR)])
    outcomes.push(["empty", await rpc("verify", { address: emptyMock.url, key: KEY_A }, HOME_DIR)])
    outcomes.push(["format", await rpc("verify", { address: brokenMock.url, key: KEY_A }, HOME_DIR)])
    outcomes.push(["address", await rpc("verify", { address: "ftp://cpa.test", key: KEY_A }, HOME_DIR)])
    outcomes.push(["auth-mock", await rpc("verify", { address: authMock.url, key: KEY_A }, HOME_DIR)])
    const observed = Object.fromEntries(outcomes.map(([label, result]) => [label, `${result?.ok}:${result?.kind}`]))
    record(
      "verify reports ok, auth, unreachable, empty, format and address distinctly",
      observed.ok === "true:ok" &&
        observed.auth === "false:auth" &&
        observed["auth-mock"] === "false:auth" &&
        observed["unreachable-http"] === "false:unreachable" &&
        observed["unreachable-closed"] === "false:unreachable" &&
        observed.empty === "true:empty" &&
        observed.format === "false:format" &&
        observed.address === "false:address",
      JSON.stringify(observed),
    )
    const afterProbes = await status(HOME_DIR)
    record(
      "a failed verify changes nothing about the active connection",
      afterProbes?.address === savedGood?.address &&
        afterProbes?.verified === "ok" &&
        afterProbes?.generation === savedGood?.generation,
      `generation ${afterProbes?.generation}`,
    )

    // 4. The wizard verifies before it saves, and switching rebinds the directory.
    const connectionsBefore = (await client.integration.list(at(HOME_DIR))).data.find(
      (entry) => entry.id === PROVIDER_ID,
    )?.connections
    const rejected = await rpc("connect", { address: mockB.url, key: WRONG_KEY }, HOME_DIR)
    const afterReject = await status(HOME_DIR)
    const connectionsAfterReject = (await client.integration.list(at(HOME_DIR))).data.find(
      (entry) => entry.id === PROVIDER_ID,
    )?.connections
    const modelsAfterReject = await cliproxyapiModels(HOME_DIR)
    record(
      "connect refuses an unverified pair and saves nothing",
      rejected?.ok === false && rejected?.kind === "auth" && afterReject?.address === savedGood?.address,
      `${rejected?.kind}`,
    )
    record(
      "a refused connect leaves the credential and the directory intact",
      JSON.stringify(connectionsAfterReject) === JSON.stringify(connectionsBefore) &&
        modelsAfterReject.join(",") === "alpha-model",
      `models ${modelsAfterReject.join(",")}`,
    )

    const switched = await rpc("connect", { address: mockB.url, key: KEY_B }, HOME_DIR)
    const afterSwitch = await status(HOME_DIR)
    const modelsAfterSwitch = await cliproxyapiModels(HOME_DIR)
    record(
      "connect verifies, saves and switches the active connection",
      switched?.ok === true &&
        afterSwitch?.address === mockB.url &&
        afterSwitch?.verified === "ok" &&
        afterSwitch?.verifyMessage === undefined,
      `${afterSwitch?.address} models=${afterSwitch?.catalogModels}`,
    )
    record(
      "the switched connection rebinds the directory without the old models",
      modelsAfterSwitch.join(",") === "beta-model",
      modelsAfterSwitch.join(","),
    )
    const directoryRequests = mockB.requests.filter((request) => request.method === "GET")
    record(
      "the switched directory request used the new address and key",
      directoryRequests.at(-1)?.headers.authorization === `Bearer ${KEY_B}`,
      String(directoryRequests.at(-1)?.headers.authorization),
    )
    // The runtime compiles the provider registry at boot, so a switched
    // connection is saved and visible but not effective until the reload.
    record(
      "a switched connection is reported as pending until the location reloads",
      afterSwitch?.reloadRequired === true && afterSwitch?.applied === false,
      JSON.stringify({ applied: afterSwitch?.applied, reloadRequired: afterSwitch?.reloadRequired }),
    )

    // 5. RPC state is scoped to the location that registered it.
    await client.integration.list(at(WORKSPACE))
    const homeStatus = await status(HOME_DIR)
    const workspaceStatus = await status(WORKSPACE)
    record(
      "each location reports its own connection snapshot",
      homeStatus?.location === HOME_DIR && workspaceStatus?.location === WORKSPACE,
      `${homeStatus?.location === HOME_DIR}/${workspaceStatus?.location === WORKSPACE}`,
    )
    const workspaceConnect = await rpc("connect", { address: mockA.url, key: KEY_A }, WORKSPACE)
    const homeAfterWorkspace = await status(HOME_DIR)
    record(
      "a connect in one location does not overwrite another location's state",
      workspaceConnect?.ok === true &&
        homeAfterWorkspace?.address === mockB.url &&
        homeAfterWorkspace?.generation === homeStatus?.generation,
      `home=${homeAfterWorkspace?.address} generation ${homeAfterWorkspace?.generation}`,
    )

    // 6. A remote client subscribes, drops, and re-reads the snapshot.
    const received = []
    const controller = new AbortController()
    const subscription = (async () => {
      try {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          if (event.type === `rpc.${PROVIDER_ID}.changed`) received.push(event)
        }
      } catch {
        // The disconnect is the point of this check.
      }
    })()
    await sleep(300)
    await rpc("connect", { address: mockA.url, key: KEY_A }, HOME_DIR)
    await sleep(500)
    record(
      "a remote client receives the connection event with its location",
      received.length > 0 && received.at(-1)?.location?.directory === HOME_DIR,
      `${received.length} event(s)`,
    )

    controller.abort()
    await subscription
    const receivedBeforeDisconnect = received.length
    const whileDisconnected = await rpc("connect", { address: mockB.url, key: KEY_B }, HOME_DIR)
    await sleep(300)
    record(
      "events are live only, so a disconnected client misses them",
      received.length === receivedBeforeDisconnect,
      `${received.length} event(s)`,
    )
    const reconnected = await status(HOME_DIR)
    record(
      "a reconnected client re-reads the authoritative snapshot",
      reconnected?.address === mockB.url && reconnected?.generation === whileDisconnected?.snapshot?.generation,
      `${reconnected?.address} generation ${reconnected?.generation}`,
    )

    // 7. Nothing in the host log may carry the key.
    const logPath = join(SANDBOX, "data", "opencode", "log", "opencode.log")
    const hostLog = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
    record(
      "the host log exists and holds no key material",
      hostLog.length > 0 && !hostLog.includes(KEY_A) && !hostLog.includes(KEY_B) && !hostLog.includes(WRONG_KEY),
    )
  } finally {
    await runOpencode(["service", "stop"])
    for (const mock of [mockA, mockB, emptyMock, brokenMock, authMock, downMock]) await mock.close()
  }

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
