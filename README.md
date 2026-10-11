# opencode2-cliproxyapi-provider

OpenCode v2 provider plugin for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA).

It connects OpenCode to a CPA deployment: the plugin reads CPA's enhanced model
directory, registers the models it reports, and lets OpenCode's **native
Responses runtime** talk to CPA over HTTP/SSE. It is not a port of the official
Pi plugin and does not re-implement serialization, streaming or compaction.

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
- a server RPC (`status`, `verify`, `connect`, `pause`, `resume`, `pauseState`,
  `stats`, `sessions`, plus `changed`, `pause.changed` and `stats.changed`
  events) and a TUI entry that reads the snapshot, subscribes and runs the
  wizard without ever talking to CPA itself
- a cancellable pause gate and per-session duration/TPS/token/cache stats
- credential handling through OpenCode's native key method and credential store
- project scaffolding, tests, isolated host scripts and this document

Not part of this slice (later tasks): persisted catalog and refresh, Fast/service
tiers, WebSocket transport and its failure matrix, native (provider-side)
compaction, real CPA validation.

## Requirements

| Requirement | Value |
| --- | --- |
| OpenCode | `>= 2.0.26 < 3` (verified against `2.0.26`) |
| CPA | serves `/v1/models?client_version=…` and `/v1/responses` |
| Runtime package | `@opencode/ai/providers/openai-compatible/responses` |

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
`integrationID`, `package` (runtime package override) and `catalogTimeoutMs`.

The address may include a reverse-proxy subpath; it is preserved:

```
https://gateway.example.com/cpa      -> baseURL https://gateway.example.com/cpa/v1
http://127.0.0.1:8317/v1             -> baseURL http://127.0.0.1:8317/v1
```

The directory is read from `<baseURL>/models?client_version=<this plugin>`, and
the Responses runtime appends `/responses` to `baseURL`.

## Interactive connect and TUI

OpenCode's standard `/connect` entry saves the key and the address first, and the
plugin then reports whether that saved connection works. The plugin's own wizard
is the other order: it verifies the pair against CPA and only then saves it, so a
bad pair is refused and the previous working connection is left untouched.

With the plugin loaded, the TUI entry registers:

| Command | What it does |
| --- | --- |
| `/cpa-status` | Reads the snapshot over RPC and shows address, saved key hint, verification state, pause state and model count |
| `/cpa-connect` | Prompts for the address, reads the key with a **masked** input, verifies, then saves |
| `/cpa-pause` | Stops the next CPA request; one already in flight completes |
| `/cpa-resume` | Releases the waiting CPA requests |
| `/cpa-stats` | Shows this session's effective duration, TPS and token/cache usage |

The prompt footer also carries a short state: the connection (`CPA 3 models`,
`CPA saved`, `CPA auth`, `CPA offline`), `paused` while paused, and the last
turn's effective duration with its TPS (`2.1s · 9.9 tok/s`). The TUI talks to
the server over RPC only; it never contacts CPA and never reads server files, so
it also works against a remote server. Events are live-only, so the view
re-reads the snapshot on a reconnect instead of replaying missed events.

## Connection RPC

The server registers one RPC (`id: cliproxyapi`) so other clients can drive the
connection:

| Method | Input | Output |
| --- | --- | --- |
| `status` | `{}` | the connection snapshot |
| `verify` | `{ address, key? }` | probe result; nothing is saved |
| `connect` | `{ address, key }` | verifies, saves through the native key method, rebinds models |
| `pause` | `{}` | pause state; stops the next CPA request |
| `resume` | `{}` | pause state; releases the waiting requests |
| `pauseState` | `{}` | pause state without changing it |
| `stats` | `{ sessionID }` | that session's duration/TPS/token stats, or nothing when unknown |
| `sessions` | `{}` | every observed session, most recent first |

A `changed` event carries the new snapshot after every committed change, a
`pause.changed` event carries the new pause state, and a `stats.changed` event
carries a session's stats when a turn boundary moves (not on every step). Each
event and call carries a `location`; external clients receive events from every
location and must filter. The snapshot never contains the key, only
`(redacted, N chars)`; neither does the pause state or the stats.

## Pause and session stats

Pausing stops the *next* CPA request; a request already in flight finishes
normally. The gate is one promise per waiting model call and holds no timer, so
a resume is an RPC call that never depends on a model call. Interrupting a
session drops that session's wait — the host interrupts the request itself, so
the held request is never sent — and unloading the plugin releases every wait.
The pause is **not persisted**: a restart or reload starts running, because a
stored "paused" would silently block the next session. It is scoped to one
location, and the gate is registered for this provider only, so another
location or another provider is unaffected.

Unload has its own rule. A live `location.reload()` replaces the plugin
generation, and the host emits `location.shutdown` to the old generation. The
host does call the cleanup returned by `setup` — but only while no
`model.request` hook invocation is still pending. A held pause wait is exactly
such a pending hook: the host's scope close then waits on that fiber and the
cleanup never runs, so the wait would be orphaned and the replaced generation's
event subscription would keep receiving events. The plugin therefore ends its
held waits and stops its event subscription on `location.shutdown` instead of
relying on the cleanup. A reload while a request is paused **releases** that
request — it is sent and the session finishes, rather than being cancelled or
left waiting — and the reloaded location starts running, like a restart. The
returned cleanup stays as the fallback for the case where the host does call it.

`/cpa-stats` shows the breakdown and the footer shows the last turn. The same
data is available over RPC (`stats`, `sessions`).

Measurement rules, asserted by the tests:

| Term | Definition |
| --- | --- |
| turn | one host execution: `session.execution.started` until `succeeded`, `failed` or `interrupted`. One prompt with tool continuations is one turn, not several. |
| effective duration | the turn's wall time minus the time this session spent waiting at the pause gate. Pausing while nothing waits subtracts nothing. |
| TPS | output tokens / effective seconds for the whole turn. It is **not** pure decode speed: tool rounds and retries are inside the same window. |
| tokens | summed from `session.step.ended` / `session.step.failed`, keyed by assistant message id |
| total | `input + output + reasoning + cache.read + cache.write`, the host's own `TokenUsage.total` |
| retries | counted from `session.retry.scheduled`; a retried step reuses its message id, so its usage is counted once, not once per attempt |
| sessions | every session id is aggregated on its own; a child (subagent) session is never folded into its parent |

A step that reports no usage contributes no tokens: a missing value is never
invented. Stats live in the server process: they survive a TUI disconnect (the
TUI re-reads the snapshot on reconnect) but not a server restart. Title and
compaction requests are outside the agent-loop turn and are not counted.

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

`scripts/host-pause.mjs` covers the pause gate in a real host: a paused request
is held before it is sent, an RPC resume releases it, another provider is not
gated, interrupting a paused session ends the wait without sending the request,
a live `location.reload()` ends the held wait and the reloaded location's gate
still works, and stopping the host while a call is paused ends the wait too.

```bash
bun run smoke:pause
```

The same `OPENCODE_CLI`/`OC2CPA_SANDBOX` environment as above applies.

`scripts/host-stats.mjs` covers the measurement: one prompt with a tool
continuation is one turn with two steps, the tokens are the usage the provider
reported, the turn carries effective duration and TPS, and pause time inside the
turn is excluded from the effective duration.

```bash
bun run smoke:stats
```

The same `OPENCODE_CLI`/`OC2CPA_SANDBOX` environment as above applies.

All of them talk to a loopback mock CPA only: no real credential, no real CPA
request, no cost. `SMOKE_DEBUG=1` also dumps the request sequence of the smoke
run.

## Development

Development dependencies are locked with `package-lock.json`; `bun` runs the
tests and the host scripts against that `node_modules`.

```bash
npm ci                 # install the locked development dependencies
bun test               # unit + native-runtime integration tests
bun test test/unit     # directory parsing, mapping, connection, state, RPC, pause, stats, TUI view
bun test test/integration   # real Responses serialization and SSE parsing
bun run typecheck      # tsc --noEmit
```

The integration tests drive `@opencode/ai/providers/openai-compatible/responses`
over real HTTP against the mock CPA, so serialization and stream parsing are the
host's own code rather than a stub. `scripts/host-connection.mjs` additionally
drives the real host over its HTTP RPC as a remote client.

## Observations and limits

- Verified on OpenCode `2.0.26` only; other versions are untested and, outside
  `>=2.0.26 <3`, refused.
- The pause is runtime state, not a persisted preference, and the stats are
  in-memory: a server restart clears them.
- TPS is the whole-turn figure described above, not a decode-speed measurement.
- With this runtime package the transport defaults to HTTP/SSE for a
  plugin-registered provider; WebSocket behaviour is not validated here.
- `opencode models` and `model.list` resolve a location of their own and do not
  show location-scoped plugin models; model availability is exercised through a
  real session instead.
- The interactive wizard masks the key and verifies before saving, but the host
  offers no password input for plugins, so the masked field is drawn by the
  plugin while the host's dialog API provides the frame.
- No real CPA deployment has been contacted. Tool round-trips, image input,
  summary compaction and the connection experience were validated against a mock
  CPA that speaks the same Responses and directory wire format.
