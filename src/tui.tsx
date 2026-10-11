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
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { DEFAULT_BASE_URL } from "./address"
import { applyMaskedKey, maskedDisplay } from "./masked-input"
import { CpaRpc } from "./rpc"
import { createConnectionView, describeConnection, describeDetail, type ConnectionReport } from "./tui-connection"

const PLUGIN_ID = "opencode2-cliproxyapi-provider.tui"
/** How often the view re-reads the snapshot even without a server push. */
const REFRESH_MS = 15_000

type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

function reportMessage(report: ConnectionReport): string {
  const detail = report.message ? ` — ${report.message}` : ""
  return `${report.kind}${detail}`
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
      onUpdate: () => setRevision((value) => value + 1),
    })
    const status = createMemo(() => {
      revision()
      return { text: describeConnection(view.snapshot(), view.connected()), live: view.connected() }
    })

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
              message: describeDetail(view.snapshot(), view.connected(), view.lastError()),
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
      ],
    }))

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <text fg={status().live ? context.theme.text.muted : context.theme.text.feedback.error.base}>
          {status().text}
        </text>
      ),
    })

    return () => {
      clearInterval(timer)
      unsubscribe()
      stopEvents()
      removeSlot()
    }
  },
})
