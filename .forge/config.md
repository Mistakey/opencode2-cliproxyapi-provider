# opencode2-cliproxyapi-provider repo config

OpenCode v2 TypeScript source plugin; Bun runs the tests and development scripts.

## Verification

- `code and mock CPA protocol regressions`: `bun test`
- `TypeScript changes`: `bun run typecheck`
- `isolated host load, HTTP tool round-trip and summary`: follow `README.md#isolated-host-run`, set `OPENCODE_CLI` to the selected v2 executable, then run `bun run smoke:host`; the script uses a worktree-local sandbox and a loopback mock CPA with fictional credentials.
- `human acceptance`: `oc2cpa-bya.8` authorizes a fixed build, isolated environment and real CPA request/cost scope; local mock validation does not grant that authorization, global installation, push or publication.
