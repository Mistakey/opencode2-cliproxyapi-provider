# Development / 开发与隔离测试

[English](../README.md) · [中文](../README.zh-CN.md)

Use Node for npm tooling and **Bun 1.3.10** for tests/scripts. Dependencies remain
locked in `package-lock.json`; do not replace it with another package manager's
lock or point daily OpenCode at this checkout.

```sh
npm ci --cache .forge/local/npm-cache --no-audit --no-fund
bun test
bun run typecheck
```

The pinned OpenTUI dependency may warn that Node 24 is below its Node engine
range. The tested plugin host and tests use Bun; Node runs npm tooling, not the
TUI. Do not silence the warning by weakening engine/TLS/security settings or
upgrade the host API dependencies independently of compatibility testing.

## Package verification

```sh
bun run check:package
# With OPENCODE_CLI set to a real 2.0.26 binary:
bun run smoke:package
```

`check:package` creates a real npm tarball under `.forge/local/package`, validates
its file allowlist/metadata/exports, and installs it (not a link) into an isolated
consumer with pinned UI peers. It imports the server and TUI entrypoints from
that installation. `smoke:package` additionally runs the existing host smoke
against the installed package's `src` directory and requires host `2.0.26`.

The server and TUI remain TS/TSX source, as supported by OpenCode v2; no custom
compiler, bundled host runtime, installer or updater is provided. A module import
check does not exercise a physical terminal.

## Isolated host run

All `smoke:*` checks must use a local sandbox and fictional credentials. Do not
run them using your daily home/config, an existing real CPA connection or a
production key. The scripts start/stop **only their isolated service**.

PowerShell example (use your actual host binary path):

```powershell
$env:OPENCODE_CLI = 'C:\path\to\opencode.exe'
$env:OC2CPA_SANDBOX = Join-Path (Get-Location) '.forge/local/smoke'
bun run smoke:package
```

POSIX shell:

```sh
OPENCODE_CLI=/path/to/opencode OC2CPA_SANDBOX="$PWD/.forge/local/smoke" bun run smoke:package
```

`OPENCODE_CLI` must be the executable, not a Windows `.cmd` shim.
`OC2CPA_SANDBOX` overrides home/config/data/cache/state/temp for the host smoke.
`OC2CPA_PLUGIN_PATH` can point `smoke:host` at an installed directory containing
`index.ts` (this package's installed `src`); without it the development script
loads this checkout's `src`. OpenCode **2.0.26** requires a directory for this
local-path mode; an npm package's exports are checked separately by importing
both installed package subpaths. The package check sets the installed source
directory automatically, never the checkout. Use a dedicated sandbox: its generated
state/data/cache may be replaced between runs.

The primary host smoke covers directory auth/path, native HTTP tool round-trip,
summary compaction and continuation, Fast capability/reasoning/price behavior,
and persisted catalog/Fast restart. It uses loopback CPA and models.dev fixtures.

Additional scripts remain available for targeted development; they are **not**
all run in the minimal release CI:

| Command | Focus |
| --- | --- |
| `bun test test/unit` | Mapping, connection, cache, prices, Fast, pause, stats, TUI contracts |
| `bun test test/integration` | Real host runtime serializers over mock HTTP/SSE and WS |
| `bun run smoke:connection` | Native form, verify/connect failures, credential/location isolation and remote RPC |
| `bun run smoke:first-connect` | Empty binding's first successful connect/refresh applies immediately |
| `bun run smoke:catalog` | Cache, ordering, stale retention/expiry, recovery and reload cancellation |
| `bun run smoke:transport` | HTTP/WS selection, continuation, summary, mock native, recovery, parallel sessions and rotation |
| `bun run smoke:pause` | Pause/cancel/reload/unload lifecycle |
| `bun run smoke:pause-ws` | WS pause, summary, reconnect and statistics combinations |
| `bun run smoke:stats` | Whole-turn duration, pause exclusion, TPS and token/cache accounting |

`SMOKE_DEBUG=1` prints mock request details in the primary smoke; do not enable it
for real traffic. `OC2CPA_ONLY=ws|http|diagnostic|recovery|native|parallel|rotation`
selects one transport scenario. Keep logs/cache/raw runs under ignored
`.forge/local`; do not attach them publicly without redaction.

## CI

One Windows job pins OpenCode `2.0.26` and Bun `1.3.10`: locked install,
typecheck, tests, packaging, installed module exports and one host smoke. Pull
requests and main pushes can run checks but **cannot publish**. The release
workflow is manually dispatched on an exact version tag and reuses these checks.
See [release procedure](releasing.md).

中文摘要：日常环境固定 npm 发布版；开发测试使用独立 worktree、原 lock、局部缓存、loopback mock 与虚构 key。包验证检查真正安装的 tarball，不以源码测试代替发布产物测试。CI 不请求真实 CPA，也不做物理终端验收。
