/**
 * OpenCode v2 TUI entry for the CLIProxyAPI provider.
 *
 * The TUI is a thin view over the server RPC: it reads the connection snapshot,
 * subscribes for changes, and drives the settings wizard. It never contacts CPA
 * and never reads server files, so it also works against a remote server.
 *
 * The wizard verifies an address/key pair before saving it, and the key is read
 * with a masked input: the characters are captured from the renderer and only
 * bullets are drawn, so the key never appears on screen.
 */

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { KeyEvent } from "@opentui/core"
import { createSignal, onCleanup, onMount } from "solid-js"
import { DEFAULT_BASE_URL } from "./address"
import { applyMaskedKey, maskedDisplay } from "./masked-input"
import { CpaRpc } from "./rpc"
import {
  createConnectionView,
  describeDetail,
  describeFooter,
  describePause,
  describeStats,
  type ConnectionReport,
} from "./tui-connection"

const PLUGIN_ID = "opencode2-cliproxyapi-provider.tui"
/** How often the view re-reads the snapshot even without a server push. */
const REFRESH_MS = 15_000

type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

function reportMessage(report: ConnectionReport): string {
  const detail = report.message ? ` — ${report.message}` : ""
  return `${report.kind ?? "error"}${detail}`
}

/** Masked key entry. Resolves with the key, or `undefined` when cancelled. */
function promptKey(context: TuiContext): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      context.ui.dialog.clear()
      resolve(value)
    }
    context.ui.dialog.show(
      () => <KeyInput onDone={finish} />,
      () => {
        if (!settled) {
          settled = true
          resolve(undefined)
        }
      },
    )
  })
}

function KeyInput(props: { onDone: (value: string | undefined) => void }) {
  const context = usePlugin()
  const [length, setLength] = createSignal(0)
  let value = ""

  onMount(() => {
    const handler = (key: KeyEvent) => {
      const outcome = applyMaskedKey(value, key)
      switch (outcome.kind) {
        case "submit":
          key.preventDefault()
          key.stopPropagation()
          props.onDone(outcome.value)
          return
        case "cancel":
          key.preventDefault()
          key.stopPropagation()
          props.onDone(undefined)
          return
        case "value":
          key.preventDefault()
          key.stopPropagation()
          value = outcome.value
          setLength(value.length)
          return
        default:
          return
      }
    }
    context.renderer.keyInput.on("keypress", handler)
    onCleanup(() => context.renderer.keyInput.off("keypress", handler))
  })

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={1}>
      <text fg={context.theme.text.base}>CLIProxyAPI API key</text>
      <text fg={context.theme.text.muted}>{maskedDisplay(length())}</text>
      <text fg={context.theme.text.muted}>
        {length()} characters · Enter to verify before saving · Esc to cancel
      </text>
    </box>
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const directory = context.location?.directory
    const [revision, setRevision] = createSignal(0)
    const view = createConnectionView({
      rpc: context.client.rpc(CpaRpc),
      directory,
      // A persisted preference is recompiled when the location boots; the
      // toggle asks the host to reload so the change reaches the wire at once.
      reload: () => context.client.location.reload(),
      onUpdate: () => setRevision((value) => value + 1),
      // The server keeps a model that disappeared from the directory for a
      // while; selecting it warns instead of promising the upstream serves it.
      onStale: (modelID) => {
        context.ui.toast.show({
          title: "CLIProxyAPI",
          message: `Model '${modelID}' is stale — kept from the last directory read and possibly no longer available upstream.`,
          variant: "warning",
          duration: 8000,
        })
      },
    })
    // The prompt footer tells the view which session is on screen; the stats
    // dialog reads the same session without a second source of truth.
    let currentSessionID: string | undefined

    void view.refresh()
    const unsubscribe = view.subscribe()
    const timer = setInterval(() => void view.refresh(), REFRESH_MS)
    // Any server event is a hint that the snapshot may have moved; re-reading is
    // what makes a reconnect converge even though events are live-only.
    const stopEvents = context.data.listen(() => void view.refresh())

    const runWizard = async () => {
      await view.refresh()
      const current = view.snapshot()
      const address = await context.ui.dialog.prompt({
        title: "CPA address",
        description: "CPA address, including any reverse proxy subpath",
        placeholder: DEFAULT_BASE_URL,
        ...(current?.address ? { value: current.address } : {}),
      })
      if (address === undefined) return
      const key = await promptKey(context)
      if (key === undefined) return
      if (!key.trim()) {
        context.ui.toast.show({ title: "CLIProxyAPI", message: "A key is required", variant: "error" })
        return
      }

      // Verify before saving: a bad pair is reported and nothing is stored.
      const probe = await view.verify(address, key)
      if (!probe.ok) {
        context.ui.toast.show({
          title: "CLIProxyAPI",
          message: `Not saved: ${reportMessage(probe)}`,
          variant: "error",
          duration: 8000,
        })
        return
      }
      const saved = await view.connect(address, key)
      if (!saved.ok) {
        context.ui.toast.show({
          title: "CLIProxyAPI",
          message: `Verified but not saved: ${reportMessage(saved)}`,
          variant: "error",
          duration: 8000,
        })
        return
      }
      context.ui.toast.show({
        title: "CLIProxyAPI",
        message: `Saved and verified: ${saved.models ?? 0} models`,
        variant: "success",
      })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "cliproxyapi.status",
          title: "CLIProxyAPI connection status",
          description: "Show the CPA address, saved credential and verification state",
          group: "CLIProxyAPI",
          palette: true,
          slash: { name: "cpa-status" },
          run: async () => {
            await view.refresh()
            await context.ui.dialog.alert({
              title: "CLIProxyAPI",
              message: describeDetail(view.snapshot(), view.connected(), view.lastError(), view.pause()),
            })
          },
        },
        {
          id: "cliproxyapi.refresh",
          title: "Refresh CLIProxyAPI models",
          description: "Read the CPA directory again, bypassing the cached model list",
          group: "CLIProxyAPI",
          palette: true,
          slash: { name: "cpa-refresh" },
          run: async () => {
            const report = await view.refreshCatalog()
            context.ui.toast.show({
              title: "CLIProxyAPI",
              message: report.ok
                ? `Refreshed: ${report.models ?? 0} models`
                : `Refresh failed: ${reportMessage(report)}`,
              variant: report.ok ? "success" : "error",
              duration: 8000,
            })
          },
        },
        {
          id: "cliproxyapi.connect",
          title: "Connect CLIProxyAPI",
          description: "Verify and save a CPA address and API key",
          group: "CLIProxyAPI",
          palette: true,
          slash: { name: "cpa-connect" },
          run: runWizard,
        },
        {
          id: "cliproxyapi.fast",
          title: "Toggle CLIProxyAPI Fast",
          description: "Ask models that declare service tiers for the priority tier",
          group: "CLIProxyAPI",
          palette: true,
          slash: { name: "cpa-fast" },
          run: async () => {
            await view.refresh()
            const next = !(view.snapshot()?.fastEnabled ?? false)
            const report = await view.setFast(next)
            if (!report.ok) {
              context.ui.toast.show({
                title: "CLIProxyAPI",
                message: `Fast not changed: ${reportMessage(report)}`,
                variant: "error",
                duration: 8000,
              })
              return
            }
            const snapshot = view.snapshot()
            const effective = snapshot?.fastEffectiveModels ?? 0
            context.ui.toast.show({
              title: "CLIProxyAPI",
              message:
                `Fast ${snapshot?.fastEnabled ? "on" : "off"} · ` +
                (snapshot?.fastEnabled && effective === 0
                  ? "no capable model in the directory"
                  : `effective on ${effective} model(s)`),
              variant: "success",
            })
          },
        },
        {
          id: "cliproxyapi.pause",
          title: "Pause CLIProxyAPI requests",
          description: "Stop the next CPA request; a request already in flight still completes",
          group: "CLIProxyAPI",
          palette: true,
          slash: { name: "cpa-pause" },
          run: async () => {
            const next = await view.pauseRequests()
            context.ui.toast.show({
              title: "CLIProxyAPI",
              message: next ? `Requests ${describePause(next)}` : "Pause failed: the server RPC is unreachable",
              variant: next ? "warning" : "error",
            })
          },
        },
        {
          id: "cliproxyapi.resume",
          title: "Resume CLIProxyAPI requests",
          description: "Release the waiting CPA requests; never depends on a model call",
          group: "CLIProxyAPI",
          palette: true,
          slash: { name: "cpa-resume" },
          run: async () => {
            const next = await view.resumeRequests()
            context.ui.toast.show({
              title: "CLIProxyAPI",
              message: next ? `Requests ${describePause(next)}` : "Resume failed: the server RPC is unreachable",
              variant: next ? "success" : "error",
            })
          },
        },
        {
          id: "cliproxyapi.stats",
          title: "CLIProxyAPI session stats",
          description: "Show this session's effective duration, TPS and token/cache usage",
          group: "CLIProxyAPI",
          palette: true,
          slash: { name: "cpa-stats" },
          run: async () => {
            const sessionID = currentSessionID
            await view.reloadStats(sessionID)
            await context.ui.dialog.alert({
              title: "CLIProxyAPI stats",
              message: describeStats(view.stats(sessionID)),
            })
          },
        },
      ],
    }))

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (slotInput) => {
        // Reading the revision makes the footer follow every refresh; the slot
        // input supplies the session whose turn is on screen.
        revision()
        currentSessionID = slotInput.sessionID
        const text = describeFooter(view.snapshot(), view.connected(), view.pause(), view.stats(slotInput.sessionID))
        return (
          <text fg={view.connected() ? context.theme.text.muted : context.theme.text.feedback.error.base}>{text}</text>
        )
      },
    })

    return () => {
      clearInterval(timer)
      unsubscribe()
      stopEvents()
      removeSlot()
    }
  },
})
