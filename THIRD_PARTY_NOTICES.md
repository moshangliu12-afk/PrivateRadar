# 第三方组件与许可清单

本清单对应当前开发候选的 `package-lock.json` 与已安装包许可文本，记录主要产品运行组件。版本是当前锁定版本，不代表每个历史安装器的组件身份。项目自身采用 Apache-2.0；第三方组件保留各自许可、版权和通知义务。

| 组件 | 锁定版本 | 许可证 | 上游 |
|---|---|---|---|
| Electron | 44.3.0 | MIT | [electron/electron](https://github.com/electron/electron)；[固定版本许可](https://github.com/electron/electron/blob/v44.3.0/LICENSE) |
| React | 19.3.0 | MIT | [React](https://react.dev/)；[上游许可](https://github.com/facebook/react/blob/main/LICENSE) |
| React DOM | 19.3.0 | MIT | [React DOM 上游](https://github.com/facebook/react/tree/main/packages/react-dom) |
| scheduler | 0.28.0 | MIT | [scheduler 上游](https://github.com/facebook/react/tree/main/packages/scheduler) |
| zod | 4.6.3 | MIT | [colinhacks/zod](https://github.com/colinhacks/zod)；[上游许可](https://github.com/colinhacks/zod/blob/main/LICENSE) |
| @modelcontextprotocol/core | 2.0.0 | MIT | [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)；[上游许可](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) |
| @modelcontextprotocol/server | 2.0.0 | MIT | [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)；[上游许可](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) |

当前锁文件的六个生产依赖（含传递依赖）就是上表除 Electron 外的六项；Electron 提供桌面运行时。React / React DOM / scheduler 用于界面，zod 与 MCP SDK 用于校验及 Connector。随包 MIT 原文已逐项核验，实际再分发时应保留原版权与许可通知。构建工具属于开发依赖，不因出现在锁文件里就成为已确认的产品分发组件。

## 二进制发行的后续核验

Electron 同时包含 Chromium、Node.js 及其他第三方组件，具有各自许可与通知。完整清单应以实际固定版本运行时与最终发行包为准，不能仅凭 npm 的 Electron MIT 字段认定全部组件许可已经交付。

后续二进制发行前，需要核验 Electron 原许可、Chromium 的完整第三方通知、随包 Node.js 等组件通知，以及应用和独立 MCP Connector 中生产依赖的许可保留情况。应同时检查 `.app` / 安装器的最终实际内容；只在源码仓库放置本清单不能证明发行包通知齐全。

当前基础组件清单已建立，二进制第三方归属最终核验未完成：

```text
BINARY_DISTRIBUTION_ATTRIBUTION_FOLLOWUP_REQUIRED = YES
```

本文件用于项目级许可说明。Apache `NOTICE` 按实际来源通知义务另行处理，本轮没有创建根目录 NOTICE，也没有生成替代上游原通知的自定义文本。
