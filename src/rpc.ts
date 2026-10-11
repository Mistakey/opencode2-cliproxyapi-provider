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
  },
  events: {
    /** Emitted after every committed connection change. */
    changed: { schema: snapshotSchema },
  },
})

export type CpaRpcDefinition = typeof CpaRpc
