# OpenCode v2 · CLIProxyAPI provider

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Mistakey/opencode2-cliproxyapi-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/Mistakey/opencode2-cliproxyapi-provider/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode2-cliproxyapi-provider)](https://www.npmjs.com/package/opencode2-cliproxyapi-provider)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![已测宿主](https://img.shields.io/badge/tested_OpenCode-2.0.26-informational)](docs/verification.md)

将 **OpenCode v2** 连接到你的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）服务：读取模型目录，使用 OpenCode **原生 Responses 运行时**，通过 HTTP/SSE 或 WebSocket 完成对话、工具调用和 summary 压缩。

这是独立的 OpenCode 插件，**不是 OpenCode 或 CPA 官方产品**。[CPA 官方 Pi 插件](https://github.com/router-for-me/pi-cliproxyapi-provider)是功能参考；本项目使用 OpenCode 公开接口，不复制运行时补丁，也不管理上游供应商登录。

## 能做什么

- **连接与凭证**：遮罩 key 向导先验证地址/key，再交给 OpenCode 原生凭证存储；也支持原生 `/connect`。
- **模型目录**：推理档位、图片能力、按连接缓存、stale 模型保留和有边界的目录恢复。
- **请求控制**：对明确声明能力的模型开启 Fast；暂停/恢复；按会话统计耗时、TPS、token/cache。
- **保持原生**：工具、传输和 summary 由 OpenCode 负责；同包 TUI 通过 RPC 操作服务端，支持远程连接。

**支持边界**：已测宿主为 Windows 上的 **OpenCode 2.0.26**；加载允许范围为 `>=2.0.26 <3`，不代表所有版本已验证。**不支持 OpenCode v1**。真实 CPA 只覆盖有限范围；native 压缩和物理终端完整操作未验证。详见[验证范围](docs/verification.md)。

## 安装

先单独安装 OpenCode v2，再安装插件的固定发布版：

```sh
opencode --version
opencode plugin add opencode2-cliproxyapi-provider@0.1.0
opencode plugin list
```

[官方插件命令](https://opencode.ai/v2/docs/plugins)管理包与全局配置；精确版本保持固定。**不要**对本插件使用 `npm install -g`，日常环境也不要引用开发源码目录。

也可以在现有 `opencode.json(c)` 中增加插件项，**不要覆盖其他配置**：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode2-cliproxyapi-provider@0.1.0"]
}
```

默认全局配置目录是 `~/.config/opencode`，Windows 为 `%USERPROFILE%\.config\opencode`；项目配置也会生效。两种安装方式选一种，保持**一个**插件入口；从源码迁移时移除本插件旧的源码路径入口。服务端与 TUI 在同一包中，**不要再次添加到 `cli.json`**。使用远程服务端时，在服务端配置插件，终端会从服务端的插件列表发现 TUI。

## 连接 CPA

1. 打开 OpenCode，运行 **`/cpa-connect`**。
2. 输入 CPA 基础地址；有反向代理子路径时一并填写。
3. 在遮罩输入框填写 API key；目录探测成功后，将连接保存到 OpenCode 原生凭证存储。
4. 在 OpenCode 选择发现的模型；**`/cpa-status`** 可查看连接状态。

原生 `/connect` 是先保存、后报告验证状态；`/cpa-connect` 是**先验证，再替换已有连接**。“已保存”不等于“验证成功”。不要把 API key 提交到配置文件或 Git。

无界面环境可向服务端注入 `CLIPROXYAPI_BASE_URL` 和 `CLIPROXYAPI_API_KEY`。显式选项优先于环境变量与已保存设置，但不会悄悄混配不同地址的 key。详见[配置与 RPC 参考](docs/reference.md#configuration)。

非敏感选项可写在现有插件项中：

```jsonc
{
  "plugins": [{
    "package": "opencode2-cliproxyapi-provider@0.1.0",
    "options": {
      "transport": "auto",
      "compaction": "summary",
      "modelsDev": false
    }
  }]
}
```

`modelsDev` 默认是 `true`；示例的 `false` 关闭可选公共价格查询。已有连接时，加载插件会读取 CPA 模型目录，或先返回缓存再后台刷新；后续失败或 stale 目录可能安排重试。默认还会读取 `https://models.dev/api.json`，仅提供**价格估算，不是账单**。你在 OpenCode 中的模型使用可能产生上游费用；插件不提供 CPA 账户或 key。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/cpa-connect` | 验证并保存地址/key |
| `/cpa-status` | 查看连接、目录、Fast、传输及待生效状态 |
| `/cpa-refresh` | 强制刷新目录，必要时应用变更 |
| `/cpa-fast` | 切换持久 Fast 偏好；只对声明能力的模型发送 priority |
| `/cpa-pause` | 暂停下一次 CPA 请求；在飞请求继续完成 |
| `/cpa-resume` | 释放等待中的请求 |
| `/cpa-stats` | 当前会话耗时、整轮 TPS 与 token/cache 用量 |

页脚显示简短 CPA 状态和上一轮统计。Fast 不改变推理档位，也不保证延迟更低。价格和 TPS 有明确的[计算口径](docs/reference.md#pause-and-statistics)。

### 连接或目录变更何时生效

变更可能已经**保存**，但运行时尚未使用（`reloadRequired: true`）。TUI 会在需要时调用 OpenCode 的 location reload。reload 会取消暂停中的请求并清空内存统计，**不会偷偷放行暂停请求**。无界面调用方须自行执行相同的公开 reload；空 binding 首次接入的例外与 RPC 契约见[参考](docs/reference.md#applying-changes)。

## 升级与卸载

先备份配置。升级时选择真实已发布的版本，用 `opencode plugin add <包名>@<版本>` 替换当前精确版本；检查 `opencode plugin list`，清理本插件旧的重复/源码入口。`opencode plugin update` 会跳过精确版本，因此升级由你主动决定。若变更未自动加载，再重启 OpenCode。

```sh
opencode plugin remove opencode2-cliproxyapi-provider@0.1.0
```

若项目配置中还手动写了入口，也须移除。卸载插件不保证清除原生凭证、会话或插件存储，应通过 OpenCode 管理这些数据，不要删除其他宿主数据。

## 排错

| 现象 | 检查方向 |
| --- | --- |
| 没有 CPA 命令 | 查看服务端插件列表和精确版本，不要在 `cli.json` 重复配置 |
| key 已保存但未验证/离线 | 用 `/cpa-status` 查看；`/cpa-connect` 验证明确的地址/key 后才保存 |
| 首次无缓存启动失败 | CPA 恢复后用 `/cpa-refresh`；**首次无缓存读取不会自动重试** |
| 待生效或撤回 Fast 后请求被拒绝 | reload location；它会取消暂停请求并重置统计 |
| 请求 WS 却走 HTTP | 查看 `transportNote`；回退成功不证明 WS 成功 |
| native 压缩不可用 | 保留默认 `summary`；native 仅显式开启，未做真实 CPA 验证 |
| `opencode models` 没列出模型 | 2.0.26 的该命令使用自身 location；以会话模型选择器或指定 location 的 `model.list` 为准 |

提 issue 时附宿主/插件版本、操作系统及**脱敏**状态或最小复现。不要发布凭证、私人服务地址、对话内容或原始宿主日志。安全问题见[报告指引](SECURITY.md)。

## 已完成的验证及边界

真实 CPA 基线为 `11eb30e`，宿主 `2.0.26`，只测一个模型 `gpt-6.1-sol`。`16afc4b` 的暂停计时修正只做了离线验证，不代表后来整个构建重新通过真实验收。更广的协议、故障恢复检查使用 mock。CI 会用**虚构凭证**将安装产物加载到真实宿主，但不是全模型、全版本或物理 TUI 认证。

[验证矩阵](docs/verification.md) · [技术参考](docs/reference.md) · [架构决定](docs/adr/0001-native-runtime.md)

## 隔离开发与测试

开发和 CI 不使用你的日常配置或真实 CPA 凭证。`OPENCODE_CLI` 指定真实宿主二进制；`OC2CPA_SANDBOX` 指定隔离的 home/config/data/cache/state 目录；协议测试服务只监听 loopback。

```sh
npm ci --cache .forge/local/npm-cache --no-audit --no-fund
bun test
bun run typecheck
# 先设置 OPENCODE_CLI 为 OpenCode 2.0.26 可执行文件：
bun run smoke:package
```

[开发与冒烟脚本](docs/development.md) · [发布流程](docs/releasing.md) · [变更记录](CHANGELOG.md) · [MIT 许可](LICENSE)
