# Verification scope / 验证范围

A passing CI badge describes that workflow, not universal compatibility.
CI 通过只说明该工作流通过，不代表所有模型、宿主版本或真实部署均兼容。

## Fixed baselines

- **Real CPA:** OpenCode `2.0.26` on Windows, plugin `0.1.0` at
  [`11eb30e`](https://github.com/Mistakey/opencode2-cliproxyapi-provider/commit/11eb30e),
  only `gpt-6.1-sol` (low reasoning for the final combinations). CPA server version
  was not established. Real price lookup was disabled.
- **Offline delta:**
  [`16afc4b`](https://github.com/Mistakey/opencode2-cliproxyapi-provider/commit/16afc4b)
  corrects pause-accounting event order using clock replay and a fictional-key
  host check. It was **not** re-tested as a full real-CPA build.
- **Release checks:** typecheck, Bun unit/native-runtime tests, package contents
  and both exports, then one installed-package run on OpenCode `2.0.26`, Windows,
  loopback mocks and fictional keys. No real CPA model requests are part of CI.

`0.1.1` adds duration-display and status-detail regressions plus publication
retry/conflict tests. These are offline changes, not new real-CPA acceptance.
Release changes do not expand those historical acceptance boundaries.
Historical failed/blocked checks remain historical; targeted fixes do not
retroactively turn them into a full-build review or all-model acceptance.

## Matrix

| Area | Offline / isolated-host evidence | Real CPA observation and limit |
| --- | --- | --- |
| Connection | Native form, masked wizard, verify-before-save, saved/verified/apply states, credential isolation | Directory authentication, saved native connection and reload state observed |
| Models | Directory mapping, hidden entries, limits, modalities and reasoning variants | One model ID and one synthetic image; not all models |
| Fast | Capability gating, HTTP/WS serialization, persistence/write failure, reference prices | WS priority + low observed; final off save/reload observed, **no subsequent off model request**; real prices disabled |
| Catalog | Matching cache, refresh ordering, stale retention, bounded recovery | Directory reads only; no real outage/stale matrix |
| Requests | Native HTTP/SSE and WS, tools, continuation and recovery | HTTP/WS tool content, incremental same-socket turns, one image and reconnect observed |
| Compaction | Summary continuation and mock native checkpoint | HTTP summary, WS follow-up on a new socket with old raw/tool context removed; **native not tried** |
| Pause | Cancellation, provider scope, reload/unload cleanup | WS wait/resume and cancellation without a model frame |
| UI / stats | RPC/TUI module, location/session isolation, usage accounting | RPC/reconnect and TUI module rendering, **not a physical terminal walkthrough**; pause overlap corrected offline at `16afc4b` |

A prior real-WS test failure was traced to missing authentication in its temporary
test proxy, not a production WS defect. Other earlier intermittent test failures
whose causes were not established are not relabeled as proven environment issues.
Raw acceptance logs are intentionally **not public**: they can contain credentials,
private endpoints or conversation data. Public support claims are stated here
without depending on a private tracker or local evidence path.

## Important limits / 重要边界

- Tested host: `2.0.26` only. The accepted load range `>=2.0.26 <3` is not a test matrix;
  v1 and unsupported major versions are refused.
- Native compaction is opt-in, best effort and not real-CPA verified. Default summary stays required.
- The initial failed **uncached** directory read needs manual refresh; later background/manual failures or stale directories schedule recovery.
- Host fallback from WS to HTTP is not evidence of a successful WS exchange.
- TUI module checks do not stand in for physical terminal acceptance or screenshots.
- TPS covers the whole turn; prices are estimates, not billing or decode speed.

中文摘要：真实验证仅限上述单一宿主/模型；后续计时修正属于离线增量。native、物理终端完整操作、真实 outage/stale 矩阵，以及最后关闭 Fast 后的模型请求均未补测。发布检查不重开功能验收，也不扩大这些保证。

See [development](development.md) for reproducible mock checks and
[the reference](reference.md) for precise runtime behavior.
