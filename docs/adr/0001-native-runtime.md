# 使用 OpenCode 原生 Responses 运行时，而非按参考插件复刻通信栈

> Source: oc2cpa-bya (D2, D7, D8), design snapshot retained at commit `8bc28d0a766bf610e1424f3a0d4580f7adc88146`

CPA 官方 Pi 插件通过运行时补丁改造 Pi 的 Codex 实现；本项目仍以其功能为基准，但选择 OpenCode v2 原生 Responses 运行时加公开 hooks，不复制补丁或自建完整通信栈，也不先按模型家族拆成多种协议。这样可复用宿主的序列化、工具/推理回放及连接管理，代价是受宿主接口和版本变化约束，必须用实际请求与流事件验证差异，不能仅凭“OpenAI 兼容”判断成功。

研究快照中 CPA 的 `/v1/responses` 与 `/backend-api/codex/responses` 使用相同 handler；v2 发布包具备 Responses 的 WS 通道、续传及 HTTP 回退入口，支持这条路线，但不等于整个链路已经验证。HTTP hooks 可能影响 WS 选择；summary 后的上下文正确性是发布门槛。公开接口无法满足必保行为时报告限制并请求改议，不能隐式修改核心或悄悄删除功能。

默认保留宿主 summary，不移植 Pi 的上下文溢出触发机制；summary 重建上下文后通过公开 WS handshake hook 改 socket generation，让宿主新建连接，避免 CPA 续用旧服务端上下文。native 只作显式 opt-in 的尽力能力，不为它修改核心或阻塞交付；真实支持范围以 [README](../../README.md#accepted-verification-scope) 为准，不能把 mock checkpoint 通过当成真实支持。

依据：[CPA 路由快照](https://github.com/router-for-me/CLIProxyAPI/blob/f1d4a94ef4398349716f2db5bbc3a27624c174a7/internal/api/server_routes.go)、[OpenCode provider 文档](https://opencode.ai/v2/docs/providers)、[@opencode/ai 2.0.26 发布包](https://registry.npmjs.org/@opencode/ai/-/ai-2.0.26.tgz)。
