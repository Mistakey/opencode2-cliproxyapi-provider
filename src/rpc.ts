/**
 * Portable RPC contract for the CPA connection, pause gate and session stats.
 *
 * The server owns the connection, the directory, the network calls, the pause
 * gate and the stats; a TUI or any other client reads a snapshot and asks for a
 * verify, a switch, a pause/resume or a stats read. The shapes are plain JSON
 * Schema so the plugin keeps no runtime dependency beyond the host.
 */

import { Rpc } from "@opencode/plugin/rpc"

export const RPC_ID = "cliproxyapi"

const sourceEnum = { type: "string", enum: ["options", "env", "stored", "default", "wizard"] }
const verifyKindEnum = { type: "string", enum: ["ok", "empty", "auth", "unreachable", "format", "address"] }

/** Mirrors `ConnectionSnapshot`; optional fields are absent until known. */
export const snapshotSchema = {
  type: "object",
  properties: {
    location: { type: "string" },
    providerID: { type: "string" },
    integrationID: { type: "string" },
    address: { type: "string" },
    addressSource: sourceEnum,
    keySource: sourceEnum,
    keyHint: { type: "string" },
    keySaved: { type: "boolean" },
    verified: { type: "string", enum: ["unknown", "ok", "failed"] },
    verifyKind: verifyKindEnum,
    verifyMessage: { type: "string" },
    catalogModels: { type: "integer" },
    generation: { type: "integer" },
    updatedAt: { type: "number" },
  },
  required: [
    "location",
    "providerID",
    "integrationID",
    "keyHint",
    "keySaved",
    "verified",
    "generation",
    "updatedAt",
  ],
  additionalProperties: false,
} as const

const resultSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    kind: verifyKindEnum,
    message: { type: "string" },
    models: { type: "integer" },
    snapshot: snapshotSchema,
  },
  required: ["ok", "kind", "snapshot"],
  additionalProperties: false,
} as const

/** Mirrors `PauseState`. */
export const pauseStateSchema = {
  type: "object",
  properties: {
    paused: { type: "boolean" },
    changedAt: { type: "number" },
    waiting: { type: "integer" },
    scope: { type: "string", enum: ["location"] },
  },
  required: ["paused", "changedAt", "waiting", "scope"],
  additionalProperties: false,
} as const

/** Mirrors `TokenCounts`. */
export const tokensSchema = {
  type: "object",
  properties: {
    input: { type: "number" },
    output: { type: "number" },
    reasoning: { type: "number" },
    cacheRead: { type: "number" },
    cacheWrite: { type: "number" },
    total: { type: "number" },
  },
  required: ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"],
  additionalProperties: false,
} as const

const turnSchema = {
  type: "object",
  properties: {
    startedAt: { type: "number" },
    endedAt: { type: "number" },
    durationMs: { type: "number" },
    pausedMs: { type: "number" },
    effectiveMs: { type: "number" },
    steps: { type: "integer" },
    retries: { type: "integer" },
    tokens: tokensSchema,
    tps: { type: "number" },
  },
  required: ["startedAt", "durationMs", "pausedMs", "effectiveMs", "steps", "retries", "tokens"],
  additionalProperties: false,
} as const

/** Mirrors `SessionStats`. */
export const sessionStatsSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    parentID: { type: "string" },
    turns: { type: "integer" },
    running: { type: "boolean" },
    steps: { type: "integer" },
    retries: { type: "integer" },
    effectiveMs: { type: "number" },
    tokens: tokensSchema,
    lastTurn: turnSchema,
  },
  required: ["sessionID", "turns", "running", "steps", "retries", "effectiveMs", "tokens"],
  additionalProperties: false,
} as const

const emptyInput = { type: "object", additionalProperties: false } as const

export const CpaRpc = Rpc.define({
  id: RPC_ID,
  methods: {
    /** Read the current connection snapshot; never contacts CPA. */
    status: {
      input: emptyInput,
      output: snapshotSchema,
    },
    /** Check an address/key pair against CPA without saving anything. */
    verify: {
      input: {
        type: "object",
        properties: {
          address: { type: "string" },
          key: { type: "string" },
        },
        required: ["address"],
        additionalProperties: false,
      },
      output: resultSchema,
    },
    /** Verify first, then save through OpenCode's native key method and rebind models. */
    connect: {
      input: {
        type: "object",
        properties: {
          address: { type: "string" },
          key: { type: "string" },
        },
        required: ["address", "key"],
        additionalProperties: false,
      },
      output: resultSchema,
    },
    /** Stop sending the next CPA request; a request already in flight completes. */
    pause: {
      input: emptyInput,
      output: pauseStateSchema,
    },
    /** Release waiting requests. Never depends on a model call. */
    resume: {
      input: emptyInput,
      output: pauseStateSchema,
    },
    /** Read the pause state without changing it. */
    pauseState: {
      input: emptyInput,
      output: pauseStateSchema,
    },
    /** Per-session timing and usage; `undefined`-safe for an unknown session. */
    stats: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { stats: sessionStatsSchema },
        additionalProperties: false,
      },
    },
    /** Every session the server has observed, most recent first. */
    sessions: {
      input: emptyInput,
      output: {
        type: "object",
        properties: { sessions: { type: "array", items: sessionStatsSchema } },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
  },
  events: {
    /** Emitted after every committed connection change. */
    changed: { schema: snapshotSchema },
    /** Emitted after every committed pause/resume. */
    "pause.changed": { schema: pauseStateSchema },
    /** Emitted when a turn boundary moves, not on every step. */
    "stats.changed": { schema: sessionStatsSchema },
  },
})

export type CpaRpcDefinition = typeof CpaRpc
