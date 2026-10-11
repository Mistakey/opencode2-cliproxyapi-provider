#!/usr/bin/env node
/**
 * Isolated host evidence for the CPA pause gate.
 *
 * Loads the plugin into the real OpenCode v2 binary with its own
 * config/data/cache/state/home/appdata root and a loopback mock CPA, then
 * checks the pause semantics only a host can show:
 *
 *   1. a paused CPA request is held before it is sent
 *   2. `resume` releases it without depending on a model call
 *   3. pausing the CPA provider does not gate another provider
 *   4. interrupting a paused session ends the wait and never sends the request
 *   5. reloading the location cancels the held wait instead of sending it
 *   6. stopping the host while a call is paused ends the wait without a request
 *   7. the fictional key never reaches the host log
 *
 * Nothing here talks to a real CPA and no real credential is used.
 *
 * Usage: bun scripts/host-pause.mjs   (node also works)
 * Env:   OPENCODE_CLI   path to the opencode executable
 *        OC2CPA_SANDBOX sandbox directory (default: <repo>/.forge/local/oc2cpa-bya/sandbox/oc2cpa-bya.6-pause)
 */

import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startMockCpa, textReply } from "../test/support/mock-cpa.mjs"
import { createChecks, createSandbox, sleep, waitFor } from "../test/support/host-sandbox.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FAKE_KEY = "sk-fake-pause-host-0123456789"
const PROVIDER_ID = "cliproxyapi"
const RPC_ID = "cliproxyapi"

const { record, finish } = createChecks()

async function main() {
  const cpa = await startMockCpa({
    models: [{ slug: "pause-model", display_name: "Pause Model" }],
    responses: () => textReply("pong"),
  })
  const other = await startMockCpa({
    models: [{ slug: "other-model", display_name: "Other Model" }],
    responses: () => textReply("other pong"),
  })

  const sandbox = createSandbox({
    root: ROOT,
    name: "oc2cpa-bya.6-pause",
    env: { OC2CPA_OTHER_BASE: other.url },
  })
  await sandbox.prepare()
  sandbox.writeConfig([
    { package: join(ROOT, "src"), options: { baseURL: cpa.url, apiKey: FAKE_KEY } },
    { package: join(ROOT, "test", "support", "other-provider") },
  ])

  const location = ROOT
  const at = { location: { directory: location } }
  console.log(`mock CPA:   ${cpa.url}`)
  console.log(`other mock: ${other.url}`)
  console.log(`sandbox:    ${sandbox.directory}`)

  let client
  try {
    const started = await sandbox.startService()
    client = started.client
    record(
      "isolated background service started",
      started.started.code === 0 && started.started.out.includes("http://127.0.0.1"),
      started.started.out.trim().split("\n").slice(-1)[0],
    )

    const rpc = async (method, input = {}) => (await client.rpc.call({ rpcID: RPC_ID, method, input, ...at })).output
    const pauseState = () => rpc("pauseState")

    // Load the workspace location's plugins before calling its RPC.
    await client.model.list(at)

    const initial = await pauseState()
    record(
      "the pause state starts running and is readable over RPC",
      initial?.paused === false && initial?.scope === "location" && initial?.waiting === 0,
      JSON.stringify(initial),
    )

    // 1 + 2: a paused call is held, and an RPC resume releases it.
    const paused = await rpc("pause")
    record("pause is a server-side state change", paused?.paused === true, JSON.stringify(paused))
    const held = sandbox.run(
      ["run", "-s", "ses_pause_hold", "-m", `${PROVIDER_ID}/pause-model`, "--auto", "say pong"],
      { cwd: location },
    )
    const sawWait = await waitFor(async () => (await pauseState()).waiting >= 1, 90_000, "the paused model call")
    record("a paused CPA request waits before it is sent", sawWait && cpa.responses().length === 0, `${cpa.responses().length} request(s)`)

    const resumed = await rpc("resume")
    record("resume is an RPC call, not a model call", resumed?.paused === false, JSON.stringify(resumed))
    const heldRun = await held
    record(
      "resuming releases the held request and the session completes",
      heldRun.code === 0 && cpa.responses().length > 0,
      `exit ${heldRun.code}, ${cpa.responses().length} request(s)`,
    )

    // 3: another provider is not gated by the CPA pause.
    await rpc("pause")
    const cpaPostsBeforeOther = cpa.responses().length
    const otherRun = await sandbox.run(
      ["run", "-s", "ses_other_provider", "-m", "other-cpa/other-model", "--auto", "say hi"],
      { cwd: location },
    )
    record(
      "another provider completes while the CPA provider is paused",
      otherRun.code === 0 && other.responses().length > 0,
      `exit ${otherRun.code}, ${other.responses().length} request(s): ${otherRun.out.trim().split("\n").slice(-2).join(" / ")}`,
    )
    record(
      "the paused CPA provider sent nothing for the other provider's session",
      cpa.responses().length === cpaPostsBeforeOther,
      `${cpa.responses().length} request(s)`,
    )
    await rpc("resume")

    // 4: interrupting a paused session ends the wait and sends nothing.
    await rpc("pause")
    const session = await client.session.create({
      model: { providerID: PROVIDER_ID, id: "pause-model" },
      ...at,
    })
    const prompt = client.session
      .prompt({ sessionID: session.id, text: "hello" }, at)
      .then(() => "settled")
      .catch(() => "rejected")
    const sawCancelWait = await waitFor(async () => (await pauseState()).waiting >= 1, 60_000, "the paused model call")
    await sleep(500)
    const postsBeforeInterrupt = cpa.responses().length
    const interrupted = await client.session.interrupt({ sessionID: session.id }, at)
    const waitEnded = await waitFor(async () => (await pauseState()).waiting === 0, 60_000, "the wait to end")
    record("interrupting a paused session ends the wait", sawCancelWait && waitEnded, `interrupted=${interrupted?.interrupted}`)
    record(
      "the interrupted request was never sent to CPA",
      cpa.responses().length === postsBeforeInterrupt,
      `${cpa.responses().length} request(s)`,
    )
    await prompt
    await rpc("resume")

    // 5: a live location reload cancels the held wait instead of sending it.
    //     The host does not settle an in-flight hook itself; the plugin cancels
    //     it on `location.shutdown`, which is what a reload emits.
    await rpc("pause")
    const reloadRun = sandbox.run(
      ["run", "-s", "ses_pause_reload", "-m", `${PROVIDER_ID}/pause-model`, "--auto", "say pong"],
      { cwd: location, timeoutMs: 90_000 },
    )
    const sawReloadWait = await waitFor(async () => (await pauseState()).waiting >= 1, 60_000, "the paused model call")
    const postsBeforeReload = cpa.responses().length
    await client.location.reload().catch((error) => console.log(`reload error ${String(error)}`))
    const reloadResult = await reloadRun
    const reloadReleased = await waitFor(
      async () => {
        const state = await pauseState().catch(() => undefined)
        return state?.paused === false && state?.waiting === 0
      },
      60_000,
      "the new generation to report running",
    )
    // A grace period, so a retry of the cancelled call would show up here.
    await sleep(3000)
    record(
      "a live location reload cancels the held pause wait instead of sending it",
      sawReloadWait && reloadReleased && cpa.responses().length === postsBeforeReload,
      `exit ${reloadResult.code}, ${cpa.responses().length - postsBeforeReload} request(s) after the reload`,
    )
    record(
      "the cancelled request ends the session instead of leaving it waiting",
      reloadResult.code !== null,
      `exit ${reloadResult.code}`,
    )
    const afterReload = await pauseState()
    record(
      "the reloaded location starts running and does not inherit the old pause",
      afterReload?.paused === false && afterReload?.waiting === 0,
      JSON.stringify(afterReload),
    )

    // The reloaded location's gate is a live, separate instance.
    await rpc("pause")
    const afterReloadRun = sandbox.run(
      ["run", "-s", "ses_pause_after_reload", "-m", `${PROVIDER_ID}/pause-model`, "--auto", "say pong"],
      { cwd: location, timeoutMs: 90_000 },
    )
    const sawSecondWait = await waitFor(async () => (await pauseState()).waiting >= 1, 60_000, "the reloaded gate")
    const postsBeforeSecondResume = cpa.responses().length
    await rpc("resume")
    const afterReloadResult = await afterReloadRun
    record(
      "the reloaded location's pause gate still holds and releases",
      sawSecondWait && afterReloadResult.code === 0 && cpa.responses().length > postsBeforeSecondResume,
      `exit ${afterReloadResult.code}`,
    )

    // 6: stopping the host while a call is paused ends the wait.
    await rpc("pause")
    const stuck = sandbox.run(
      ["run", "-s", "ses_pause_unload", "-m", `${PROVIDER_ID}/pause-model`, "--auto", "say pong"],
      { cwd: location, timeoutMs: 60_000 },
    )
    const sawUnloadWait = await waitFor(async () => (await pauseState()).waiting >= 1, 60_000, "the paused model call")
    const postsBeforeStop = cpa.responses().length
    const stopStarted = Date.now()
    const stopped = await sandbox.stopService()
    const stopMs = Date.now() - stopStarted
    record(
      "stopping the host while a call is paused ends the wait",
      sawUnloadWait && stopped.code === 0 && stopMs < 60_000,
      `exit ${stopped.code} in ${stopMs}ms`,
    )
    record(
      "the unloaded paused request was never sent to CPA",
      cpa.responses().length === postsBeforeStop,
      `${cpa.responses().length} request(s)`,
    )
    await Promise.race([stuck, sleep(20_000)])

    // 7: no credential material in the host log.
    const log = sandbox.hostLog()
    record("the host log exists and holds no key material", log.length > 0 && !log.includes(FAKE_KEY))
  } finally {
    await sandbox.stopService()
    await cpa.close()
    await other.close()
  }

  finish()
}

await main()
