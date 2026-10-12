#!/usr/bin/env node
/**
 * Isolated host evidence for the CPA directory cache, refresh and stale slice.
 *
 * Runs the real OpenCode v2 binary against a loopback mock CPA and checks the
 * behaviour that only exists in a host: a restart serving a matching cache
 * before the background refresh lands, a failed refresh keeping the last
 * directory, a legal empty directory staying distinct from a failure, stale
 * retention and recovery, a stale model warned about when it is requested, the
 * manual refresh RPC, and per-credential cache isolation.
 *
 * Nothing here contacts a real CPA and no real credential is used. The stale
 * window is shortened through the plugin's documented option so expiry is
 * observable inside one run.
 *
 * Usage: bun scripts/host-catalog.mjs   (node also works)
 * Env:   OPENCODE_CLI    path to the opencode executable
 *        OC2CPA_SANDBOX  sandbox root (default: <repo>/.forge/local/oc2cpa-bya/sandbox/oc2cpa-bya.4)
 */

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { startMockCpa, textReply } from "../test/support/mock-cpa.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SANDBOX = process.env.OC2CPA_SANDBOX ?? join(ROOT, ".forge", "local", "oc2cpa-bya", "sandbox", "oc2cpa-bya.4")
const OPENCODE = process.env.OPENCODE_CLI ?? "opencode"
const HOME_DIR = join(SANDBOX, "home")

const PROVIDER_ID = "cliproxyapi"
const KEY_A = "sk-fake-alpha-0123456789"
const KEY_B = "sk-fake-bravo-9876543210"
/** Short enough to observe expiry inside one run; the default is seven days. */
const STALE_TTL_MS = 30_000

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

async function freePort() {
  const probe = createServer()
  await new Promise((done) => probe.listen(0, "127.0.0.1", done))
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  return port
}

function serviceClient() {
  const state = JSON.parse(readFileSync(join(SANDBOX, "state", "opencode", "service.json"), "utf8"))
  return OpenCode.make({
    baseUrl: state.url,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}` },
  })
}

async function main() {
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

  const alpha = { slug: "alpha", display_name: "Alpha", context_window: 64_000 }
  const beta = { slug: "beta", display_name: "Beta", input_modalities: ["text", "image"] }
  const gamma = { slug: "gamma", display_name: "Gamma" }

  // The directory is mutable so the same address can serve, fail, empty and
  // recover across one run.
  let directory = { status: 200, body: { models: [alpha, beta] } }
  const mock = await startMockCpa({
    directory: (request) => {
      if (typeof directory === "function") return directory(request)
      return directory
    },
    responses: () => textReply("pong"),
  })

  writeFileSync(
    join(SANDBOX, "config", "opencode", "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugins: [
          {
            package: join(ROOT, "src"),
            options: { baseURL: mock.url, apiKey: KEY_A, catalogStaleTtlMs: STALE_TTL_MS },
          },
        ],
      },
      null,
      2,
    )}\n`,
  )

  console.log(`mock CPA: ${mock.url}`)
  console.log(`sandbox:  ${SANDBOX}`)

  await runOpencode(["service", "set", "port", String(await freePort())])
  const started = await runOpencode(["service", "start"])
  record("isolated background service started", started.code === 0, started.out.trim().split("\n").slice(-1)[0])

  const rpc = async (method, input) => {
    const result = await serviceClient().rpc.call({
      rpcID: PROVIDER_ID,
      method,
      input,
      location: { directory: HOME_DIR },
    })
    return result.output
  }
  const status = () => rpc("status", {})
  const listedModels = async () => {
    const response = await serviceClient().model.list({ location: { directory: HOME_DIR } })
    return response.data
      .filter((model) => model.providerID === PROVIDER_ID)
      .map((model) => ({ id: model.modelID, status: model.status, enabled: model.enabled }))
  }
  const reload = async () => {
    await serviceClient().location.reload().catch(() => undefined)
    await sleep(300)
  }

  try {
    // 1. A first run reads the directory live and writes the cache.
    await reload()
    const initial = await status()
    const initialModels = await listedModels()
    record(
      "the first run reads the directory live",
      initial.catalogModels === 2 &&
        initial.catalogStaleModels === 0 &&
        initial.catalogFromCache === false &&
        typeof initial.catalogFetchedAt === "number" &&
        initialModels.map((model) => model.id).join(",") === "alpha,beta",
      JSON.stringify({ models: initial.catalogModels, fromCache: initial.catalogFromCache }),
    )

    // 2. A restart serves the matching cache while the refresh is still slow.
    directory = () => new Promise((resolve) => setTimeout(() => resolve({ status: 503, body: { error: "down" } }), 1500))
    await runOpencode(["service", "stop"])
    await sleep(1000)
    await runOpencode(["service", "start"])
    await sleep(300)
    await reload()
    const cached = await status()
    const cachedModels = await listedModels()
    record(
      "a restart serves the matching cache before the background refresh lands",
      cached.catalogFromCache === true &&
        cached.catalogModels === 2 &&
        cachedModels.map((model) => model.id).join(",") === "alpha,beta",
      JSON.stringify({ models: cached.catalogModels, fromCache: cached.catalogFromCache }),
    )

    // 3. The failed background refresh keeps the cached directory.
    await sleep(1800)
    const afterFailure = await status()
    record(
      "a failed background refresh keeps the cached models and reports the failure",
      afterFailure.catalogModels === 2 &&
        afterFailure.verified === "failed" &&
        afterFailure.verifyKind === "unreachable" &&
        (await listedModels()).length === 2,
      JSON.stringify({ verified: afterFailure.verified, kind: afterFailure.verifyKind }),
    )

    // 4. A manual refresh bypasses the cache and marks the missing model stale.
    directory = { status: 200, body: { models: [alpha] } }
    const refreshed = await rpc("refresh", {})
    const stale = await status()
    const staleModels = await listedModels()
    record(
      "manual refresh re-reads the directory and marks the missing model stale",
      refreshed.ok === true &&
        refreshed.models === 2 &&
        stale.catalogStaleModels === 1 &&
        stale.catalogStaleIds.join(",") === "beta" &&
        stale.verified === "ok" &&
        staleModels.map((model) => model.id).join(",") === "alpha,beta",
      JSON.stringify({ models: refreshed.models, stale: stale.catalogStaleIds }),
    )
    // The retained model keeps the same definition, so the runtime dispatches
    // the same thing and no reload is required for the stale mark alone.
    record(
      "a refresh that only marks a model stale needs no reload",
      stale.reloadRequired === false && stale.applied === true,
      JSON.stringify({ applied: stale.applied, reloadRequired: stale.reloadRequired }),
    )
    const betaModel = staleModels.find((model) => model.id === "beta")
    record(
      "a stale model stays registered and selectable while it is retained",
      betaModel?.status === "active" && betaModel?.enabled === true,
      JSON.stringify(betaModel),
    )

    // 5. Requesting the stale model warns instead of promising availability.
    const staleEvents = []
    const controller = new AbortController()
    const subscription = (async () => {
      try {
        for await (const event of serviceClient().event.subscribe({ signal: controller.signal })) {
          if (event.type === `rpc.${PROVIDER_ID}.stale`) staleEvents.push(event)
        }
      } catch {
        // The abort below ends this loop.
      }
    })()
    await sleep(300)
    const staleRun = await runOpencode(["run", "-s", "ses_stale_check", "-m", `${PROVIDER_ID}/beta`, "say pong"])
    await sleep(700)
    controller.abort()
    await subscription
    record(
      "requesting a stale model emits the stale warning",
      staleEvents.some((event) => event.data?.modelID === "beta"),
      `${staleEvents.length} event(s), run exit ${staleRun.code}`,
    )
    // 6. A failed refresh keeps the last good data and its refresh time.
    const fetchedAt = (await status()).catalogFetchedAt
    directory = { status: 503, body: { error: "upstream down" } }
    const failed = await rpc("refresh", {})
    const afterError = await status()
    record(
      "a failed refresh keeps the last directory and its refresh time",
      failed.ok === false &&
        failed.kind === "unreachable" &&
        afterError.catalogModels === 2 &&
        afterError.catalogFetchedAt === fetchedAt &&
        afterError.verified === "failed",
      JSON.stringify({ kind: failed.kind, models: afterError.catalogModels }),
    )

    // 7. A legal empty directory is a success, not a failure.
    directory = { status: 200, body: { models: [] } }
    const emptied = await rpc("refresh", {})
    const emptyStatus = await status()
    record(
      "an empty directory is a success distinct from a failure",
      emptied.ok === true &&
        emptied.kind === "empty" &&
        emptyStatus.verified === "ok" &&
        emptyStatus.catalogModels === 2 &&
        emptyStatus.catalogStaleModels === 2,
      JSON.stringify({ kind: emptied.kind, stale: emptyStatus.catalogStaleModels }),
    )

    // 8. A reappearing model clears its stale mark.
    directory = { status: 200, body: { models: [alpha, beta] } }
    await rpc("refresh", {})
    const recovered = await status()
    const recoveredModels = await listedModels()
    record(
      "a reappearing model clears its stale mark",
      recovered.catalogModels === 2 &&
        recovered.catalogStaleModels === 0 &&
        recoveredModels.every((model) => model.status === "active"),
      JSON.stringify({ stale: recovered.catalogStaleModels }),
    )

    // 9. A model missing beyond the retention window is dropped.
    directory = { status: 200, body: { models: [alpha] } }
    await rpc("refresh", {})
    record("a missing model is retained inside the window", (await status()).catalogStaleModels === 1)
    await sleep(STALE_TTL_MS + 600)
    await rpc("refresh", {})
    const expired = await status()
    record(
      "a model missing beyond the retention window is dropped",
      expired.catalogModels === 1 && expired.catalogStaleModels === 0,
      JSON.stringify({ models: expired.catalogModels, stale: expired.catalogStaleModels }),
    )

    // 10. A second credential never reuses the first credential's directory.
    directory = (request) =>
      request.headers.authorization === `Bearer ${KEY_B}`
        ? { status: 200, body: { models: [gamma] } }
        : { status: 200, body: { models: [alpha, beta] } }
    const switched = await rpc("connect", { address: mock.url, key: KEY_B })
    const betaKeyModels = await listedModels()
    record(
      "switching credential reads the new connection's directory",
      switched.ok === true && betaKeyModels.map((model) => model.id).join(",") === "gamma",
      betaKeyModels.map((model) => model.id).join(","),
    )

    directory = { status: 200, body: { models: [alpha, beta] } }
    const back = await rpc("connect", { address: mock.url, key: KEY_A })
    const alphaKeyModels = await listedModels()
    record(
      "switching back restores that connection's own models without the other's",
      back.ok === true &&
        alphaKeyModels.map((model) => model.id).sort().join(",") === "alpha,beta" &&
        !alphaKeyModels.some((model) => model.id === "gamma"),
      alphaKeyModels.map((model) => model.id).join(","),
    )

    // 11. A reload cancels an in-flight refresh: the superseded plugin instance
    //     must not commit its (older) result into the new one.
    let reloadGets = 0
    directory = () => {
      reloadGets += 1
      if (reloadGets === 1) {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ status: 200, body: { models: [{ slug: "reload-b" }] } }), 2500),
        )
      }
      return { status: 200, body: { models: [alpha, beta] } }
    }
    const inflight = rpc("refresh", {}).catch(() => undefined)
    await sleep(400)
    await serviceClient().location.reload().catch(() => undefined)
    await sleep(5500)
    const afterReload = await status()
    const afterReloadModels = await listedModels()
    record(
      "a reload cancels an in-flight refresh without committing its result",
      reloadGets >= 2 &&
        !afterReloadModels.some((model) => model.id === "reload-b") &&
        afterReloadModels.map((model) => model.id).sort().join(",") === "alpha,beta" &&
        afterReload.catalogModels === 2 &&
        afterReload.applied === true &&
        afterReload.reloadRequired === false,
      JSON.stringify({ gets: reloadGets, models: afterReloadModels.map((model) => model.id), applied: afterReload.applied }),
    )
    await inflight
  } finally {
    await runOpencode(["service", "stop"])
    await mock.close()
  }

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
