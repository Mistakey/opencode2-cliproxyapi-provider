#!/usr/bin/env node
/**
 * Isolated host evidence for the CPA session stats.
 *
 * Loads the plugin into the real OpenCode v2 binary with its own
 * config/data/cache/state/home/appdata root and a loopback mock CPA, then
 * checks the measurement the host, not a unit double, produces:
 *
 *   1. one user prompt with a tool continuation is one turn with two steps
 *   2. input/output/cache/total come from the provider usage the mock reported
 *   3. the turn reports effective duration and whole-turn TPS
 *   4. pause time inside the turn is excluded from the effective duration
 *   5. an unknown session has no stats, and no key reaches state or logs
 *
 * Nothing here talks to a real CPA and no real credential is used.
 *
 * Usage: bun scripts/host-stats.mjs   (node also works)
 * Env:   OPENCODE_CLI   path to the opencode executable
 *        OC2CPA_SANDBOX sandbox directory (default: <repo>/.forge/local/oc2cpa-bya/sandbox/oc2cpa-bya.6-stats)
 */

import { writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startMockCpa, textReply, toolCallReply } from "../test/support/mock-cpa.mjs"
import { createChecks, createSandbox, sleep, waitFor } from "../test/support/host-sandbox.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_KEY = "sk-fake-stats-host-0123456789"
const PROVIDER_ID = "cliproxyapi"
const RPC_ID = "cliproxyapi"
const MODEL_ID = "stats-model"
/** Every mock reply reports this usage, so the expected sums are exact. */
const STEP_INPUT = 11
const STEP_OUTPUT = 7

const { record, finish } = createChecks()

async function main() {
  const sandbox = createSandbox({
    root: ROOT,
    name: "oc2cpa-bya.6-stats",
  })
  await sandbox.prepare()
  writeFileSync(join(sandbox.workspace, "stats.txt"), "stats-file-line\n")

  let primaryRequests = 0
  const cpa = await startMockCpa({
    models: [{ slug: MODEL_ID, display_name: "Stats Model" }],
    responses: (request) => {
      const body = request.json ?? {}
      const instructions = typeof body.instructions === "string" ? body.instructions : ""
      if (instructions.includes("title generator")) return textReply("stats")
      primaryRequests += 1
      if (primaryRequests === 1) {
        const readTool = (body.tools ?? []).find((tool) => tool.name === "read")
        const pathKey = Object.keys(readTool?.parameters?.properties ?? {}).find((key) =>
          ["filePath", "path", "file"].includes(key),
        )
        const args = { [pathKey ?? "filePath"]: join(sandbox.workspace, "stats.txt") }
        return toolCallReply({ callId: "call_stats_read", name: "read", arguments: JSON.stringify(args) })
      }
      return textReply("stats pong")
    },
  })

  sandbox.writeConfig([{ package: join(ROOT, "src"), options: { baseURL: cpa.url, apiKey: FAKE_KEY } }])
  const location = ROOT
  const at = { location: { directory: location } }
  console.log(`mock CPA: ${cpa.url}`)
  console.log(`sandbox:  ${sandbox.directory}`)

  try {
    const started = await sandbox.startService()
    const client = started.client
    record(
      "isolated background service started",
      started.started.code === 0 && started.started.out.includes("http://127.0.0.1"),
      started.started.out.trim().split("\n").slice(-1)[0],
    )

    const rpc = async (method, input = {}) => (await client.rpc.call({ rpcID: RPC_ID, method, input, ...at })).output
    await client.model.list(at)

    // 1 + 2 + 3: a tool continuation inside one turn.
    const toolRun = await sandbox.run(
      ["run", "-s", "ses_stats_tool", "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "Read stats.txt with the read tool, then say pong."],
      { cwd: location },
    )
    record("the tool-continuation session completed", toolRun.code === 0, toolRun.out.trim().split("\n").slice(-1)[0])
    const toolStats = (await rpc("stats", { sessionID: "ses_stats_tool" })).stats
    record(
      "one prompt with a tool continuation is one turn with two steps",
      toolStats?.turns === 1 && toolStats?.running === false && toolStats?.steps === 2 && toolStats?.retries === 0,
      JSON.stringify({ turns: toolStats?.turns, steps: toolStats?.steps, retries: toolStats?.retries }),
    )
    record(
      "tokens are the provider usage the mock reported, summed over the turn",
      toolStats?.tokens?.input === STEP_INPUT * 2 &&
        toolStats?.tokens?.output === STEP_OUTPUT * 2 &&
        toolStats?.tokens?.total === (STEP_INPUT + STEP_OUTPUT) * 2,
      JSON.stringify(toolStats?.tokens),
    )
    record(
      "the turn reports effective duration and whole-turn TPS",
      toolStats?.lastTurn?.effectiveMs > 0 &&
        toolStats?.lastTurn?.durationMs >= toolStats?.lastTurn?.effectiveMs &&
        toolStats?.lastTurn?.tps > 0,
      JSON.stringify({
        effectiveMs: toolStats?.lastTurn?.effectiveMs,
        durationMs: toolStats?.lastTurn?.durationMs,
        tps: toolStats?.lastTurn?.tps,
      }),
    )

    // 4: pause time inside the turn is excluded.
    await rpc("pause")
    const held = sandbox.run(
      ["run", "-s", "ses_stats_pause", "-m", `${PROVIDER_ID}/${MODEL_ID}`, "--auto", "say pong"],
      { cwd: location },
    )
    const sawWait = await waitFor(async () => (await rpc("pauseState")).waiting >= 1, 90_000, "the paused model call")
    await sleep(1500)
    await rpc("resume")
    const heldRun = await held
    record("the paused session completed after resume", sawWait && heldRun.code === 0, `exit ${heldRun.code}`)
    const pausedStats = (await rpc("stats", { sessionID: "ses_stats_pause" })).stats
    record(
      "the paused time is reported and excluded from the effective duration",
      pausedStats?.lastTurn?.pausedMs >= 1200 &&
        pausedStats.lastTurn.effectiveMs < pausedStats.lastTurn.durationMs &&
        Math.abs(
          pausedStats.lastTurn.durationMs - pausedStats.lastTurn.pausedMs - pausedStats.lastTurn.effectiveMs,
        ) <= 2,
      JSON.stringify({
        durationMs: pausedStats?.lastTurn?.durationMs,
        pausedMs: pausedStats?.lastTurn?.pausedMs,
        effectiveMs: pausedStats?.lastTurn?.effectiveMs,
      }),
    )

    // 5: an unknown session has no stats, and the list only carries real ones.
    const unknown = await rpc("stats", { sessionID: "ses_stats_unknown" })
    record("an unknown session has no fabricated stats", unknown?.stats === undefined, JSON.stringify(unknown))
    const listed = (await rpc("sessions")).sessions ?? []
    record(
      "the session list carries both observed sessions, most recent first",
      listed[0]?.sessionID === "ses_stats_pause" && listed.some((entry) => entry.sessionID === "ses_stats_tool"),
      listed.map((entry) => entry.sessionID).join(","),
    )
    const serialized = JSON.stringify({ toolStats, pausedStats, listed })
    record("no key material reaches the stats snapshot", !serialized.includes(FAKE_KEY) && !serialized.includes("sk-fake"))
    const log = sandbox.hostLog()
    record("the host log exists and holds no key material", log.length > 0 && !log.includes(FAKE_KEY))
  } finally {
    await sandbox.stopService()
    await cpa.close()
  }

  finish()
}

await main()
