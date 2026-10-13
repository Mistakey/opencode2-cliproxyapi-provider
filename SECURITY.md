# Security / 安全

Only the current `0.1.x` release line is maintained. Host compatibility and tested
coverage are narrower than a general security support guarantee; see
[verification](docs/verification.md).

## Reporting

Please do not put exploit details or secrets in public issues. Use GitHub's
[private vulnerability reporting](https://github.com/Mistakey/opencode2-cliproxyapi-provider/security/advisories/new)
for this repository. If that feature is unavailable, open a public issue asking
for a private reporting channel **without** sensitive details.

Include the plugin/host version, operating system, impact and a minimal redacted
reproduction. Never include API keys, `.npmrc` tokens, native credential-store
files, raw acceptance/host logs, private CPA URLs or conversation content.
If a credential was exposed, revoke/rotate it with its owner; deleting a comment
or making a later clean commit does not revoke it.

## Dependency advisories at 0.1.0

The pinned OpenTUI/Solid dependency chain includes Seroval versions flagged by
[GHSA-p6vx-979v-rg4c](https://github.com/advisories/GHSA-p6vx-979v-rg4c) and
[GHSA-jp82-f5mq-hwhp](https://github.com/advisories/GHSA-jp82-f5mq-hwhp)
(untrusted `fromJSON` / `fromCrossJSON` deserialization). npm reports critical
severity transitively; this release does **not** claim a clean dependency audit.
The plugin does not import Seroval, use Solid web SSR, or deserialize network data
through those APIs. This source-level observation is not a security audit of
OpenCode or its complete dependency graph. The tested host/UI versions are retained
rather than forced to untested versions; revisit these advisories with a tested
host upgrade. Patched Seroval releases exist, but are outside the pinned Solid
`~1.5.0` dependency range.

当前固定 UI 依赖链存在上述上游反序列化告警，不能声称依赖审计零风险。插件自身不调用相关反序列化或 web SSR 路径；这不代表对宿主全链路完成安全审计。本次保留已测依赖，不强行覆盖其版本。

## Boundaries

This plugin runs inside OpenCode with the host's privileges; it is not a security
sandbox. CPA addresses are user-selected network destinations. Use a trusted CPA
service and TLS outside loopback. Keys are handled by OpenCode's native credential
store; this plugin does not manage upstream logins. Public price lookup is optional
(`modelsDev: false`). See the README for network and persistence behavior.

请勿在公开 issue 中提交漏洞利用细节、key、token、私人地址、凭证文件或原始日志。优先使用上述 GitHub 私密漏洞报告；不可用时，只公开请求私密联系渠道。凭证泄漏须由持有者撤销/轮换，删除文本不能使旧凭证失效。插件运行在宿主权限内，不是安全沙箱。
