export interface WsReply {
  readonly text?: string
  readonly events?: readonly Record<string, unknown>[]
  readonly tool?: { callId: string; name: string; arguments: string; itemId?: string; responseId?: string }
  readonly fail?: string
  readonly message?: string
  readonly close?: "before" | "after-output"
  readonly raw?: string
  readonly status?: number
  readonly body?: unknown
  readonly contentType?: string
}

export interface WsFrame {
  readonly transport: "ws" | "http"
  readonly body: any
  readonly mode?: "create" | "incremental" | "replace" | "append"
  readonly effective?: readonly any[]
  readonly appended?: readonly any[]
  readonly previousResponseID?: string
}

export interface WsHttpRequest {
  readonly method: string
  readonly path: string
  readonly authorization?: string | null
  readonly raw?: string
}

export interface WsHandshake {
  readonly authorization?: string | null
  readonly url?: string
}

export interface MockCpaWsState {
  connections: number
  open: number
  closed: number
  upgrades: number
  httpRequests: WsHttpRequest[]
  httpResponses: number
  frames: WsFrame[]
  effective: readonly any[]
  compactions: { raw: string; json: any }[]
  handshakes: WsHandshake[]
  directoryDown: boolean
}

export interface MockCpaWs {
  readonly url: string
  readonly state: MockCpaWsState
  close(): void
}

export declare function inputIsFullTranscript(input: unknown): boolean
export declare function requestsCompactionCheckpoint(body: any): boolean
export declare function normalizeRequest(
  body: any,
  previous: { effective: readonly unknown[]; responseID: string; output: readonly unknown[] } | undefined,
): { mode: "create" | "incremental" | "replace" | "append"; effective: unknown[]; appended: unknown[] }

export declare function startMockCpaWs(options?: {
  models?: readonly Record<string, unknown>[]
  requireKey?: string
  rejectUpgrade?: boolean
  responses?: (
    request: { raw: string; json: any },
    index: number,
    info: { transport: string },
  ) => WsReply | Promise<WsReply>
}): Promise<MockCpaWs>
