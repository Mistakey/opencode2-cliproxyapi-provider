# Configuration and behavior reference

[English quick start](../README.md) · [中文快速上手](../README.zh-CN.md)

## Configuration

A connection is **one address plus one API key**. Priority is plugin `options`,
environment, then the stored native connection. The snapshot reports the source
of both halves (`addressSource`, `keySource`).

| Source | Address | Key |
| --- | --- | --- |
| Plugin options | `baseURL` | `apiKey` (supported, but do not commit secrets) |
| Server environment | `CLIPROXYAPI_BASE_URL` | `CLIPROXYAPI_API_KEY` |
| Native credential store | Saved address | Saved key |

An explicit address takes only a matching key. Another explicit source may
supply it if that source has no address or the same address; a stored key may
complete the pair only if its saved address matches. Otherwise the partial
configuration is refused. An explicit key without an address keeps the stored
address or defaults to `http://127.0.0.1:8317`. A changed explicit pair is saved
through OpenCode's native key method; an unchanged pair is not rewritten.

The native `/connect` form saves first, then reports verification. The plugin's
`/cpa-connect` wizard verifies before saving; failure leaves the old pair intact.
Connection state and RPC registrations are location-scoped. The TUI never reads
server credential files or contacts CPA; it uses server RPC, including remotely.

| Option | Default / purpose |
| --- | --- |
| `providerID`, `integrationID` | `cliproxyapi`; identifiers for registration and credentials |
| `providerName` | Display name, `CLIProxyAPI` |
| `transport` | `auto`; alternatively `http` or `websocket` |
| `compaction` | `summary`; alternatively opt-in `native` |
| `package` | HTTP runtime override; normally `@opencode/ai/providers/openai-compatible/responses` |
| `websocketPackage` | WS runtime override; normally `@opencode/ai/providers/openai/responses` |
| `catalogTimeoutMs` | Directory request timeout; 10000 ms |
| `catalogStaleTtlMs` | Stale retention; seven days from the first miss |
| `modelsDev` | `true`; `false` disables public price lookup |
| `modelsDevURL` | `https://models.dev/api.json`; optional price catalog override |
| `modelsDevTimeoutMs` | 5000 ms |

Reverse-proxy subpaths are preserved:

```text
https://gateway.example.com/cpa -> https://gateway.example.com/cpa/v1
http://127.0.0.1:8317/v1        -> http://127.0.0.1:8317/v1
```

The plugin reads `<baseURL>/models?client_version=<plugin/version>`; the runtime
appends `/responses`. Use TLS for non-loopback deployments. An explicit catalog
URL is a network destination; never put a credential in a URL or a public report.

## Applying changes

OpenCode compiles an existing provider binding at location boot/reload. Publishing
a new directory does not hot-update the compiled runtime. Snapshots distinguish:

- `applied`: the runtime uses the described directory/settings;
- `reloadRequired`: newer saved settings await location reload;
- `fastEffectiveModels`: count that currently receives priority, not a pending wish.

`connect`, `refresh` and `setFast` return the snapshot. The TUI reloads only when
needed and re-reads status; a headless caller uses the same public API:

```ts
const result = await client.rpc.call({ rpcID: "cliproxyapi", method: "refresh", input: {} })
if (result.output.snapshot.reloadRequired) await client.location.reload()
const status = await client.rpc.call({ rpcID: "cliproxyapi", method: "status", input: {} })
```

Supply the correct location for location-scoped calls. Before reload, a new
request that would send a Fast tier withdrawn by the saved directory/preference
is refused, rather than sending obsolete priority. In-flight requests are left
alone. The check uses an in-memory shared registry, not persisted cache.

A location booted without a usable binding (no key or failed first directory
read) has nothing to replace: its first successful connect/refresh can apply
immediately. This is the tested host's empty-boot behavior, not plugin hot reload.
See [ADR 0002](adr/0002-apply-boundary.md).

## Directory and models

| CPA directory field | OpenCode mapping |
| --- | --- |
| `slug` / `id` | Real CPA model ID |
| `display_name` / `name` | Display name |
| `context_window` / `max_context_window` | Context limit; fallback 128000 |
| `max_tokens` / `max_output_tokens` / `max_completion_tokens` | Output limit; fallback 16384, clamped to context |
| `input_modalities` | Input capabilities; text always included |
| `supported_reasoning_levels` | Variants with semantic `reasoningEffort` |
| `service_tiers` | Nonempty declaration enables Fast capability |
| `additional_speed_tiers` | Not a Fast capability signal |
| `visibility: "hide"` | Model registered but disabled |

A plain OpenAI `{ data: [...] }` list is accepted with the documented fallbacks.
Malformed/error responses are failures, never empty catalogs. A legal empty
catalog is a success. Missing capability information is not invented.

The cache is per connection in OpenCode plugin storage. Its one-way fingerprint
includes address/key identity, but the key itself is not written into the cache.
A matching cache registers immediately, then refreshes in the background. A
failed read preserves the last good directory. A successful read retains newly
missing models as stale until their window expires; reappearing models become
current. Selecting a stale model warns, without promising upstream availability.

Generation/request guards reject superseded connection reads. Directory commits
are serialized in issue order; no compensating re-save/re-publish is used. Cache
write failures cannot change served request parameters.

After a **later** failed background/manual read, or a read retaining stale models,
recovery starts at 60 seconds, grows by 1.5x, and caps at 300 seconds. A fresh
directory clears it; manual refresh, connection switch and unload cancel it.
The very **first uncached boot read is not retried**: refresh manually once CPA
recovers. Each attempt is a bounded directory read, not a model call.

## Transport and compaction

| `transport` | Selection |
| --- | --- |
| `auto` | WS if a visible entry declares `prefer_websockets` and the selected WS runtime is known to carry a channel; otherwise HTTP/SSE |
| `http` | Always HTTP/SSE |
| `websocket` | Request WS; an incapable runtime is diagnosed in `transportNote`, and the host may fall back |

The compatible Responses package is HTTP-only; the native OpenAI Responses
package carries WS. The plugin registers no HTTP request/response hooks, so it
does not disable the host's socket path. On 2.0.26 the OpenAI route supplies its
own `gpt-5*` defaults (medium reasoning, automatic reasoning summary); the HTTP
compatible route does not.

OpenCode normally reuses one socket per session, sending incremental turns with
`previous_response_id`. After summary, the plugin changes the public WS handshake
generation header `x-oc2cpa-socket`: the host opens a new socket, avoiding appending
compacted history to CPA's pre-summary connection state. This does not mean
creating a new OpenCode user session. See [ADR 0001](adr/0001-native-runtime.md).

`compaction: "native"` is optional and **not real-CPA verified**. It is declared
only for a runtime with a compaction endpoint; otherwise summary is retained and
`compactionNote` explains why. The mock native checkpoint path also resets the
socket generation. Do not infer real support from that mock.

The host/mock matrix observed socket reuse, invalid-response-ID retry, upgrade
refusal fallback, separate parallel-session sockets, rotated credentials and
socket cleanup. Already-emitted output is not replayed on retry. These are
[tested boundaries](verification.md), not a promise for every CPA deployment.

## Reasoning, Fast and prices

Reasoning variants map to `reasoningEffort` → wire `reasoning.effort`. Fast maps
to `serviceTier: priority` → `service_tier`, only when `service_tiers` declares
capability. It does not change reasoning effort. Priority applies to every
request for that model, including primary, title, summary and generate requests.

Fast is provider-scoped, persistent and off by default. A failed preference
write leaves the previous preference and applied state intact. Applying an
existing binding requires reload as described above.

Price matching uses the CPA reference plugin's alias rules, namespace stripping,
normalized fallback and provider preference over the public models.dev catalog.
Ambiguous disagreeing prices with no preferred provider remain unknown. A failed
lookup never prevents model registration.

- Standard price is the default.
- Fast price (`experimental.modes.fast.cost`) is used only when the model also
  receives priority; absent Fast price means the standard price, not an invented multiplier.
- Context tiers (`tiers` or legacy `context_over_200k`) map to host cost entries.
- Unmatched models have no invented price. These are estimates, **not a CPA bill**.

## Pause and statistics

Pause holds the next request, without a timer. A request already in flight
finishes. Resume is an RPC call independent of model calls. Session interruption
cancels its wait without sending a request. Pause is per location/provider and
not persisted; other providers are unaffected.

Location shutdown explicitly cancels held waits and subscriptions: waiting for
ordinary cleanup would deadlock a hook still waiting at the pause gate. Reload
starts an unpaused generation with empty statistics; it does not release old
waits as requests. A service restart also clears these in-memory statistics.

| Metric | Rule |
| --- | --- |
| Turn | One host execution from `session.execution.started` to success/failure/interruption; tool continuations are part of it |
| Effective duration | Turn wall time minus that session's actual pause-gate waiting |
| TPS | Output tokens / effective seconds for the **whole turn**, including tool/retry time; not decode speed |
| Tokens | Step usage keyed by assistant message ID; missing usage is not invented |
| Total | Host `input + output + reasoning + cache.read + cache.write` |
| Retries | Counted from scheduled retries; a reused message ID is not double-counted |
| Sessions | Each session, including a child, is independent; no folding into parent stats |

Title and compaction calls are outside the agent-loop turn and not counted.
TUI disconnect does not reset server statistics; reconnect reads a fresh snapshot.

## Connection RPC

RPC ID: `cliproxyapi`. Calls and events are location-scoped; external clients must
filter location when subscribing. Events are live-only, so re-read on reconnect.

| Method | Input | Result |
| --- | --- | --- |
| `status` | `{}` | Connection snapshot |
| `verify` | `{ address, key }` | Probe only; requires both, never borrows the active key |
| `connect` | `{ address, key }` | Verify, save native connection, bind; includes apply state |
| `refresh` | `{}` | Read directory bypassing cache; includes apply state |
| `setFast` | `{ enabled }` | Persist preference; includes apply state |
| `pause`, `resume`, `pauseState` | `{}` | Pause state |
| `stats` | `{ sessionID }` | Known session statistics, if any |
| `sessions` | `{}` | Observed sessions, most recent first |

Events: `changed`, `stale`, `pause.changed`, `stats.changed`. Stats events occur at
turn boundaries, not every step. Snapshots include catalog age/count/stale IDs,
cache state, verification and source fields, applied/pending Fast counts,
price count and transport/compaction diagnostics. Keys are never included, only
`(redacted, N chars)`; snapshots can still contain a private address, model IDs or
session context, so redact before sharing.
