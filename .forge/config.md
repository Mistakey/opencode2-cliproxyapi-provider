# opencode2-cliproxyapi-provider repo config

OpenCode v2 TypeScript source plugin; Bun runs the tests and development scripts.

## Verification

For all `smoke:*` checks, follow `README.md#isolated-host-run` and set `OPENCODE_CLI`; use a worktree-local sandbox, loopback mocks and fictional credentials.

- `code and mock CPA protocol regressions`: `bun test`
- `TypeScript changes`: `bun run typecheck`
- `isolated host load, HTTP tool round-trip, summary and Fast`: `bun run smoke:host`
- `connection wizard, credential isolation and remote RPC`: `bun run smoke:connection`
- `catalog cache, refresh ordering, stale retention and recovery`: `bun run smoke:catalog`
- `HTTP/WebSocket transport, recovery and compaction`: `bun run smoke:transport`
- `pause, cancellation and reload lifecycle`: `bun run smoke:pause`
- `WebSocket pause, summary and stats combinations`: `bun run smoke:pause-ws`
- `session duration, TPS and token/cache accounting`: `bun run smoke:stats`
- `human acceptance`: `oc2cpa-bya.8` authorizes a fixed build, isolated environment and real CPA request/cost scope; local mock validation does not grant that authorization, global installation, push or publication.
