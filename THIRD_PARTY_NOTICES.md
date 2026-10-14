# 第三方组件与许可清单

本清单对应当前开发候选的 `package-lock.json` 与已安装包许可文本，记录主要产品运行组件。版本是当前锁定版本，不代表每个历史安装器的组件身份。项目自身采用 Apache-2.0；第三方组件保留各自许可、版权和通知义务。

| 组件 | 锁定版本 | 许可证 | 上游 |
|---|---|---|---|
| Electron | 44.3.0 | MIT | [electron/electron](https://github.com/electron/electron)；[固定版本许可](https://github.com/electron/electron/blob/v44.3.0/LICENSE) |
| React | 19.3.0 | MIT | [React](https://react.dev/)；[上游许可](https://github.com/facebook/react/blob/main/LICENSE) |
| React DOM | 19.3.0 | MIT | [React DOM 上游](https://github.com/facebook/react/tree/main/packages/react-dom) |
| scheduler | 0.28.0 | MIT | [scheduler 上游](https://github.com/facebook/react/tree/main/packages/scheduler) |
| zod | 4.6.3 | MIT | [colinhacks/zod](https://github.com/colinhacks/zod)；[上游许可](https://github.com/colinhacks/zod/blob/main/LICENSE) |
| @modelcontextprotocol/core | 2.0.0 | Apache-2.0／MIT 按贡献授权的过渡声明；普通文档 CC-BY-4.0 | [固定 2.0.0 发布包原文](licenses/runtime/MCP-SDK-LICENSE.txt) |
| @modelcontextprotocol/server | 2.0.0 | Apache-2.0／MIT 按贡献授权的过渡声明；普通文档 CC-BY-4.0 | [固定 2.0.0 发布包原文](licenses/runtime/MCP-SDK-LICENSE.txt) |

当前锁文件的六个生产 npm 包对应上表除 Electron 外的六项。SDK 发布包还内嵌了其他组件，六个包名不代表完整分发清单。React / React DOM / scheduler 用于界面，zod 与 MCP SDK 用于校验及 Connector。MCP 分类以发布包实际 LICENSE 为准，保留完整过渡说明、Apache 与 MIT 正文。普通文档的 CC-BY-4.0 说明不证明对应文档进入二进制。构建工具也不因出现在锁文件里就成为已确认的产品分发组件。

## MCP 内嵌材料与独立 Connector

[固定版本清单及离线原文](licenses/runtime/README.txt)覆盖 B0-2 的 11 个组件，逐项记录版本、版权、来源身份、摘要和分发范围。

| SDK 内嵌组件 | 固定版本 | 原文许可 | 实际材料 |
|---|---|---|---|
| content-type | 1.0.5 | MIT | SDK 与 Connector 运行代码 |
| @cfworker/json-schema | 4.1.1 | MIT | SDK 随包运行模块；当前 Connector 未内嵌该 provider |
| ajv | 8.18.0 | MIT | SDK 与 Connector 运行代码 |
| ajv-formats | 3.0.1 | MIT | SDK 与 Connector 运行代码 |
| fast-deep-equal | 3.1.3 | MIT | SDK 与 Connector 运行代码 |
| fast-uri | 3.1.0 | BSD-3-Clause | SDK 与 Connector 运行代码 |
| json-schema-traverse | 1.0.0 | MIT | SDK 与 Connector 运行代码 |
| json-schema-typed | 8.0.2 | BSD-2-Clause | SDK 随附类型及源码映射资料，不计作运行库 |

`@cfworker/json-schema` 的固定 npm 包缺少 LICENSE；本清单保存已核验的上游提交 `5409fdc2bd144f68e8b28c61c71fcb16600000a6` 原文，构建时不联网读取许可证。全部作者版权及条款保留原样。

应用的交付目标为 Windows `resources/licenses/` 和 Mac `PrivateRadar.app/Contents/Resources/licenses/`。Mac 的 B0-1 `Electron-LICENSE.txt`、`Electron-LICENSES.chromium.html` 保留独立文件名，与本目录材料共存。

独立 Connector 的 [licenses 目录](integrations/workbuddy/connector/licenses/README.txt)由同一 canonical source 确定性生成，包含当前实际内嵌的 MCP、zod 及相关依赖共 9 个运行组件。每次 `build:mcp` 都同步原文、校验摘要，并用本次构建输入检查分发范围；独立复制 Connector 时，该目录应一并保留。它不依赖主应用的另一个许可目录。

## 二进制发行的后续核验

Electron 同时包含 Chromium、Node.js 及其他第三方组件，具有各自许可与通知。完整清单应以实际固定版本运行时与最终发行包为准，不能仅凭 npm 的 Electron MIT 字段认定全部组件许可已经交付。

后续二进制发行前，仍应核验新 `.app` / DMG / 安装器内的实际材料。B0-2 的本地复制规则与清单不能替代最终二进制验收；项目自身 Apache-2.0 原文的二进制交付（B0-3）及 FFmpeg 构建与对应源码交付（B0-4）仍开放。

当前基础组件清单已建立，二进制第三方归属最终核验未完成：

```text
BINARY_DISTRIBUTION_ATTRIBUTION_FOLLOWUP_REQUIRED = YES
```

本文件用于项目级许可说明。Apache `NOTICE` 按实际来源通知义务另行处理，本轮没有创建根目录 NOTICE，也没有生成替代上游原通知的自定义文本。
