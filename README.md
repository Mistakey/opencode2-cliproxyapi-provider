# opencode2-cliproxyapi-provider

OpenCode v2 provider plugin for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA).

It connects OpenCode to a CPA deployment: the plugin reads CPA's enhanced model
directory, registers the models it reports, and lets OpenCode's **native
Responses runtime** talk to CPA over HTTP/SSE. It is not a port of the official
Pi plugin and does not re-implement serialization, streaming or compaction.

## Status of this slice

Delivered here:

- explicit (no-UI) CPA address and key -> enhanced directory -> OpenCode model
  registration -> native Responses HTTP/SSE, including tool call/result
  round-trips, image input mapping and OpenCode's own summary compaction
- credential handling through OpenCode's native key method and credential store
- project scaffolding, tests, an isolated host smoke script and this document

Not part of this slice (later tasks): interactive credential wizard, persisted
catalog and refresh, Fast/service tiers, TUI, WebSocket transport and its failure
matrix, native (provider-side) compaction, real CPA validation.

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

A **connection** is one address plus one API key, and both must belong together.

| Source | Address | Key |
| --- | --- | --- |
| plugin `options` | `baseURL` | `apiKey` |
| environment | `CLIPROXYAPI_BASE_URL` | `CLIPROXYAPI_API_KEY` |
| `/connect` -> CLIProxyAPI | stored with the credential | stored by OpenCode |

Precedence is plugin options, then environment, then the stored connection. An
explicitly configured address or key always wins as a pair, so an environment
variable is never silently mixed with an unrelated stored connection; the stored
address only fills a gap the explicit configuration leaves open. When an explicit
key differs from the stored credential, the plugin stores it through the native
key method, so OpenCode owns it and injects it into requests. An unchanged pair is
reused instead of writing another credential.

Other options: `providerID` (default `cliproxyapi`), `providerName`,
`integrationID`, `package` (runtime package override) and `catalogTimeoutMs`.

The address may include a reverse-proxy subpath; it is preserved:

```
https://gateway.example.com/cpa      -> baseURL https://gateway.example.com/cpa/v1
http://127.0.0.1:8317/v1             -> baseURL http://127.0.0.1:8317/v1
```

The directory is read from `<baseURL>/models?client_version=<this plugin>`, and
the Responses runtime appends `/responses` to `baseURL`.

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

It talks to the mock CPA only: no real credential, no real CPA request, no cost.
`SMOKE_DEBUG=1` also dumps the request sequence.

## Development

```bash
bun install
bun test              # unit + native-runtime integration tests
bun test test/unit    # directory parsing, mapping, connection, registration
bun test test/integration   # real Responses serialization and SSE parsing
bunx tsc --noEmit     # type check
```

The integration tests drive `@opencode/ai/providers/openai-compatible/responses`
over real HTTP against the mock CPA, so serialization and stream parsing are the
host's own code rather than a stub.

## Observations and limits

- Verified on OpenCode `2.0.26` only; other versions are untested and, outside
  `>=2.0.26 <3`, refused.
- With this runtime package the transport defaults to HTTP/SSE for a
  plugin-registered provider; WebSocket behaviour is not validated here.
- `opencode models` and `model.list` resolve a location of their own and do not
  show location-scoped plugin models; model availability is exercised through a
  real session instead.
- No real CPA deployment has been contacted. Tool round-trips, image input and
  summary compaction were validated against a mock CPA that speaks the same
  Responses wire format.
