# PrivateRadar

PrivateRadar 是一个本地优先、证据优先的个人聊天情报系统。用户主动选择聊天并导入，再通过今日情报、搜索、雷达和承诺审核回看值得注意的原话与依据。

## 当前状态

- 最新完成并封板版本：[v0.2.0-alpha.20](https://github.com/moshangliu12-afk/PrivateRadar/tree/v0.2.0-alpha.20)，开发、隔离验收、正式部署与 GitHub 归档均已完成。
- Windows 11 x64 的 alpha.20 已完成正式部署、验收与封板。Apple Silicon Mac 已通过源码 / 运行时验收和未签名打包 CI，正式 macOS 发行尚未就绪，详见下表；alpha.21 尚未启动。
- Windows 正式导入链：微信 → WorkBuddy → PrivateRadar。macOS 当前仅提供手动 JSON 导入；PrivateRadar 自己的原生微信分享入口已延期。
- GitHub 已建立 [alpha.20 Pre-release 档案页](https://github.com/moshangliu12-afk/PrivateRadar/releases/tag/v0.2.0-alpha.20)，并继续保留源码与 annotated tag 封板记录；当前 Release 未上传 Windows 安装器、Skill 或 macOS 资产。历史 Release 中的旧安装包不代表当前封板版本。

## macOS 开发候选

| 验收层次 | 当前状态 |
|---|---|
| Apple Silicon 源码 / 运行时 | `PASS`，Stage2C 自动化与实体 M4 源码窗口验收已完成 |
| unsigned arm64 `.app` / DMG 的 CI 打包 | `PASS`，Stage3A 已完成 |
| 打包应用的实体安装与产品验收 | `NOT_RUN / BLOCKED`，Stage3B 延期 |
| Developer ID 签名 | `NOT_EXECUTED` |
| notarization / stapling | `NOT_EXECUTED` |
| Stage3C 签名 / 公证配置 | `PASS_WITH_ISSUE`，配置实施与本地检查完成，未实际执行签名工作流 |
| 真实 Apple 凭据 | `NOT_VERIFIED` |
| 正式 macOS 发行 | `NOT_READY` |

Mac 源码验收覆盖手动 JSON 导入、搜索、关键词、承诺审核、同来源上下文、Finder 打开证据与重启持久化。当前 Mac 入口仅接受 JSON，未接入 Windows WorkBuddy 正式链，也没有已验收的 CSV / TXT 导入或正式安装器。实体打包应用验收、签名与公证仍待完成。

仓库仍保持 Private；GitHub Support 敏感数据清理与公开前仓库设置尚未完成。

## 当前核心能力

- 今日情报：保守筛选与优先级排序，查看“今天最重要”和原始依据。
- alpha.20 关注词区块：“你关注的关键词今天有新消息”展示用户显式关注信号，独立于“今天最重要”；关键词命中不等于最重要。只消费已有命中，按可靠来源聊天时间判断当前本地日历日期。
- 问我的聊天 / 搜索：FTS5、关键词和日期 / 群 / 人物条件，提供有限证据与上下文；真实语义检索仍不属于当前正式能力。
- 话题雷达：保守话题识别、七天历史基线、值得注意程度与趋势展示，保留来源依据。
- 关键词雷达：用户配置关注词，查看真实来源命中、上下文和附件证据。
- 承诺候选：确定性识别明确承诺表达，由用户确认或忽略。
- 承诺表达（已确认）：只读回看用户已确认的原话；确认表达不代表承诺已履行，也不自动生成任务。
- 上下文与原始证据：关键词和承诺结果绑定来源出现位置，查看对应来源的上下文并打开附件证据。
- Windows 导入：WorkBuddy 单卡与同次双卡走原始上下文链，保留独立附件证据及来源关系；另有 JSON、CSV、TXT 文件导入。macOS 开发入口仅为手动 JSON。

候选不是事实。来源事实以原始证据和来源出现位置为依据，分析结果不能替代原文；用户确认后形成审核结果，仍能回到原始依据。缺失或不可靠的来源信息保持保守处理，不由规则或模型补造。

无需微信或真实聊天记录也可体验演示模式，包含 4 个模拟群、8 个模拟用户、连续 7 天、1468 条本地消息。

## 启动

开发环境要求 Node.js 24 或更高版本，使用 npm 和现有锁文件安装。在项目目录打开终端（Windows 可用 PowerShell）：

```powershell
npm ci
npm run dev
```

应用首次启动会创建空数据库。运行数据默认进入 Electron 的用户数据目录，开发环境的显式目录覆盖见隐私说明；开发时可通过 `.env.example` 中的开关注入内置 Demo。

Windows 文件导入的字段和示例见 [IMPORT_FORMATS.md](./IMPORT_FORMATS.md)；Mac 开发入口只使用其中的 JSON 格式。Windows 正式 WorkBuddy 操作和 Mac 边界见 [使用指南](./USER_GUIDE.md)。开发依赖安装、Electron 安装脚本及换行注意事项见 [贡献指南](./CONTRIBUTING.md)。

## 自检

```powershell
npm test -- --maxWorkers=2 --testTimeout=30000
npm run typecheck
npm run build
```

已验证环境包括 Windows 11 x64，以及实体 M4 Mac 的源码运行；当前锁定 Electron 44.3.0。Electron 的二进制安装需要其安装脚本成功执行并完成下载，排查步骤见贡献指南。未签名 Mac 打包产物仍用于内部验收。

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

项目自身采用 [Apache-2.0](./LICENSE)。第三方组件保留各自许可证与通知要求，二进制发行归属核验仍待完成，见第三方许可清单。
