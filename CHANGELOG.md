# Changelog / 变更记录

## 0.1.1

- Fix rounded session durations carrying into the next minute: `1m60s` now
  displays as `2m00s`. Token, cost and timing accounting are unchanged.
- `/cpa-status` now shows the selected transport, compaction mode, fallback
  notes and pending settings. An OpenCode RPC outage is distinguished from
  failed CPA verification; a selected WebSocket transport is not a success claim.
- Manual tag publishing now verifies the exact public npm artifact and OIDC
  provenance, then creates a bilingual GitHub Release with tarball and checksum
  attachments. Retries continue only for identical artifacts; published versions,
  tags and conflicting assets are never overwritten.

- 修复耗时显示的分钟进位：`1m60s` 正确显示为 `2m00s`，不改变 token、费用或耗时记账。
- `/cpa-status` 补充选用的传输方式、压缩模式、回退说明及待生效设置，区分宿主 RPC 断连与 CPA 验证失败；选用 WebSocket 不代表请求已经成功。
- 手动 tag 发布会核验公开 npm 产物及 OIDC provenance，并生成双语 GitHub Release、包文件和校验和附件。同内容可安全重试，不覆盖已发布版本、正式 tag 或冲突附件。

**Verification remains bounded:** OpenCode `2.0.26` on Windows, packaged-plugin
mock checks and automated regressions; no additional real CPA or paid-model tests.
Existing native-compaction, physical-TUI and dependency-advisory limitations
still apply. See the linked verification and security notes.

测试仍限于 Windows / OpenCode `2.0.26` 的安装产物模拟验证与自动化回归，未新增真实 CPA 或收费模型测试；native 压缩、实际终端手动测试及依赖告警的既有边界保持不变。

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
