---
date: 2026-10-11
issue: oc2cpa-bya
source: "用户通过 forge:grill 确认整体设计（Q3 A），授权进入 spec；未授权实现。"
---

# OpenCode v2 CPA provider 插件 spec

## 1. Goal and scope

开发 `opencode2-cliproxyapi-provider`，让 OpenCode v2 正确接入 CPA，并尽量对齐 CPA 官方 Pi 插件的功能、交互及稳定性处理。官方插件是功能基准与协议经验来源，不是逐行移植对象；社区插件只作接口接法的辅助参考。术语以 [CONTEXT.md](../../../CONTEXT.md) 为准。

本轮仅定稿设计。当前项目没有实现、构建系统或运行验证结果；以下均为经用户确认的目标，不是已交付能力。

### Acceptance

- A1：用户能交互配置 CPA 地址与 API key，也能无界面配置；能分清凭证已保存与连接已验证，切换连接不混用凭证或模型目录。
- A2：CPA 目录中的可用模型可被选择，真实 ID、隐藏项、上下文/输出限制、输入模态与推理档位正确映射；不将插件缩成仅支持 Codex。
- A3：Fast 默认关闭、可切换并持久化，与推理档位独立；只有声明支持的模型收到 priority 参数，状态显示偏好与实际生效的区别，价格不编造。
- A4：启动能复用匹配连接的缓存，支持后台与手动刷新；临时故障不清空可用目录；模型暂时消失时保留并告警、恢复，旧刷新不覆盖新状态。
- A5：经 CPA 的文本、图片输入（目录声明支持时）、工具调用/回传、推理及多轮续聊正确；HTTP/SSE 与可用的 WebSocket 路径有明确行为，错误、取消、重试与连接释放不污染其他会话。
- A6：默认 summary；摘要请求、压缩后的续聊、工具历史与连接状态必须正确，原始历史仍由 OpenCode 管理。native 是可选、尽力适配的能力，不支持时明确说明，不阻塞交付。
- A7：暂停只阻止后续 CPA 请求，正在生成的请求不因此中断；继续后恢复；暂停等待可取消、可随卸载清理，不影响其他 provider。
- A8：TUI 提供设置、Fast、暂停/继续、刷新与状态入口，以及会话耗时、TPS、token/cache 统计；多个会话和远程 TUI 不混淆状态，无界面场景无需 TUI。

### Non-goals / Constraints

- 仅跟进当前 OpenCode v2，声明所需与已验证版本；不兼容 v1，不承诺未来未测试版本自动兼容。
- 不修改 OpenCode 核心、CPA、其他项目或用户现有配置；不代用户登录 CPA 上游供应商。
- 不复制 Pi 的源码补丁、宿主上下文格式适配或仅为 Pi UI 限制存在的 OAuth 包装。
- 不自建完整通信栈，不因“OpenAI 兼容”宣称全部适配完成；若核心限制阻塞必保功能，报告并由用户决定，不静默删减。
- 安装或发布插件、真实 CPA 调用（可能消耗额度）须另行授权。本 spec 不授予这些权限，也不发布自动执行工作图。

## 2. Decisions

### D1：以当前 OpenCode v2 接口为基线

跟进最新 v2，可采用必要的实验性接口；声明支持条件、做能力检测与回归。研究时直接读取了 `@opencode/plugin`、`@opencode/ai`、`@opencode/schema`、`@opencode/client` 的 2.0.26 发布包，未安装或运行。实现启动时应重新确认目标版本，不把研究版本误写成已测试版本。[R4–R7]

### D2：原生运行时加 CPA 适配，不复刻 Pi 内部机制

优先复用 OpenCode 原生 Responses 请求编码、流解析和连接管理；插件承担目录、能力、偏好与必要的 CPA 差异。不会仅按 Claude/Gemini 等模型名称就预先切换另一协议，也不限制 CPA 上游模型种类。协议例外必须由验证证明。长期理由见 [ADR 0001](../../adr/0001-native-runtime.md)。

拟采用 `/v1/responses`；研究快照中它与 `/backend-api/codex/responses` 注册相同 HTTP/WS handler。该证据只覆盖所读 CPA 版本，不证明任意旧部署等价。地址规范化保留反向代理子路径，不能粗暴只取 origin。[R2]

### D3：地址和 key 是一个连接；使用原生凭证设施

提供标准 `/connect` 的 CPA key 方法与地址表单；支持环境变量及显式插件配置。凭证交给 OpenCode 管理，不另建插件明文 key 文件，不借 OAuth 名称伪装授权服务。

标准 key 注册接口没有自定义远程校验回调，因此区分两条交互：标准入口保存后验证并显示结果；插件设置向导先在服务端验证，再通过原生接口保存。失败不会被呈现为可用；合法空目录与网络/认证/格式错误必须区分。向导的遮蔽输入及事务性保存属于运行验证门槛。[R4,R7]

配置解析应明确优先级、显示实际来源，将地址和 key 按连接成对处理，不跨来源盲目拼接。已实现并固化为测试：地址来自 plugin options 优先于环境；其 key 取自同一来源，或当另一显式来源未配置不同地址（或地址相同）时借用；显式地址只有在 stored credential 同一地址（归一化比较）时才复用其 key，否则作为部分配置拒绝；显式 key 无地址时保留 stored 地址，否则用默认地址。连接切换时使旧刷新失效、重绑模型目录；缓存、事件、日志均不得含凭证。上次连接的目录不得借 stale 保留泄漏到另一个连接。

### D4：CPA 增强目录是能力的首要依据

利用带 `client_version` 参数的增强目录，而不只读取普通 `/v1/models` 后猜测能力。采用明确的自身客户端标识，不默认假冒 Pi；具体标识与目标 CPA 的兼容性须验证。解析真实 ID、隐藏项、限制、模态和推理档位；不按名称发明能力。models.dev 用于价格补充等缺失信息，不能覆盖 CPA 的明确能力约束。[R1,R2]

目录缺字段的保守回退、格式错误与空目录、别名匹配及不支持模型的展示规则必须覆盖测试。缺失能力不等于已证实支持。

### D5：Fast 是独立、持久且有能力门控的偏好

默认关闭；对齐官方插件目录驱动的启用原则。所读官方实现以非空 `service_tiers` 识别能力，忽略 `additional_speed_tiers`，有效时发 `service_tier: priority`；这描述参考实现，不代表任何服务器非空 tier 都必然支持 priority。[R1]

优先使用 v2 语义参数 `serviceTier`，推理使用声明的 variants；覆盖主对话、工具续轮、summary 及其他相关请求。避免为参数注入注册 HTTP body hooks，因 v2 文档声明 HTTP hooks 会影响 WS 选择。[R3,R4,R5] Fast 是持久偏好，变更与运行时生效分开（见 D11）：未 reload 前 snapshot 报已应用的 `fastEffectiveModels` 与 `reloadRequired`。

支持标准、Fast 和上下文分档价格；缺少 Fast 价格时保持标准参考价并说明，不编造倍率，不把估算成本当 CPA 实际账单。

### D6：缓存、stale 恢复与刷新有连接隔离和代次控制

匹配连接的缓存支持快速启动，再后台刷新；手动刷新绕过目录缓存。暂时失败保留最后有效数据，不能无声伪装为刷新成功。暂时消失的模型保留、标记并尝试恢复，默认对齐官方七天窗口；自首次消失计时，重新出现则清除 stale。[R1]

所有刷新提交检查连接及请求代次；连接改变、卸载和过期刷新可取消。认证错误与暂时网络错误分开处理；不将错误结果当合法空目录提交。缓存不保存 key，且不能跨连接复用目录。保存/验证与运行时生效分开（D11）：已提交但未 reload 的目录报 `reloadRequired`，旧 commit 的存储写入不能最终覆盖新 cache 或 provider。

### D7：自动选择传输，连接正确性优先

默认由插件依据目录明确的 WebSocket 偏好及运行时能力选择 WS，否则 HTTP/SSE；提供强制 HTTP 与请求 WS 的选项。`auto` 是插件决策，不是 v2 原生 transport 枚举；已读枚举为 `http | websocket`。[R6]

底层使用宿主连接与重试机制；失败回退受宿主发送/输出状态约束，不自行重放已经输出或产生工具副作用的请求。补充错误分类应有有界重试，不与 CPA 和宿主叠加成无界重试。凭证轮换、并行会话、取消、卸载与空闲连接生命周期必须验证；注册 HTTP hooks 对 WS 的影响纳入检查。[R3–R5]

### D8：summary 必保，native 尽力且不阻塞

使用 OpenCode 自身 summary 调度，不移植 Pi 用合成上下文溢出触发压缩的实现。摘要请求、完成后重建的上下文、工具 ID/推理回放和服务端续传状态都要正确。只在实际复用连接且证明确有需要时补重置，不将“发送全量历史”视为服务端必然清空旧上下文。[R1,R2,R8]

native 默认不启用；仅在所测模型/端点链路正确时宣称支持。有兼容问题则明确暂不支持，不为它修改核心、不阻塞必保功能交付，也不偷偷把 native 失败转换为 summary。用户已明确批准此取舍。

### D9：服务端管理状态，TUI 经 RPC 操作和订阅

同一包包含服务端与 TUI 入口。服务端负责连接解析、CPA 网络请求、目录、Fast、暂停和刷新；TUI 不直接访问 CPA 或服务端本地文件。通过原生 RPC 的方法、状态快照和事件交互；事件不是可靠历史，重连应重读快照，并按 location/provider 过滤。[R9,R10]

提供 CPA 前缀的稳定命令入口；短别名仅在无冲突且宿主可安全注册时提供，不覆盖其他命令。偏好按插件作用域/provider 隔离，运行统计按会话隔离；无界面调用可用服务端入口。

暂停门控后续 provider 请求，不打断正在发送的请求；继续控制不应依赖被门控的模型调用。暂停等待须响应会话取消及卸载，不能照搬不可取消的轮询。具体作用域和取消实现须通过宿主生命周期测试。

耗时和用量展示学习官方插件：TPS 是输出 token / 整轮有效运行耗时，不声称纯解码速度。明确暂停计时和重试累计口径，不混入子会话，不重复累计事件。[R1]

### D10：按三层验证交付，接口存在不等于实现可用

测试 seams 是目录/连接状态的行为接口、真实序列化请求与模拟 CPA 流、实际宿主加 CPA 的端到端链路。算法测试可注入网络、时钟和存储；不能仅 mock 掉 OpenCode 就宣称运行时兼容。

先验证关键宿主接法，再补齐首版功能与自动化回归，最后在授权的隔离环境联调。最小端到端链路是实施顺序，不是缩减最终功能范围。native 的不支持结论可作为该可选能力的合法交付，其他必保能力失败则不能标为通过。

### D11：连接与目录变更是两阶段生效（用户 Q4 B 裁决）

宿主在 location boot/reload 时编译 provider registry，因此 connect、手动/后台
refresh 与 Fast 变更只在提交时保存并验证；运行时按新目录分发需要一次公开的
location reload。snapshot 用机器可读的 `applied` / `reloadRequired` 区分“已保存、
已验证”与“运行时已生效”，`fastEffectiveModels` 描述已应用的 Fast 效果而非待应用
偏好；未 apply 不得冒称生效。TUI 在 `reloadRequired` 时自动调用宿主公开的
`location.reload()` 再重读快照；无界面调用方读同一标志后自行调用公开 reload。
插件不自行热更新运行时、不新增脚本框架。binding 签名一致（目录未变）时不要求
reload。待 apply 期间，一个会携带已撤回 Fast tier 的**新**请求在公开请求 seam 上
被拒绝（已在飞的请求不受影响），不把撤回档位发到 wire。此边界经 oc2cpa-bya.13
用户裁决（选项 B）确认，取代“插件可独立热更新”的
假设。

## 3. Verification

当前未运行测试。项目尚无 package.json、构建命令或 `.forge/config.md`；不得编造已可执行的验证命令。构建系统建立后，依据实有脚本另行提出配置草案，经用户批准记录命令。

| 验收 | agent 必须提供的证据 |
|---|---|
| A1 | 原生 key 表单及设置向导的宿主验证；正确/错误 key、不可达地址、合法空目录、错误 JSON；保存和验证状态不同；地址/key 配对、连接切换、敏感信息脱敏测试；连接切换后 `reloadRequired` 为真、location reload 后 `applied` 为真 |
| A2 | CPA 增强目录样本到 v2 模型的测试，含隐藏项、缺字段、别名、有限数值限制及推理档位；实际宿主模型选择与请求中的真实 ID、图片输入能力验证 |
| A3 | 捕获 HTTP 请求和 WS 帧，证明 Fast 开/关、支持/不支持及不同请求 kind 的行为；重启后偏好、推理独立性、标准/Fast/分档价格及未知价格回退测试；待 apply 时 snapshot 报已应用的 `fastEffectiveModels` 与 `reloadRequired`，reload 后才按新目录发送 |
| A4 | 缓存启动、超时/401/429、刷新失败、模型消失七天边界及恢复、手动刷新、并发刷新乱序、切换连接和卸载取消的确定性测试；目录变更在 reload 前标为 `reloadRequired`，目录未变则不要求 reload |
| A5 | 正常流、工具调用/结果、推理与多轮对话；建连失败、首帧前和输出后断线、续传失效、取消、凭证轮换、并行会话及资源释放；不能只证明普通文本能返回 |
| A6 | HTTP 与 WS 下分别触发 summary，记录摘要请求、压缩后实际上下文和后续工具循环；断言旧历史未被错误追加、无孤立工具结果或错误 reasoning 回放；native 成功链路或明确不支持及原因记录 |
| A7 | 暂停期间不发送下一请求、当前请求可完成、继续恢复、取消及时终止、卸载无遗留等待；其他 provider 不受影响，多会话作用域符合设定 |
| A8 | TUI 与服务端 RPC 联通、远程 location 隔离、断开重连读快照；命令不覆盖现有入口；耗时/TPS/token/cache 口径、暂停/重试、事件去重及子会话隔离验证 |

- **human gates**：用户负责授权插件安装、隔离宿主测试的环境准备以及真实 CPA 请求/费用；执行者在授权前提供目标构建、测试清单、使用环境和可能产生费用的操作。未授权阶段仅离线/模拟验证。发布另行授权，不因测试通过自动发布。
- **review**：全范围需独立检查凭证与缓存隔离、参数真实下发、传输/重试副作用、summary 前后状态，以及功能对照遗漏。具体任务与依赖由后续 slice 决定，不在本轮创建执行子任务。
- **Not exhaustive**：不验证所有 CPA 历史版本、所有上游模型或未来 OpenCode 版本；已测矩阵必须列明版本/模型/传输。native 失败作为明确支持边界，不无限扩展研究或修复核心。

## 4. 精确的未验证项

这些是后续实施的验证门槛，不是已实现事实：

1. 当前目标宿主能否注册新 CPA integration、显示 key 地址表单并完成带配置的保存；自定义向导能否遮蔽输入、先验证后原子切换。
2. 运行时 package 的宿主实际加载、设置传递与模型级传输选择，是否与发布包及文档一致。
3. 所选自身 `client_version` 能否在目标 CPA 返回完整能力；非空 service tiers 是否足以请求 priority。
4. 通过公开 hooks 能否使 WS 下 summary 后的 CPA 状态正确；不存在已确认的插件专用“关闭该连接”接口。不得绕过驱动内部状态随意改写帧。
5. 暂停门控的等待能否随会话取消和插件卸载及时结束；必要时采用宿主支持的可中断执行形式。
6. 完整配置优先级、部分连接配置的拒绝规则及多 location 偏好作用域需在实现中明确定义、测试并公开，不能混淆凭证与目录所属连接。
7. native 在具体模型/部署上的可用性，仅尽力验证；失败不扩大必保范围。

## 5. Reference comparison and evidence

| 参考行为 | 本项目处理 |
|---|---|
| CPA 官方 Pi 插件完整功能集合 | 首版功能基准；宿主不需要的机制不照搬，无法对齐的必保功能报告而非静默删除 |
| Pi OAuth 类型交互壳 | 用 v2 原生 key 表单与验证向导实现接入体验，不引入 CPA OAuth 服务假设 |
| Pi Codex 源码补丁/上下文兼容层 | 使用 v2 原生运行时与公开扩展点；不修改其他项目 |
| Pi 主动压缩及 WS 重置 | 保留正确性目标，依 v2 自身 summary 和实际连接状态判断补充需求 |
| 社区 v2 目录、模型注册与协议选择 | 只参考接口接法；不以其功能上限或按名称分协议替代 CPA 验证 |

### Sources

下列路径是研究时观察，不是本项目已实现坐标。GitHub 引用固定到研究快照；官网为滚动文档，实现时需重新核对。

- R1：[CPA 官方 Pi 插件 cfb449a](https://github.com/router-for-me/pi-cliproxyapi-provider/tree/cfb449a22c7ef03a0d67c8ce23c1454c79c8562a/extensions)。已读 `index.ts` 相关注册/刷新/命令流程、`lib.ts` 目录/价格/缓存相关部分、`codex-stream.ts`、`auto-compact.ts`、`pause.ts`、`retry.ts`、`tps.ts`；并非声称整个仓库全部读完。
- R2：[CPA f1d4a94](https://github.com/router-for-me/CLIProxyAPI/tree/f1d4a94ef4398349716f2db5bbc3a27624c174a7)：`internal/api/server_routes.go`、`internal/client/codex/models/models.go`、`sdk/api/handlers/openai/openai_handlers.go`、`openai_responses_websocket_requests.go` 相关目录、路由和历史处理分支。
- R3：[OpenCode v2 providers](https://opencode.ai/v2/docs/providers)：运行时、transport、超时以及 HTTP hooks 对 WS 的影响。
- R4：[@opencode/plugin 2.0.26 发布包](https://registry.npmjs.org/@opencode/plugin/-/plugin-2.0.26.tgz)：`dist/promise/{integration,provider,session,rpc,plugin}.d.ts`、Effect hook 类型；[插件文档](https://opencode.ai/v2/docs/build/plugins)。
- R5：[@opencode/ai 2.0.26 发布包](https://registry.npmjs.org/@opencode/ai/-/ai-2.0.26.tgz)：Responses provider/protocol、`open-responses-channel.js`、`open-responses-continuation.js`、语义参数处理；只读检查，未执行。
- R6：[@opencode/schema 2.0.26 发布包](https://registry.npmjs.org/@opencode/schema/-/schema-2.0.26.tgz)：provider、model、credential、integration、connection、form schemas。
- R7：[@opencode/client 2.0.26 发布包](https://registry.npmjs.org/@opencode/client/-/client-2.0.26.tgz)：key connect、credential 操作的生成类型。
- R8：[OpenCode v2 compaction](https://opencode.ai/v2/docs/compaction)：summary 默认、native 配置及支持限制。
- R9：[OpenCode v2 TUI 插件](https://opencode.ai/v2/docs/build/plugins/cli)：同包 TUI 入口、命令、slots、事件及客户端。
- R10：[OpenCode v2 插件 RPC](https://opencode.ai/v2/docs/build/plugins/rpc)：服务端注册、TUI 调用、实时事件与 location。
- R11：[社区插件 8227071](https://github.com/moutansos/opencode2-cliproxyapi/tree/82270716b13a39e344b998b4fded923b6136c2d6/src)：已完整读取 `index.ts`；发现、元数据与协议功能的观察不构成对其运行正确性的认可。
