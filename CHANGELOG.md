# Changelog / 变更记录

## 0.1.0

First public GitHub + npm release / 首个 GitHub + npm 公开版本。

- OpenCode v2 native Responses provider for CPA, with directory discovery,
  connection wizard/native credential storage, HTTP/WS and summary compaction.
- Reasoning variants, capability-gated Fast preference, catalog cache/stale
  retention, pause/resume and per-session statistics.
- Server and TUI exports in one TypeScript source package; fixed-version official
  installation, bilingual READMEs, MIT license and documented upgrade/uninstall.
  The TUI declares its OpenTUI JSX source explicitly so installed TSX does not
  accidentally resolve React outside the development checkout.
- Minimal Windows CI verifies the packed/installed artifact against OpenCode
  `2.0.26` and loopback mocks. Publishing is an explicit manual tag workflow.

首发包含 CPA 模型发现、原生凭证与连接向导、HTTP/WS、summary、Fast、目录缓存、暂停及统计；同包服务端/TUI、固定版本安装、双语文档及最小产物 CI。

**Verification is bounded:** real observations are from `11eb30e`; the
pause-accounting fix at `16afc4b` is offline-only. Native compaction and a physical
TUI walkthrough are not real-CPA acceptance claims. See
[the verification matrix](docs/verification.md).
