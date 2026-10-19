# PrivateRadar

PrivateRadar 是一个本地优先、证据优先的个人聊天情报系统。用户主动选择聊天并导入，再通过今日情报、搜索、雷达和承诺审核回看值得注意的原话与依据。

## 当前状态

- 当前本地候选版本为 `0.2.0-alpha.21`，目标标签为 `v0.2.0-alpha.21`。Windows 安装候选已完成 typecheck、1674 / 1674 测试、Build、NSIS 打包和隐私扫描；人工安装、启动、主要页面、基础交互、导入、WorkBuddy 与重启验收均通过。尚未提交、推送或创建该标签，GitHub Release 尚未创建，仓库仍为 Private，alpha.21 尚未正式公开发布。
- 历史完成并封板版本：[v0.2.0-alpha.20](https://github.com/moshangliu12-afk/PrivateRadar/tree/v0.2.0-alpha.20)。Windows 11 x64 的正式部署与验收结论保留，旧 annotated tag 和 Release 的历史身份不变。
- [alpha.20 Pre-release 档案页](https://github.com/moshangliu12-afk/PrivateRadar/releases/tag/v0.2.0-alpha.20)没有上传该版本 Windows 安装器、Skill 或 macOS 资产；当前开发候选不挂到旧 Release。
- Windows 正式导入链：微信 → WorkBuddy → PrivateRadar。macOS 仅提供手动 JSON 导入；PrivateRadar 自己的原生微信分享入口继续延期。

## alpha.21 发行资产计划

| 文件 | 平台与范围 |
|---|---|
| `PrivateRadar-Setup-0.2.0-alpha.21-x64.exe` | Windows x64，unsigned，非 Microsoft Store 分发 |
| `PrivateRadar-0.2.0-alpha.21-macOS-arm64.dmg` | Apple Silicon / arm64 only，unsigned、not notarized、无 Developer ID；不提供 Intel x64 |
| `PrivateRadar-0.2.0-alpha.21-ffmpeg-corresponding-source.tar.xz` | 两平台共用的 FFmpeg 对应源码、许可及包内 provenance |
| `SHA256SUMS.txt` | 后续生成，仅记录以上三个文件的摘要，不记录自身 |

上述四项仍为正式发行资产计划，须从同一个最终候选提交准备并经核验；Windows 本地安装候选已生成并验收，但不是已发布的 GitHub 资产，当前尚无正式公开下载。该本地候选文件为 `PrivateRadar-Setup-0.2.0-alpha.21-x64.exe`，SHA256 为 `abf498dba9e52df69ac64282509ba14eea2df03372e93520eda6ea54756f0c91`；最终公开发行以届时对应 Release 与 `SHA256SUMS.txt` 为准。`.app.zip` 仅用于 CI / 内部验收；外置 provenance manifest 仅为内部材料，不增加第五项资产。GitHub 自动生成的源码 ZIP / tar.gz 不属于手工上传资产，也不能代替 FFmpeg 对应源码包。

Windows 可能出现 SmartScreen / 未知发布者提示；核验来源和摘要后，仅在系统提供选项时选择“更多信息 → 仍要运行”，不关闭 Defender 或系统级安全功能。Mac 文件名不含 `unsigned` 不代表已经签名；普通用户无需 Apple Developer Program。安装与首次启动步骤见 [使用指南](./USER_GUIDE.md)。

## macOS 验收与当前范围

| 验收层次 | 当前状态 |
|---|---|
| Apple Silicon 源码 / 运行时 | `PASS`，Stage2C 自动化与实体 M4 源码验收已完成 |
| alpha.20-derived unsigned arm64 CI 打包 | `PASS`，仅作为已验收参考候选 |
| alpha.20-derived 打包应用核心功能实机验收 | `PASS` |
| alpha.20-derived 实体安装与首次启动 | `PASS_WITH_ISSUE`，首次启动需处理该 App 自身 quarantine |
| alpha.21 新 DMG / CI / 实机结果 | 尚未执行；不得直接沿用参考候选的实机 PASS |
| Developer ID / notarization / stapling | 当前 unsigned 策略不采用，不作为发行 blocker |

此前参考候选已核验 DMG SHA256、安装至 `/Applications`，synthetic JSON 导入、Search、承诺候选、确认、已确认表达、Evidence、退出重启及持久化均通过，无崩溃、无数据丢失。这是 **alpha.20-derived reference runtime acceptance**，不是 alpha.21 DMG 的实机验收。

参考候选首次启动曾提示“PrivateRadar 已损坏，无法打开”。用户核验下载来源和 SHA256 后，仅执行 `xattr -dr com.apple.quarantine "/Applications/PrivateRadar.app"` 移除该 App 自身 quarantine，随后启动成功。具体操作及边界见使用指南；不修改其他 App 或系统级安全策略。

Mac 仅接受 JSON，未接入 Windows WorkBuddy 正式链，也不承诺 CSV / TXT 能力。alpha.21 应先做新旧运行代码与运行库差异核验，再决定是否补做最小实机测试，不无证据继承 PASS。

B0-1 / B0-2 / B0-3 / B0-4 均为 `PASS`，`P0_BINARY_LICENSE_BLOCKER_COUNT = 0`。alpha.21 仍须重新生成统一提交的产物并核验，这不重新打开 B0-4，也不要求 FFmpeg replacement physical smoke test。

仓库保持 Private。GitHub Support #4848368 尚未确认 server-side old-object cleanup 完成，因此 `GITHUB_SUPPORT_PUBLIC_GATE = OPEN`、`OPEN_SOURCE_PUBLICATION_READY = NO`。许可证闭环不代表已经可以公开。

## 当前核心能力

- 今日情报：保守筛选与优先级排序，查看“今天最重要”和原始依据。
- alpha.20 关注词区块：“你关注的关键词今天有新消息”展示用户显式关注信号，独立于“今天最重要”；关键词命中不等于最重要。只消费已有命中，按可靠来源聊天时间判断当前本地日历日期。
- 问我的聊天 / 搜索：FTS5、关键词和日期 / 群 / 人物条件，提供有限证据与上下文；真实语义检索仍不属于当前正式能力。
- 话题雷达：保守话题识别、七天历史基线、值得注意程度与趋势展示，保留来源依据。
- 关键词雷达：用户配置关注词，查看真实来源命中、上下文和附件证据。
- 承诺候选：确定性识别明确承诺表达，由用户确认或忽略。
- 承诺表达（已确认）：只读回看用户已确认的原话；确认表达不代表承诺已履行，也不自动生成任务。
- 上下文与原始证据：关键词和承诺结果绑定来源出现位置，查看对应来源的上下文并打开附件证据。
- Windows 导入：WorkBuddy 单卡与同次双卡走原始上下文链，保留独立附件证据及来源关系；另有 JSON、CSV、TXT 文件导入。macOS 入口仅为手动 JSON。

候选不是事实。来源事实以原始证据和来源出现位置为依据，分析结果不能替代原文；用户确认后形成审核结果，仍能回到原始依据。缺失或不可靠的来源信息保持保守处理，不由规则或模型补造。

无需微信或真实聊天记录也可体验演示模式，包含 4 个模拟群、8 个模拟用户、连续 7 天、1468 条本地消息。

## 源码开发启动

开发环境要求 Node.js 24 或更高版本，使用 npm 和现有锁文件安装。在项目目录打开终端（Windows 可用 PowerShell）：

```powershell
npm ci
npm run dev
```

应用首次启动会创建空数据库。运行数据默认进入 Electron 的用户数据目录，开发环境的显式目录覆盖见隐私说明；开发时可通过 `.env.example` 中的开关注入内置 Demo。

Windows 文件导入的字段和示例见 [IMPORT_FORMATS.md](./IMPORT_FORMATS.md)；Mac 入口只使用其中的 JSON 格式。Windows 正式 WorkBuddy 操作和 Mac 边界见 [使用指南](./USER_GUIDE.md)。开发依赖安装、Electron 安装脚本及换行注意事项见 [贡献指南](./CONTRIBUTING.md)。

## 自检

```powershell
npm test -- --maxWorkers=2 --testTimeout=30000
npm run typecheck
npm run build
```

alpha.21 Windows 本地安装候选已完成构建与人工验收；实体 M4 Mac 源码运行和此前 unsigned 包的实机测试仍仅为参考证据，alpha.21 新 Mac 产物及后续正式发行资产须分别核验。当前锁定 Electron 44.3.0，Electron 二进制安装需要其安装脚本成功执行，排查步骤见贡献指南。源码开发自检不能代替最终安装包验收。

Windows x64 安装器构建命令为 `npm run dist:win`，输出到 `release/`；这是本地构建方式，不代表 GitHub 已提供下载资产。

## 当前目录

```text
PrivateRadar/
├── src/
│   ├── main/        Electron 主进程、SQLite、演示数据
│   ├── preload/     安全的页面调用桥
│   ├── renderer/    React 界面
│   └── shared/      标准消息与共享类型
├── tests/           自动测试
├── PRIVATE_RADAR_REFERENCE_RESEARCH.md
├── DEVELOPMENT_PROGRESS.md
└── package.json
```

## 隐私与安全

- 聊天原文默认只保存在本机。
- 不读取或破解微信数据库，不 Hook 微信，不提取密钥。
- 不提交 API Key、Token、本地数据库或真实聊天导出。
- 可选远程 AI 与独立的 Embedding 服务由用户在本机配置。配置后，启动读取日报、刷新或搜索可能自动发送聊天相关证据，现有实现没有逐次确认门禁；两者均未配置时使用本地规则模式。发送内容、缓存与服务责任边界见 [隐私说明](./PRIVACY.md)。

## AI 开发配置

复制 `.env.example` 中需要的变量到本机环境。可将 `PRIVATE_RADAR_AI_PROVIDER=mock` 和 `PRIVATE_RADAR_EMBEDDING_PROVIDER=mock` 分别用于两个不联网的 Provider；远程服务需要配置 Base URL、Model 和 API Key。任何密钥都不应写入源码、日志或提交到 Git。

## 文档导航

当前入口：[使用指南](./USER_GUIDE.md)、[开发进度](./DEVELOPMENT_PROGRESS.md)、[隐私说明](./PRIVACY.md)、[安全报告](./SECURITY.md)、[贡献指南](./CONTRIBUTING.md)、[第三方许可清单](./THIRD_PARTY_NOTICES.md)。[已知问题与范围](./KNOWN_ISSUES.md) 和 [文件格式](./IMPORT_FORMATS.md) 保留 Windows 封板与专项记录，Mac 当前边界以本页和使用指南为准。当前原始上下文导入技术契约见 [WorkBuddy 模块说明](./src/main/integrations/workbuddy/README.md)。

历史与设计记录：[历史检查点](./docs/PROJECT_CHECKPOINT.md)、[alpha.15 候选发布说明](./ALPHA_RELEASE_NOTES.md)及[历史检查表](./ALPHA_RELEASE_CHECKLIST.md)保留当时状态；D1 / D2 / E1 设计、研究与专项验收数字也是阶段记录，不代表当前待办或最新验收结果。当前版本与下一阶段状态以本页和开发进度顶部为准。

## 许可证

项目自身采用 [Apache-2.0](./LICENSE)。第三方组件保留各自许可证与通知要求。B0-1～4 的设计和参考候选验收已闭环；alpha.21 后续正式发行资产仍须核验许可交付，见 [第三方许可清单](./THIRD_PARTY_NOTICES.md)。FFmpeg 对应源码采用保守超集交付，不承诺按位复现官方二进制。
