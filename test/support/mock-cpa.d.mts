export interface RecordedRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly path: string
  readonly query: Record<string, string>
  readonly headers: Record<string, string | string[] | undefined>
  readonly raw: string
  readonly json: any
}

export interface Reply {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly body?: unknown
  readonly raw?: string
  readonly contentType?: string
  readonly events?: readonly Record<string, unknown>[]
}

export interface MockCpa {
  readonly url: string
  readonly port: number
  readonly requests: RecordedRequest[]
  responses(): RecordedRequest[]
  close(): Promise<void>
}

export declare const SUMMARY_PROMPT_MARKER: string

export declare function sseBody(events: readonly Record<string, unknown>[]): string
export declare function textEvents(text: string, options?: { itemId?: string; responseId?: string }): Record<string, unknown>[]
export declare function toolCallEvents(options: {
  callId: string
  name: string
  arguments: string
  itemId?: string
  responseId?: string
}): Record<string, unknown>[]
export declare function textReply(text: string, options?: { itemId?: string; responseId?: string }): Reply
export declare function toolCallReply(options: {
  callId: string
  name: string
  arguments: string
  itemId?: string
  responseId?: string
}): Reply

export declare function startMockCpa(options?: {
  models?: readonly Record<string, unknown>[]
  directory?: Reply | ((request: RecordedRequest) => Reply)
  responses?: Reply | ((request: RecordedRequest, index: number) => Reply)
}): Promise<MockCpa>
