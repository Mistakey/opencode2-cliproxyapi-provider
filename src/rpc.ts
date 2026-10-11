/**
 * Portable RPC contract for the CPA connection.
 *
 * The server owns the connection, the directory and the network calls; a TUI or
 * any other client reads a snapshot and asks for a verify or a switch. The
 * shapes are plain JSON Schema so the plugin keeps no runtime dependency beyond
 * the host.
 */

import { Rpc } from "@opencode/plugin/rpc"

export const RPC_ID = "cliproxyapi"

const sourceEnum = { type: "string", enum: ["options", "env", "stored", "default", "wizard"] }
const verifyKindEnum = { type: "string", enum: ["ok", "empty", "auth", "unreachable", "format", "address"] }
/** Refresh outcomes extend the verify kinds with "nothing was committed". */
const resultKindEnum = {
  type: "string",
  enum: ["ok", "empty", "auth", "unreachable", "format", "address", "stale", "cancelled"],
}

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
    catalogFetchedAt: { type: "number" },
    catalogStaleModels: { type: "integer" },
    catalogStaleIds: { type: "array", items: { type: "string" } },
    catalogFromCache: { type: "boolean" },
    fastEnabled: { type: "boolean" },
    fastEffectiveModels: { type: "integer" },
    costModels: { type: "integer" },
    transport: { type: "string", enum: ["http", "websocket"] },
    transportSource: { type: "string", enum: ["option", "directory", "default"] },
    directoryPrefersWebSocket: { type: "boolean" },
    transportNote: { type: "string" },
    compaction: { type: "string", enum: ["summary", "native"] },
    compactionNote: { type: "string" },
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
    "fastEnabled",
    "fastEffectiveModels",
    "generation",
    "updatedAt",
  ],
  additionalProperties: false,
} as const

const resultSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    kind: resultKindEnum,
    message: { type: "string" },
    models: { type: "integer" },
    snapshot: snapshotSchema,
  },
  required: ["ok", "kind", "snapshot"],
  additionalProperties: false,
} as const

const staleSchema = {
  type: "object",
  properties: { modelID: { type: "string" } },
  required: ["modelID"],
  additionalProperties: false,
} as const

const fastResultSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    message: { type: "string" },
    snapshot: snapshotSchema,
  },
  required: ["ok", "snapshot"],
  additionalProperties: false,
} as const

export const CpaRpc = Rpc.define({
  id: RPC_ID,
  methods: {
    /** Read the current connection snapshot; never contacts CPA. */
    status: {
      input: { type: "object", additionalProperties: false },
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
    /** Read the active connection's directory again, bypassing the cache. */
    refresh: {
      input: { type: "object", additionalProperties: false },
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
    /** Persist the Fast preference. The provider registry is rebuilt at the next location boot. */
    setFast: {
      input: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: fastResultSchema,
    },
  },
  events: {
    /** Emitted after every committed connection change. */
    changed: { schema: snapshotSchema },
    /** Emitted once when a request uses a model retained as stale. */
    stale: { schema: staleSchema },
  },
})

export type CpaRpcDefinition = typeof CpaRpc
