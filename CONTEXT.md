# OpenCode v2 CPA provider

本项目是 OpenCode v2 的 CLIProxyAPI provider 插件，以 CPA 官方 Pi 插件为功能基准，按 v2 的机制实现。`0.1.0` 已完成实现及用户约定的简单功能验收；已测宿主为 `2.0.26`，真实 CPA 与离线/mock 的具体覆盖和未测边界见 [README](README.md#accepted-verification-scope)，不代表所有模型、native 或未来版本均已验证。

## Language

**CPA**：CLIProxyAPI，本插件连接的代理服务；用户提供 CPA 地址和 API key，不由本插件管理上游供应商登录。

**CPA 官方 Pi 插件**：`router-for-me/pi-cliproxyapi-provider`，由 CPA 官方提供、运行在 Pi 中的参考插件。
_Avoid_: Pi 官方插件、Pi 版本是本项目的移植目标

**OpenCode v2 CPA 插件**：本项目 `opencode2-cliproxyapi-provider`；不兼容 v1，不局限于 Codex 上游模型。

**CPA 连接**：本插件使用的服务地址与认证身份的组合；目录缓存和请求必须属于同一个连接。
_Avoid_: 将凭证保存成功等同于连接已验证

**summary**：OpenCode 组织正常模型请求生成摘要、重建有效上下文的压缩方式；是本项目默认且必保的模式。

**native**：OpenCode 调用供应商专用压缩能力、续用其 checkpoint 的模式；本项目尽力适配，失败不阻塞交付。
_Avoid_: 软件自带压缩、普通压缩

**Fast**：向目录声明支持的模型请求 priority 服务档位的独立偏好；不等于提高推理档位，也不保证服务端一定提供更低延迟。

**stale 模型**：同一连接此前发现、当前目录暂时缺失而在保留窗口内的模型；仍在列表不表示上游此刻可调用。

**生效边界（apply boundary）**：连接、目录和 Fast 偏好的保存/验证，与运行时实际按新 binding 分发请求之间的边界，以 `applied` / `reloadRequired` 表达。已有 binding 的变更需宿主 location reload；空 binding 首次成功接入可立即生效，具体契约与理由见 [ADR 0002](docs/adr/0002-apply-boundary.md)。
_Avoid_: 把可见模型列表更新等同于运行时已生效

## Relationships

- OpenCode 会话保存历史；模型上下文是某次请求的有效内容；WebSocket/response ID 属于连接及续传状态。上下文重建不等于新建用户会话，也不自动证明服务端旧状态已清除。
- CPA 官方 Pi 插件提供功能基准和适配经验；OpenCode v2 的公开接口决定实现方式；社区插件只作辅助参考。
