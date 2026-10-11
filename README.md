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
- a server RPC (`status`, `verify`, `connect`, `refresh`, `setFast` + `changed`
  and `stale` events) and a TUI entry that reads the snapshot, subscribes,
  refreshes the directory and runs the wizard and the Fast toggle without ever
  talking to CPA itself
- a per-connection directory cache in OpenCode's own plugin storage: a restart
  that finds a matching cache registers its models immediately and then
  refreshes in the background, a failed refresh keeps the last good directory,
  and a legal empty directory stays distinct from a failure
- stale retention: a model that disappears from the directory is kept, marked
  and dropped only after the retention window (seven days by default, measured
  from the first miss); requesting a retained model warns instead of promising
  the upstream still serves it
- reasoning variants taken only from the declared `supported_reasoning_levels`,
  carried into requests through the v2 semantic `reasoningEffort` setting
- a durable, provider-scoped **Fast** preference: off by default, toggled over
  RPC or from the TUI, restored after a restart, and injected as the v2
  `serviceTier` setting only for models whose directory entry declares service
  tiers
- standard, Fast and context-tiered **price estimates** matched from the public
  models.dev catalog, with the reference alias table and no invented multiplier
- credential handling through OpenCode's native key method and credential store
- project scaffolding, tests, isolated host scripts and this document

Not part of this slice (later tasks): pause and stats, WebSocket transport and
its failure matrix, native (provider-side) compaction, real CPA validation.

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
`integrationID`, `package` (runtime package override), `catalogTimeoutMs` and
`catalogStaleTtlMs` (how long a model missing from the directory is retained;
default seven days, mainly useful for testing).

The price estimate comes from the public models.dev catalog. It is a supplement,
not a gate: the lookup runs beside the directory request and a failure only means
the models carry no price.

| Option | Default | Meaning |
| --- | --- | --- |
| `modelsDev` | `true` | Set `false` to skip the models.dev lookup entirely |
| `modelsDevURL` | `https://models.dev/api.json` | Override the catalog URL |
| `modelsDevTimeoutMs` | `5000` | Bound the lookup |

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
| `/cpa-status` | Reads the snapshot over RPC and shows address, saved key hint, verification state, model count, last refresh, stale models, the Fast preference, the price source and the last error |
| `/cpa-refresh` | Asks the server to read the CPA directory again, bypassing the cache |
| `/cpa-connect` | Prompts for the address, reads the key with a **masked** input, verifies, then saves |
| `/cpa-fast` | Toggles the Fast preference, then reloads the location so it reaches the provider registry |

The prompt footer also carries a short connection state (`CPA 3 models · Fast off`,
`CPA 3 models · 1 stale · Fast off`, `CPA 3 models (cached) · Fast off`,
`CPA saved · Fast off`, `CPA auth · Fast off`, `CPA offline`). A request that
selects a model retained as stale shows a warning toast, so the model stays usable
but the user is not promised it still exists upstream. The TUI talks to the server
over RPC only; it never contacts CPA and never reads server files, so it also
works against a remote server. Events are live-only, so the view re-reads the
snapshot on a reconnect instead of replaying missed events. Every command name is
CPA-prefixed (`cpa-status`, `cpa-refresh`, `cpa-connect`, `cpa-fast`) and is added
as a keymap layer, so no existing command is replaced.

## Connection RPC

The server registers one RPC (`id: cliproxyapi`) so other clients can drive the
connection:

| Method | Input | Output |
| --- | --- | --- |
| `status` | `{}` | the connection snapshot |
| `verify` | `{ address, key? }` | probe result; nothing is saved |
| `connect` | `{ address, key }` | verifies, saves through the native key method, rebinds models |
| `refresh` | `{}` | re-reads the active connection's directory, bypassing the cache |
| `setFast` | `{ enabled }` | persists the Fast preference and returns the new snapshot |

A `changed` event carries the new snapshot after every committed change, and a
`stale` event carries `{ modelID }` when a request selects a model retained as
stale. Each event and call carries a `location`; external clients receive events
from every location and must filter. The snapshot never contains the key, only
`(redacted, N chars)`; it also reports `catalogModels`, `catalogFetchedAt`,
`catalogStaleModels`/`catalogStaleIds` and `catalogFromCache`, keeps the Fast
preference (`fastEnabled`) apart from what is registered right now
(`fastEffectiveModels`), and reports how many models carry a price estimate
(`costModels`).

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
| `service_tiers` | Fast capability; a non-empty list lets the Fast preference inject `serviceTier: priority` |
| `additional_speed_tiers` | deliberately ignored: it is not the capability signal the reference plugin uses |
| `visibility: "hide"` | model present but `enabled: false` |

A plain OpenAI listing (`{ data: [...] }`) is accepted as a fallback with those
defaults. A response that is neither shape — an error page, a proxy error, a
broken body — is an error, never an empty catalog. An empty directory is a
success and is reported as empty. No cost is invented: a price comes only from a
models.dev match, and an unmatched model carries none.

### Cache, refresh and stale models

The directory is cached per connection in OpenCode's plugin storage, keyed by a
one-way fingerprint of the address and key. The key itself is never written, and
one credential's directory is never served to another.

- On startup a matching cache is registered immediately, then refreshed in the
  background. Without a matching cache the first read is awaited before models
  are registered.
- A refresh that fails (timeout, 401/403, 5xx, a broken body) leaves the last
  good directory in place and reports the failure; it never publishes an empty
  catalog.
- A successful read replaces the directory and clears stale marks. Models the
  directory no longer lists are retained and marked stale for the retention
  window (seven days by default, measured from the first miss), then dropped. A
  model that reappears becomes current again.
- Stale models stay registered and selectable. Selecting one emits the `stale`
  warning and the TUI shows the stale count; the plugin never claims the
  upstream still serves it.
- Every refresh checks the connection generation and a request token before it
  commits, so a slow refresh from a replaced connection, a connection switch, or
  an unload cannot overwrite newer state.

## Reasoning, Fast and prices

The directory declares what a model supports; the plugin turns that into v2
semantic settings and lets OpenCode's runtime serialize the request. Nothing
registers an HTTP body hook, so the transport choice is never altered.

| Concern | Directory source | v2 setting | Wire field |
| --- | --- | --- | --- |
| Reasoning | `supported_reasoning_levels` | variant `settings.reasoningEffort` | `reasoning.effort` |
| Fast | non-empty `service_tiers` | model `settings.serviceTier` | `service_tier` |

The model-level `serviceTier` applies to every request for that model, so a Fast
model carries `service_tier: priority` on the primary turn, the summary/compaction
request, the title request and a `generate` request alike. A model that declares
no service tiers is never injected, and Fast never changes the reasoning variant
or its effort.

**Fast** is a durable, provider-scoped preference, off by default. `setFast` (or
`/cpa-fast`) persists it immediately; OpenCode compiles the provider registry
when the location boots, so the parameter reaches the wire after the location
reload that the TUI performs (or after a service restart). The snapshot keeps the
two apart: `fastEnabled` is the preference and `fastEffectiveModels` is how many
registered models actually send the parameter, so "Fast on, but the directory
declares no capable model" is a visible state rather than a silent no-op.

**Prices** are estimates from the public models.dev catalog, matched with the
same rules the official plugin uses: an explicit alias table for proxy-specific
ids, provider-namespace stripping, a normalized fallback key, and a provider
preference when several resellers publish the same model. When the remaining
prices disagree and no provider is preferred, no cost is used at all.

- the standard rate is used by default, and the published Fast rate
  (`experimental.modes.fast.cost`) when Fast is on;
- when models.dev publishes no Fast price, the standard rate is kept instead of
  inventing a multiplier;
- context tiers (`tiers`, or the legacy `context_over_200k`) become the
  context-tiered `cost` entries OpenCode understands;
- this is an estimate for display, never a CPA bill.

## Isolated host run

`scripts/host-smoke.mjs` loads the plugin into a real OpenCode binary with its
own config/data/cache/state/home directories and a mock CPA, then checks the
wire: the directory request, the model id and bearer on a Responses request, a
tool call plus result, OpenCode's own summary request after `session.compact`,
the summary carried into the next request, and that the fictional key never
reaches the host log.

It also covers this slice end to end against three directory entries: a
Fast-capable model, one with no service tiers and one that only declares
`additional_speed_tiers`. It asserts that Fast is off by default, that `setFast`
persists the preference while the effective count stays at zero until the
location reload, that the reload applies it to the capable model alone, that the
parameter then appears on the primary, summary/compaction, title and `generate`
requests, that a reasoning variant still reaches the wire unchanged, that the
price estimate is attached, that Fast off removes the parameter again, and that
a service restart restores the preference and the parameter. The models.dev
catalog is a loopback fixture, so the run stays offline.

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

`scripts/host-catalog.mjs` covers the cache and stale slice: a restart serving a
matching cache before the background refresh lands, a failed refresh keeping the
last directory, a legal empty directory staying distinct from a failure, manual
refresh over RPC, stale retention, recovery and expiry, the stale warning
emitted for a real request, per-credential cache isolation, and a location
reload cancelling an in-flight refresh so the superseded instance cannot commit
its result.

```bash
bun run smoke:catalog
```

All three talk to loopback mocks only — a mock CPA, plus a models.dev price
fixture for the smoke run: no real credential, no real CPA request, no cost.
`SMOKE_DEBUG=1` also dumps the request sequence of the smoke run.

## Development

Development dependencies are locked with `package-lock.json`; `bun` runs the
tests and the host scripts against that `node_modules`.

```bash
npm ci                 # install the locked development dependencies
bun test               # unit + native-runtime integration tests
bun test test/unit     # directory parsing, mapping, cache/stale, prices, Fast, connection, state, RPC, TUI
bun test test/integration   # real Responses serialization and SSE parsing
bun run typecheck      # tsc --noEmit
```

The integration tests drive `@opencode/ai/providers/openai-compatible/responses`
over real HTTP against the mock CPA, so serialization and stream parsing are the
host's own code rather than a stub. The host scripts additionally drive the real
host over its HTTP RPC, both as a remote client and as a catalog reader.

## Observations and limits

- Verified on OpenCode `2.0.26` only; other versions are untested and, outside
  `>=2.0.26 <3`, refused.
- With this runtime package the transport defaults to HTTP/SSE for a
  plugin-registered provider; WebSocket behaviour is not validated here. The
  priority parameter is still asserted on a WebSocket `response.create` frame
  built by the native channel serializer, so the payload is covered even though
  the connection lifecycle is not.
- OpenCode compiles a plugin's provider registry when the location boots. No
  plugin-facing API (`provider.reload`, `model.reload`, `integration.reload`,
  re-registering the transform) makes a changed model setting reach the wire on
  an already-booted location; a location reload or a service restart does. Fast
  therefore persists immediately and applies through the reload the TUI
  performs.
- The models.dev lookup is a network request bounded by `modelsDevTimeoutMs`
  (5s default). A failure is logged and the models are registered without a
  price; `modelsDev: false` skips it.
- The `opencode models` CLI resolves a location of its own and does not show
  location-scoped plugin models; the API's `model.list` with an explicit
  location does, and model availability is also exercised through a real
  session. That is also how the price estimate is observed.
- The interactive wizard masks the key and verifies before saving, but the host
  offers no password input for plugins, so the masked field is drawn by the
  plugin while the host's dialog API provides the frame.
- The directory cache lives in OpenCode's own plugin storage. Clearing that data
  only removes the fast start; the next setup reads the directory live again.
- Stale models stay registered and selectable, and the warning is the `stale`
  RPC event plus the TUI status, not a disabled model. The retention window is
  seven days by default and is shortened through `catalogStaleTtlMs` in the
  isolated host run.
- No real CPA deployment has been contacted. Tool round-trips, image input,
  summary compaction, the connection experience, the catalog cache/refresh/stale
  behaviour, the Fast parameter and the price estimate were validated against a
  mock CPA that speaks the same Responses and directory wire format.
