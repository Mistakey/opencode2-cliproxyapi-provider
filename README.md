# OpenCode v2 · CLIProxyAPI provider

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Mistakey/opencode2-cliproxyapi-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mistakey/opencode2-cliproxyapi-provider/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode2-cliproxyapi-provider)](https://www.npmjs.com/package/opencode2-cliproxyapi-provider)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Tested host](https://img.shields.io/badge/tested_OpenCode-2.0.26-informational)](docs/verification.md)

Connect **OpenCode v2** to your [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
(CPA) deployment. Discover its models and use OpenCode's native Responses runtime
for conversations, tools and summary compaction over HTTP/SSE or WebSocket.

This is an independent OpenCode plugin, not an official OpenCode or CPA product.
The [CPA official Pi plugin](https://github.com/router-for-me/pi-cliproxyapi-provider)
is a functional reference; this package uses OpenCode's public APIs instead of
copying its runtime patches. It does not manage upstream provider logins.

## At a glance

- **Connect safely:** a masked-key wizard verifies the address/key pair before
  saving through OpenCode's credential store; native `/connect` is also supported.
- **Discover models:** reasoning variants, image capabilities, per-connection
  cache, stale-model retention and bounded directory recovery.
- **Control requests:** an opt-in Fast preference for declared-capable models,
  pause/resume, and per-session duration, TPS and token/cache statistics.
- **Stay native:** OpenCode owns tools, transport and summary compaction; the
  bundled TUI talks to the server through RPC, including remote connections.

**Scope:** OpenCode **2.0.26** is the tested host (Windows); the load-time range
is `>=2.0.26 <3`, not a promise that every version works. **OpenCode v1 is not
supported.** Real CPA coverage is limited; native compaction and a physical TUI
walkthrough are not verified. See [verification and limits](docs/verification.md).

## Install

Install OpenCode v2 separately, then pin the plugin's release:

```sh
opencode --version
opencode plugin add opencode2-cliproxyapi-provider@0.1.0
opencode plugin list
```

The [official plugin command](https://opencode.ai/v2/docs/plugins) manages the
package and global configuration. Exact versions remain pinned. Do **not** use
`npm install -g` for this plugin or point your daily setup at a development checkout.

Alternatively, add the entry to your existing `opencode.json(c)` **without
replacing other settings**:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode2-cliproxyapi-provider@0.1.0"]
}
```

The default global config directory is `~/.config/opencode`
(`%USERPROFILE%\.config\opencode` on Windows); project configs also apply.
Use **one** plugin entry, not both installation forms. Remove any old source-path
entry for this plugin when migrating. Server and TUI are in the same package;
**do not add it again to `cli.json`**. With a remote server, configure it on that
server; the terminal discovers the TUI from the server's plugin list.

## Connect

1. Open OpenCode and run **`/cpa-connect`**.
2. Enter your CPA base address, including any reverse-proxy subpath.
3. Enter the API key in the masked field. A successful directory probe saves
   the pair to OpenCode's native credential store.
4. Select a discovered model in OpenCode; **`/cpa-status`** shows connection state.

OpenCode's standard `/connect` saves first and reports verification afterwards;
`/cpa-connect` verifies **before** replacing the saved connection. A saved key is
not proof that the connection works. Never commit API keys to config files.

For a headless setup, inject `CLIPROXYAPI_BASE_URL` and `CLIPROXYAPI_API_KEY` in the
server environment. Explicit options override environment and stored settings;
address/key pairs are never silently mixed across different addresses. Details:
[configuration and RPC reference](docs/reference.md#configuration).

To set non-secret options, edit the existing plugin entry:

```jsonc
{
  "plugins": [{
    "package": "opencode2-cliproxyapi-provider@0.1.0",
    "options": {
      "transport": "auto",
      "compaction": "summary",
      "modelsDev": false
    }
  }]
}
```

`modelsDev` defaults to `true`; `false` above disables optional public price
lookup. With a configured connection, loading the plugin reads the CPA model
directory (or serves cache then refreshes). Later failures/stale entries can
schedule retries. By default it also reads `https://models.dev/api.json` for
**estimates, not billing**. Model requests happen through your OpenCode usage and
may incur upstream charges. This plugin does not supply a CPA account or key.

## Commands

| Command | Purpose |
| --- | --- |
| `/cpa-connect` | Verify and save an address/key pair |
| `/cpa-status` | Connection, catalog, Fast, transport and pending-apply state |
| `/cpa-refresh` | Force a directory refresh and apply if needed |
| `/cpa-fast` | Toggle persistent Fast preference; only capable models receive priority |
| `/cpa-pause` | Hold the next CPA request; an in-flight request finishes |
| `/cpa-resume` | Release waiting requests |
| `/cpa-stats` | Session duration, whole-turn TPS and token/cache usage |

The footer shows a compact CPA state and last-turn statistics. Fast does not
change reasoning effort or guarantee lower latency. Prices and TPS are estimates
with [explicit measurement rules](docs/reference.md#pause-and-statistics).

### Applying a connection or directory change

Changes can be **saved** before the runtime uses them (`reloadRequired: true`).
The TUI invokes OpenCode's location reload when needed. Reload cancels paused
requests and clears in-memory statistics; it never silently sends a held request.
Headless clients must perform the same public reload. The empty-boot first-connect
exception and RPC contract are in the [reference](docs/reference.md#applying-changes).

## Upgrade or uninstall

Back up your config first. To upgrade, choose an actual published version and
replace the existing exact pin with `opencode plugin add <package>@<version>`;
check `opencode plugin list` and remove any obsolete duplicate/source entry.
`opencode plugin update` skips exact-version pins; updates are deliberate.
Restart OpenCode if a changed package is not picked up automatically.

```sh
opencode plugin remove opencode2-cliproxyapi-provider@0.1.0
```

If you configured a project entry manually, remove that entry too. Removing the
plugin does not promise deletion of native credentials, sessions or plugin storage;
manage those through OpenCode. Do not delete unrelated host data.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Missing CPA commands | Check the server's plugin list and exact version; do not duplicate the package in `cli.json` |
| Saved but unverified/offline | Use `/cpa-status`; `/cpa-connect` verifies the explicit pair before saving |
| First uncached startup failed | Once CPA is reachable, use `/cpa-refresh`; the **first no-cache read is not auto-retried** |
| Pending apply / withdrawn Fast tier refused | Reload the location; this cancels paused requests and resets statistics |
| Requested WS but observed HTTP | Inspect `transportNote`; host fallback is not proof that WS worked |
| Native compaction unavailable | Keep default `summary`; native is opt-in and not real-CPA verified |
| Model missing from `opencode models` | On 2.0.26 that command has its own location; use the session model picker or location-scoped `model.list` |

When reporting a bug, include host/plugin versions, OS and a **redacted** status
or minimal reproduction. Do not post credentials, private endpoints, prompts or
raw host logs. See [security reporting](SECURITY.md).

## Accepted verification scope

The real CPA baseline is `11eb30e`, OpenCode `2.0.26`, one model (`gpt-6.1-sol`).
The pause-accounting change at `16afc4b` was checked offline, not reaccepted as a
full real-CPA build. Broader protocol/recovery checks use mocks. CI checks packaging
and an installed artifact against a real host **with fictional credentials**;
it is not an all-model, all-version or physical-TUI certification.

[Verification matrix](docs/verification.md) · [Technical reference](docs/reference.md)
· [Architecture decisions](docs/adr/0001-native-runtime.md)

## Isolated host run

Development and CI must not use your daily config or real CPA credentials.
`OPENCODE_CLI` selects the real host binary; `OC2CPA_SANDBOX` selects a local,
isolated home/config/data/cache/state directory. All fixtures use loopback.

```sh
npm ci --cache .forge/local/npm-cache --no-audit --no-fund
bun test
bun run typecheck
# Set OPENCODE_CLI to the OpenCode 2.0.26 executable first:
bun run smoke:package
```

[Development and smoke scripts](docs/development.md) · [Release procedure](docs/releasing.md)
· [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
