# opencode2-cliproxyapi-provider

OpenCode v2 provider plugin for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA).

It connects OpenCode to a CPA deployment: the plugin reads CPA's enhanced model
directory, registers the models it reports, and lets OpenCode's **native
Responses runtime** talk to CPA over HTTP/SSE or WebSocket. It is not a port of
the official Pi plugin and does not re-implement serialization, streaming or
compaction.

## Status of this slice

Delivered here:

- explicit (no-UI) and interactive CPA address and key -> enhanced directory ->
  OpenCode model registration -> native Responses HTTP/SSE, including tool
  call/result round-trips, image input mapping and OpenCode's own summary
  compaction
- the native key method with the CPA address form, plus a settings wizard that
  reads the key with a masked input and **verifies the pair before saving it**
- a clear split between "the credential is saved" and "this connection was
  verified", reported through the connection snapshot
- connection switching that rebinds the directory to the new connection, with a
  generation guard so a slow request from a replaced connection cannot overwrite
  the newer state
- a server RPC (`status`, `verify`, `connect` + a `changed` event) and a TUI
  entry that reads the snapshot, subscribes and runs the wizard without ever
  talking to CPA itself
- credential handling through OpenCode's native key method and credential store
- transport selection driven by the directory's `prefer_websockets` flag, with a
  forced HTTP/WebSocket option and a clear diagnostic when the chosen runtime
  package cannot carry the requested transport
- a WebSocket continuation reset after a summary, so the compacted transcript is
  not appended to CPA's pre-summary server state
- an opt-in native (provider-side) compaction request, verified against a mock
  CPA that serves the Responses checkpoint contract
- the WebSocket failure matrix, checked against the real host: socket reuse,
  incremental continuation, invalid `previous_response_id` retry, refused
  upgrades, parallel sessions, credential rotation and socket release on unload
- project scaffolding, tests, isolated host scripts and this document

Not part of this slice (later tasks): persisted catalog and refresh,
Fast/service tiers, pause and stats, real CPA validation.

## Requirements

| Requirement | Value |
| --- | --- |
| OpenCode | `>= 2.0.26 < 3` (verified against `2.0.26`) |
| CPA | serves `/v1/models?client_version=…` and `/v1/responses` |
| Runtime package | `@opencode/ai/providers/openai-compatible/responses` (HTTP) and `@opencode/ai/providers/openai/responses` (WebSocket) |

Older or newer-major hosts are refused at load time with a clear message, as are
hosts that do not expose the plugin interfaces this package registers against.

## Install

The plugin is not published. Load it from a checkout:

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode2-cliproxyapi-provider/src",
      "options": { "baseURL": "http://127.0.0.1:8317" }
    }
  ]
}
```

Nothing is installed globally and no other project or existing OpenCode
configuration is touched. To try it without disturbing your own setup, see
[Isolated host run](#isolated-host-run).

## Configuration

A **connection** is one address plus one API key, and both belong together.

| Source | Address | Key |
| --- | --- | --- |
| plugin `options` | `baseURL` | `apiKey` |
| environment | `CLIPROXYAPI_BASE_URL` | `CLIPROXYAPI_API_KEY` |
| stored connection | saved with the key | saved by OpenCode |

Precedence is plugin options, then environment, then the stored connection. Each
half is resolved independently, and the snapshot always reports which source
supplied it (`addressSource` / `keySource`), so a stored address is never mixed
with an explicit key silently:

- an explicitly configured address or key wins over the stored half;
- an explicit address with no key anywhere is a **partial configuration** and is
  refused instead of being completed from an unrelated source;
- an explicit key with no address keeps the stored address when there is one and
  otherwise uses `http://127.0.0.1:8317`;
- when an explicit key differs from the stored credential, the plugin stores it
  through the native key method, so OpenCode owns it and injects it into
  requests. An unchanged pair is reused instead of writing another credential.

Connection state is scoped per location: each location's plugin instance owns its
own snapshot and RPC registration, and a change in one location does not
touch another.

Other options: `providerID` (default `cliproxyapi`), `providerName`,
`integrationID`, `package` (HTTP runtime package override), `websocketPackage`
(WebSocket runtime package override), `transport`, `compaction` and
`catalogTimeoutMs`.

The address may include a reverse-proxy subpath; it is preserved:

```
https://gateway.example.com/cpa      -> baseURL https://gateway.example.com/cpa/v1
http://127.0.0.1:8317/v1             -> baseURL http://127.0.0.1:8317/v1
```

The directory is read from `<baseURL>/models?client_version=<this plugin>`, and
the Responses runtime appends `/responses` to `baseURL`.

## Transport, recovery and compaction

OpenCode selects a transport per provider, so the plugin decides once per
directory read and reports the decision in the connection snapshot.

| `transport` | Behaviour |
| --- | --- |
| `auto` (default) | WebSocket when the directory declares `prefer_websockets` for a visible model **and** the WebSocket runtime package is known to carry a channel; otherwise HTTP/SSE |
| `http` | Always HTTP/SSE, even when the directory prefers WebSocket |
| `websocket` | Always ask for WebSocket; the request is kept even when the package cannot carry it, and the snapshot carries the reason |

Two runtime packages are involved because only one of them can carry a socket:

| Transport | Package | Why |
| --- | --- | --- |
| HTTP/SSE | `@opencode/ai/providers/openai-compatible/responses` | the compatible Responses route is HTTP-only |
| WebSocket | `@opencode/ai/providers/openai/responses` | the native OpenAI Responses route has the WebSocket channel and the continuation logic |

That capability split is not assumed: `scripts/host-transport.mjs` loads both
packages into the real host and records whether a socket is opened. Requesting
`websocket` against the HTTP-only package keeps the request, falls back to
HTTP/SSE in the host, and puts the reason in `snapshot.transportNote`. The plugin
registers no `http.request`/`http.response` hooks, so its own configuration never
disables the WebSocket path.

### Summary continuation

OpenCode reuses one socket per session and the runtime continues with
`previous_response_id`. CPA keeps the pre-summary conversation in that
connection state, so a compacted transcript sent on the same socket would still
be answered from the old context. The plugin registers the host's `compaction`
hook and, for native compaction, watches the outbound frame for
`compaction_trigger`; the next WebSocket handshake then carries a fresh
`x-oc2cpa-socket` generation, which makes the host reopen the socket and CPA
treat the compacted transcript as a new conversation. Ordinary turns keep
reusing their socket.

### Native compaction (opt-in)

`compaction: "native"` declares OpenCode's provider-side compaction instead of
the default `"summary"`. It is only declared when the selected runtime package
exposes a compaction endpoint; against the HTTP-only package the plugin keeps
summary and says why in `snapshot.compactionNote`. The host then asks for a
compaction checkpoint with a `compaction_trigger` frame and carries the returned
checkpoint into the next turn, which `scripts/host-transport.mjs` checks. The
default remains summary.

### Failure behaviour observed on the tested host

| Situation | Behaviour |
| --- | --- |
| directory prefers WebSocket | one socket per session, reused across turns; a follow-up turn sends only the delta with `previous_response_id` |
| invalid `previous_response_id` | the host retries with a full transcript; an output that already reached the client is never re-sent |
| WebSocket upgrade refused | the host falls back to HTTP/SSE; the run does not fail silently |
| summary or native checkpoint | the next turn opens a fresh socket, so the old history is not appended to the pre-compaction state |
| parallel sessions | one socket per session; sockets are not shared |
| connection switch (rotated key) | the next session's socket uses the new address and key; the replaced connection gets no new socket |
| service stop (plugin unload) | the sockets are closed |

## Interactive connect and TUI

OpenCode's standard `/connect` entry saves the key and the address first, and the
plugin then reports whether that saved connection works. The plugin's own wizard
is the other order: it verifies the pair against CPA and only then saves it, so a
bad pair is refused and the previous working connection is left untouched.

With the plugin loaded, the TUI entry registers:

| Command | What it does |
| --- | --- |
| `/cpa-status` | Reads the snapshot over RPC and shows address, saved key hint, verification state and model count |
| `/cpa-connect` | Prompts for the address, reads the key with a **masked** input, verifies, then saves |

The prompt footer also carries a short connection state (`CPA 3 models`,
`CPA saved`, `CPA auth`, `CPA offline`). The TUI talks to the server over RPC
only; it never contacts CPA and never reads server files, so it also works
against a remote server. Events are live-only, so the view re-reads the
snapshot on a reconnect instead of replaying missed events.

## Connection RPC

The server registers one RPC (`id: cliproxyapi`) so other clients can drive the
connection:

| Method | Input | Output |
| --- | --- | --- |
| `status` | `{}` | the connection snapshot |
| `verify` | `{ address, key? }` | probe result; nothing is saved |
| `connect` | `{ address, key }` | verifies, saves through the native key method, rebinds models |

A `changed` event carries the new snapshot after every committed change. Each
event and call carries a `location`; external clients receive events from every
location and must filter. The snapshot never contains the key, only
`(redacted, N chars)`. It also reports the transport decision (`transport`,
`transportSource`, `directoryPrefersWebSocket`, `transportNote`) and the
compaction mechanism (`compaction`, `compactionNote`), so a client can see what
was asked for and why.

## Model mapping

The enhanced CPA directory is the primary capability source. Fields are read
only when present, and a missing field is never turned into claimed support:

| Directory field | Mapping |
| --- | --- |
| `slug` / `id` | model `id` and `modelID` (the real CPA id) |
| `display_name` / `name` | display name |
| `context_window` / `max_context_window` | context limit (default 128000) |
| `max_tokens` / `max_output_tokens` / `max_completion_tokens` | output limit (default 16384, clamped to context) |
| `input_modalities` | `capabilities.input`; `text` is always included |
| `supported_reasoning_levels` | one variant per level with `reasoningEffort` |
| `visibility: "hide"` | model present but `enabled: false` |

A plain OpenAI listing (`{ data: [...] }`) is accepted as a fallback with those
defaults. A response that is neither shape — an error page, a proxy error, a
broken body — is an error, never an empty catalog. An empty directory is reported
as empty. No cost information is invented.

## Isolated host run

`scripts/host-smoke.mjs` loads the plugin into a real OpenCode binary with its
own config/data/cache/state/home directories and a mock CPA, then checks the
wire: the directory request, the model id and bearer on a Responses request, a
tool call plus result, OpenCode's own summary request after `session.compact`,
the summary carried into the next request, and that the fictional key never
reaches the host log.

```bash
bun run smoke:host
# or
OPENCODE_CLI=/path/to/opencode.exe OC2CPA_SANDBOX=/path/to/empty/sandbox node scripts/host-smoke.mjs
```

`scripts/host-connection.mjs` covers the connection experience: the native key
and address form, saving through OpenCode's own credential store, the difference
between saved and verified, every verify outcome (correct, 401, unreachable,
empty, broken body, bad address), verify-before-save, switching without leaking
the previous directory, per-location state, and a remote client that re-reads the
snapshot after a disconnect.

```bash
bun run smoke:connection
```

`scripts/host-transport.mjs` covers transport selection and failure recovery
against a mock CPA that serves both Responses HTTP/SSE and a real Responses
WebSocket and applies CPA's transcript state machine: `auto` selecting WebSocket
from the directory preference and reusing one socket, the summary and native
compaction paths (including the fresh socket after each), a refused upgrade, an
invalid `previous_response_id`, an HTTP-only package asked for WebSocket,
parallel sessions, a rotated credential and socket release on unload.

```bash
bun run smoke:transport
```

All of them talk to a loopback mock CPA only: no real credential, no real CPA
request, no cost. `SMOKE_DEBUG=1` also dumps the request sequence of the smoke
run, and `OC2CPA_ONLY=ws|http|diagnostic|recovery|native|parallel|rotation` runs
one transport scenario.

## Development

Development dependencies are locked with `package-lock.json`; `bun` runs the
tests and the host scripts against that `node_modules`.

```bash
npm ci                 # install the locked development dependencies
bun test               # unit + native-runtime integration tests
bun test test/unit     # directory parsing, mapping, connection, state, RPC, TUI view
bun test test/integration   # real Responses serialization, SSE parsing and the WebSocket channel
bun run typecheck      # tsc --noEmit
```

The integration tests drive `@opencode/ai/providers/openai-compatible/responses`
over real HTTP and `@opencode/ai/providers/openai/responses` over a real
WebSocket against the mock CPA, so serialization, stream parsing and the
continuation/checkpoint logic are the host's own code rather than a stub.
`scripts/host-connection.mjs` additionally drives the real host over its HTTP RPC
as a remote client.

## Observations and limits

- Verified on OpenCode `2.0.26` only; other versions are untested and, outside
  `>=2.0.26 <3`, refused.
- Transport is selected from the directory's `prefer_websockets` flag, and only
  the native OpenAI Responses runtime package can carry it; the compatible
  Responses package stays HTTP-only and the plugin diagnoses that mismatch.
- The WebSocket matrix was checked against OpenCode `2.0.26` and a mock CPA that
  applies CPA's transcript state machine; it is not a claim about a real CPA
  deployment.
- The WebSocket runtime package is the native OpenAI Responses route, so it
  applies the host's OpenAI defaults for `gpt-5*` model ids (reasoning effort
  `medium`, reasoning summary `auto`); the HTTP-only compatible package does not.
  The rest of the body is identical.
- `opencode models` and `model.list` resolve a location of their own and do not
  show location-scoped plugin models; model availability is exercised through a
  real session instead.
- The interactive wizard masks the key and verifies before saving, but the host
  offers no password input for plugins, so the masked field is drawn by the
  plugin while the host's dialog API provides the frame.
- No real CPA deployment has been contacted. Tool round-trips, image input,
  summary compaction and the connection experience were validated against a mock
  CPA that speaks the same Responses and directory wire format.
