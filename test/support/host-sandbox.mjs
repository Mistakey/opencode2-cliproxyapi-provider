// Shared isolated-host sandbox for the pause and stats host scripts.
//
// It starts the real OpenCode binary with its own config/data/cache/state/
// home/appdata/tmp under one sandbox directory and exposes the HTTP client the
// scripts drive. Nothing here touches the user's own OpenCode configuration.

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"

export const OPENCODE_CLI = process.env.OPENCODE_CLI ?? "opencode"

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Reserve a loopback port so two sandboxes in one project cannot collide. */
export async function freePort() {
  const probe = createServer()
  await new Promise((done) => probe.listen(0, "127.0.0.1", done))
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  return port
}

export async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(250)
  }
  console.log(`      (timed out waiting for ${label})`)
  return false
}

export function createSandbox(options) {
  const root = options.root
  const name = options.name
  const directory =
    process.env.OC2CPA_SANDBOX ?? join(root, ".forge", "local", "oc2cpa-bya", "sandbox", name)
  const home = join(directory, "home")
  const workspace = join(directory, "ws")
  const configPath = join(directory, "config", "opencode", "opencode.json")

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(directory, "appdata"),
    LOCALAPPDATA: join(directory, "localappdata"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "state"),
    TMP: join(directory, "tmp"),
    TEMP: join(directory, "tmp"),
    ...(options.env ?? {}),
  }
  delete env.CLIPROXYAPI_API_KEY
  delete env.CLIPROXYAPI_BASE_URL

  const run = (args, runOptions = {}) =>
    new Promise((settle) => {
      const child = spawn(OPENCODE_CLI, args, {
        cwd: runOptions.cwd ?? home,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let out = ""
      child.stdout.on("data", (chunk) => (out += chunk))
      child.stderr.on("data", (chunk) => (out += chunk))
      const timer = setTimeout(() => child.kill(), runOptions.timeoutMs ?? 180_000)
      child.on("error", (error) => {
        clearTimeout(timer)
        settle({ code: 1, out: `${out}${String(error)}` })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        settle({ code, out })
      })
    })

  const serviceState = () => JSON.parse(readFileSync(join(directory, "state", "opencode", "service.json"), "utf8"))

  const prepare = async () => {
    rmSync(directory, { recursive: true, force: true })
    for (const relative of ["home", "appdata", "localappdata", "tmp", "config/opencode", "ws"]) {
      mkdirSync(join(directory, relative), { recursive: true })
    }
    await run(["service", "stop"])
    await sleep(500)
    for (const relative of ["data", "cache", "state"]) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          rmSync(join(directory, relative), { recursive: true, force: true })
          break
        } catch (error) {
          if (attempt >= 20) throw error
          await sleep(250)
        }
      }
    }
  }

  const writeConfig = (plugins) => {
    writeFileSync(configPath, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins }, null, 2)}\n`)
  }

  const startService = async () => {
    const port = await freePort()
    await run(["service", "set", "port", String(port)])
    const started = await run(["service", "start"])
    const state = serviceState()
    const client = OpenCode.make({
      baseUrl: state.url,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}` },
    })
    return { started, state, client }
  }

  const stopService = () => run(["service", "stop"])

  const hostLog = () => {
    const path = join(directory, "data", "opencode", "log", "opencode.log")
    try {
      return readFileSync(path, "utf8")
    } catch {
      return ""
    }
  }

  return { directory, home, workspace, env, configPath, run, prepare, writeConfig, startService, stopService, hostLog }
}

/** Small check recorder shared by the host scripts. */
export function createChecks() {
  const checks = []
  return {
    checks,
    record(name, ok, detail = "") {
      checks.push({ name, ok, detail })
      console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
    },
    finish() {
      const failed = checks.filter((check) => !check.ok)
      console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
      if (failed.length > 0) process.exitCode = 1
      return failed.length === 0
    },
  }
}
