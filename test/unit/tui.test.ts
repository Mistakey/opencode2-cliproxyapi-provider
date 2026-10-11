/**
 * TUI entry coverage.
 *
 * The TUI is a thin client: it registers CPA-prefixed commands, reads the
 * server snapshot over RPC and never contacts CPA itself. This test drives the
 * real TUI plugin setup against a fake TUI context so command registration and
 * the Fast toggle are exercised without a terminal.
 */

import { describe, expect, test } from "bun:test"
import tui from "../../src/tui"
import type { ConnectionSnapshot } from "../../src/state"

/** Commands the host already had; the plugin must not take any of these names. */
const HOST_COMMANDS = ["compact", "init", "models", "help", "status"]

type Command = {
  id: string
  slash?: { name: string }
  run: () => unknown
}

function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    location: "/work/one",
    providerID: "cliproxyapi",
    integrationID: "cliproxyapi",
    keyHint: "(redacted, 24 chars)",
    keySaved: true,
    verified: "ok",
    verifyKind: "ok",
    catalogModels: 2,
    fastEnabled: false,
    fastEffectiveModels: 0,
    generation: 1,
    updatedAt: 1,
    ...overrides,
  }
}

type MutableSnapshot = { -readonly [K in keyof ConnectionSnapshot]: ConnectionSnapshot[K] }

function createFakeTui() {
  const server: MutableSnapshot = snapshot()
  const commands: Command[] = []
  const collisions: string[] = []
  const names = new Map<string, "host" | "plugin">(HOST_COMMANDS.map((name) => [name, "host"]))
  const toasts: { message: string; variant?: string }[] = []
  const alerts: string[] = []
  const rpcCalls: { method: string; input: unknown }[] = []
  let reloads = 0

  const ctx = {
    app: { name: "opencode", version: "2.0.26", channel: "latest" },
    location: { directory: "/work/one" },
    client: {
      rpc: () => ({
        status: async (input: unknown) => {
          rpcCalls.push({ method: "status", input })
          return { ...server }
        },
        verify: async (input: unknown) => {
          rpcCalls.push({ method: "verify", input })
          return { ok: true, kind: "ok", models: 2, snapshot: { ...server } }
        },
        connect: async (input: unknown) => {
          rpcCalls.push({ method: "connect", input })
          return { ok: true, kind: "ok", models: 2, snapshot: { ...server } }
        },
        setFast: async (input: { enabled: boolean }) => {
          rpcCalls.push({ method: "setFast", input })
          server.fastEnabled = input.enabled
          server.fastEffectiveModels = input.enabled ? 2 : 0
          return { ok: true, snapshot: { ...server } }
        },
        events: { on: () => () => undefined },
      }),
      location: {
        reload: async () => {
          reloads += 1
        },
      },
    },
    data: { listen: () => () => undefined },
    keymap: {
      layer: (build: () => { mode: string; commands: Command[] }) => {
        for (const command of build().commands) {
          commands.push(command)
          const name = command.slash?.name
          if (!name) continue
          if (names.has(name)) collisions.push(name)
          names.set(name, "plugin")
        }
        return () => undefined
      },
    },
    ui: {
      dialog: {
        alert: async (input: { message: string }) => {
          alerts.push(input.message)
        },
        prompt: async () => undefined,
        clear: () => undefined,
        show: () => undefined,
      },
      toast: {
        show: (input: { message: string; variant?: string }) => {
          toasts.push(input)
        },
      },
      slot: () => () => undefined,
    },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: { error: { base: "#ff0000" } } } },
    renderer: { keyInput: { on: () => undefined, off: () => undefined } },
  }

  return {
    ctx,
    commands,
    collisions,
    names,
    toasts,
    alerts,
    rpcCalls,
    reloads: () => reloads,
  }
}

async function setup() {
  const fake = createFakeTui()
  const cleanup = await tui.setup(fake.ctx as never)
  return { fake, cleanup }
}

describe("TUI entry", () => {
  test("registers CPA-prefixed commands without taking an existing host command", async () => {
    const { fake, cleanup } = await setup()
    try {
      expect(fake.commands.map((command) => command.slash?.name)).toEqual(["cpa-status", "cpa-connect", "cpa-fast"])
      expect(fake.commands.map((command) => command.id)).toEqual([
        "cliproxyapi.status",
        "cliproxyapi.connect",
        "cliproxyapi.fast",
      ])
      expect(fake.collisions).toEqual([])
      for (const name of HOST_COMMANDS) expect(fake.names.get(name)).toBe("host")
    } finally {
      await cleanup?.()
    }
  })

  test("/cpa-status reads the server snapshot and never contacts CPA", async () => {
    const { fake, cleanup } = await setup()
    try {
      const command = fake.commands.find((entry) => entry.slash?.name === "cpa-status")!
      await command.run()
      expect(fake.rpcCalls.map((call) => call.method)).toContain("status")
      expect(fake.alerts.at(-1)).toContain("fast: off (effective on 0 model(s))")
      expect(fake.alerts.at(-1)).toContain("models.dev estimate for 0 model(s), not a CPA bill")
    } finally {
      await cleanup?.()
    }
  })

  test("/cpa-fast persists the preference and reloads the location so it reaches the wire", async () => {
    const { fake, cleanup } = await setup()
    try {
      const command = fake.commands.find((entry) => entry.slash?.name === "cpa-fast")!

      await command.run()
      expect(fake.rpcCalls.filter((call) => call.method === "setFast").at(-1)).toEqual({
        method: "setFast",
        input: { enabled: true },
      })
      expect(fake.reloads()).toBe(1)
      expect(fake.toasts.at(-1)?.message).toContain("Fast on · effective on 2 model(s)")

      await command.run()
      expect(fake.rpcCalls.filter((call) => call.method === "setFast").at(-1)).toEqual({
        method: "setFast",
        input: { enabled: false },
      })
      expect(fake.reloads()).toBe(2)
      expect(fake.toasts.at(-1)?.message).toContain("Fast off")
    } finally {
      await cleanup?.()
    }
  })
})
