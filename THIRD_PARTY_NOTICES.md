# 第三方组件与许可清单

本清单对应 alpha.22 的 `package-lock.json` 与已核验发行包的许可文本，记录主要产品运行组件。版本是当前锁定版本，不代表每个历史安装器的组件身份。项目自身采用 Apache-2.0；第三方组件保留各自许可、版权和通知义务。

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

## 二进制发行核验

Electron 同时包含 Chromium、Node.js 及其他第三方组件，具有各自许可与通知。完整清单应以实际固定版本运行时与最终发行包为准，不能仅凭 npm 的 Electron MIT 字段认定全部组件许可已经交付。

B0-1（Electron / Chromium）、B0-2（MCP / 内嵌依赖）、B0-3（项目 Apache-2.0）及 B0-4（FFmpeg 对应源码）的设计与现有候选验收均已闭环：

```text
B0_1 = PASS
B0_2 = PASS
B0_3 = PASS
B0_4 = PASS
P0_BINARY_LICENSE_BLOCKER_COUNT = 0
```

alpha.22 的 EXE、DMG 与对应源码包统一绑定发行提交 `a4d9174c713341243a00799c3432543aaa4e7747`，实际许可材料已独立核验；历史候选不替代本版产物验收。这不重新打开 B0-4。Windows 和 Mac 均采用 unsigned 策略，Developer ID / notarization 不作为本次发行门槛；替换启动实测仅为可选工程验证，不是 LGPL 许可证发布硬要求。

本文件用于项目级许可说明。Apache `NOTICE` 按实际来源通知义务另行处理，本轮没有创建根目录 NOTICE，也没有生成替代上游原通知的自定义文本。

## FFmpeg 对应源码交付（B0-4）

PrivateRadar 通过 Electron 44.3.0 分发 FFmpeg，当前已核验配置适用 LGPL-2.1-or-later。
PrivateRadar 未修改该动态运行库；Windows 使用 DLL，macOS 使用独立 dylib，均动态链接。实际来源为 Chromium FFmpeg fork 固定提交
`2b68d2babae73714846961fb0ee47e3b3d2e39a9`。

`scripts/prepare-ffmpeg-corresponding-source.py` 按固定来源与摘要准备两平台共用的保守超集：
完整 FFmpeg fork、Electron 补丁、原始参数、生成配置、Chromium Opus、固定 LLVM split 源码及构建上下文。
原许可全文保留，来源与缺失项见生成的 `FFMPEG_SOURCE_PROVENANCE.json`。
官方完整目标图和最终链接收据不可用，本候选不承诺按位重现官方二进制。

App 的 `licenses/FFmpeg-LGPL-NOTICE.txt` 由现有资源规则交付并经许可钩子核验；
独立 Connector 不包含 FFmpeg，因此不添加此通知。
alpha.22 Release 已提供 `PrivateRadar-0.2.0-alpha.22-ffmpeg-corresponding-source.tar.xz`，包含 `FFMPEG_SOURCE_PROVENANCE.json` 与 `ffmpeg/COPYING.LGPLv2.1` 完整正文。该包从干净的固定发行提交 `a4d9174c713341243a00799c3432543aaa4e7747` 生成并验收，SHA256 为 `04e5e073229d47e35ddfcc4eb45e0b3ea73ce5e0ff528559e2766592128c46d1`。外置 manifest 仅作为内部材料，不增加正式资产；生成规则见 [源码交付说明](scripts/ffmpeg-source-delivery/README.md)。历史 alpha.21 对应源码随其独立 Release 保留。

该 Release 的四项手工上传资产为 Windows EXE、Mac arm64 DMG、FFmpeg 源码 tar.xz 与 `SHA256SUMS.txt`；校验文件只记录前三项，不记录自身。CI `.app.zip` 不作为正式资产。

用户修改、替换兼容动态库及调试修改的 LGPL 权利保留；对应源码、许可和必要材料交付义务不减免。
