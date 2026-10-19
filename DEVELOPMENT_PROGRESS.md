# PrivateRadar 开发进度

## 当前项目状态

当前版本为 `0.2.0-alpha.21`，[v0.2.0-alpha.21 Pre-release](https://github.com/moshangliu12-afk/PrivateRadar/releases/tag/v0.2.0-alpha.21) 已提供 Windows x64、macOS Apple Silicon arm64 安装资产、FFmpeg 对应源码和 `SHA256SUMS.txt`。Windows 安装器已完成 typecheck、1674 / 1674 测试、Build、NSIS 打包、人工安装及主要功能验收，隐私扫描通过；macOS CI 打包与 DMG 检查通过，尚无 alpha.21 实体 Mac 人工运行验收记录。EXE、DMG 与对应源码包均绑定发行提交 `6f04bb6f8ecf4c0bfaf4c622f4191f73c759d866`；旧 alpha.20-derived 资产仅作参考。

截至 2026-10-14，Windows 11 x64 的 `0.2.0-alpha.20` 已完成正式部署、验收与封板；GitHub 已建立 [alpha.20 Pre-release](https://github.com/moshangliu12-afk/PrivateRadar/releases/tag/v0.2.0-alpha.20)。该页面没有上传 Windows 安装器、Skill 或 macOS 资产。

历史 alpha.20 封板源码身份以现有 [v0.2.0-alpha.20 annotated tag](https://github.com/moshangliu12-afk/PrivateRadar/tree/v0.2.0-alpha.20) 为准。隐私清理后的 Git 身份已更新，历史阶段的旧提交不作为当前公开源码身份。alpha.21 发行源码已合入 master，`v0.2.0-alpha.21` 固定指向发行提交 `6f04bb6f8ecf4c0bfaf4c622f4191f73c759d866`；后续文档收尾不改变发行安装资产及标签身份。

| 已完成 Windows 版本 | 高层摘要 |
|---|---|
| alpha.18 | 承诺候选、确认 / 忽略审核、来源上下文与 Evidence；单卡与双卡使用原始上下文来源链 |
| alpha.19 | 承诺表达（已确认），只读回看用户确认的原话及来源 |
| alpha.20 | 今日情报关注词区块，用户显式关注信号独立于“今天最重要” |

Windows 正式导入链为微信 → WorkBuddy → PrivateRadar；原生微信分享入口继续延期。alpha.21 不改变功能、schema、依赖或 Skill。

## macOS 开发阶段

| 阶段 | 当前状态 |
|---|---|
| Stage2C-A / B：Apple Silicon 自动化与实体 M4 源码运行 | `PASS` |
| alpha.20-derived unsigned arm64 CI 打包 | `PASS`，参考候选 |
| alpha.20-derived 打包应用核心功能实机验收 | `PASS`，无崩溃、无数据丢失 |
| 参考包安装与首次启动 | `PASS_WITH_ISSUE`，需处理单个 App 自身 quarantine |
| alpha.21 新 macOS 产物 | `PASS`，arm64 未签名 DMG 的 CI 打包与包检查通过，已提供 Release 资产；尚无实体 Mac 人工运行验收记录 |
| Developer ID / notarization / stapling | 当前 unsigned 策略不采用，不作为发行 blocker |

此前 Stage3C 签名配置实施记录属于历史工程材料，不作为当前用户安装或许可证发布要求。此前包的 DMG integrity、安装至 `/Applications`、synthetic JSON 导入、Search、承诺候选、确认、已确认表达、Evidence、重启及持久化均通过。这是 alpha.20-derived reference runtime acceptance，不是 alpha.21 DMG 已通过实机验收。

Mac 当前入口仅为手动 JSON，不提供 Intel x64，也不接入 Windows WorkBuddy 正式链或承诺 CSV / TXT。首次“PrivateRadar 已损坏，无法打开”及核验来源、SHA256 后仅对自身 App 移除 quarantine 的实际流程见 [使用指南](USER_GUIDE.md)。

## 开源准备

发行源码中的遗留真实搜索案例已替换为合成数据；项目自身已采用 Apache-2.0，npm 的 `private: true` 保留。隐私、安全、贡献、第三方基础许可说明与仓库 metadata 已整理。

B0-1 / B0-2 / B0-3 / B0-4 均为 `PASS`，`P0_BINARY_LICENSE_BLOCKER_COUNT = 0`。alpha.21 安装资产与对应源码已从统一发行提交生成并核验，不重开 B0-4；不要求 replacement physical smoke test。Release 已提供四项正式资产，`SHA256SUMS.txt` 只覆盖 Windows、macOS 和对应源码三项，详见 README。

当前使用与平台边界见 [README](README.md)、[使用指南](USER_GUIDE.md)；隐私、安全、贡献与许可说明见根目录对应文档。下方早期日志只说明当时阶段，保留历史验证事实，不作当前实施授权或下一阶段计划。

## 早期开发日志（历史记录）

以下原样保留早期开发日志。其中的“当前”“下一步”“未开始”和测试数字只描述当时阶段，不作为 alpha.20 当前状态或下一阶段计划。

最后更新：2026-09-12

## 当前里程碑

PrivateRadar V0.1 三个核心需求均已完成，本轮进入整体 V0.1 验收，不再增加新产品功能。

### V0.1 核心功能状态

- 今日情报：已完成。包含 D1 本地候选筛选、D2 可选 AI 整理、规则降级、缓存和来源追溯。
- 跨群话题雷达：已完成。包含保守话题识别、7 天历史基线、Signal Score、趋势展示和来源追溯。
- 问我的聊天：已完成。包含 FTS5、日期/群/人物过滤、可选 Embedding、证据回答和上下文查看。
- 当前阶段：V0.1 整体验收。

| 阶段 | 状态 | 说明 |
|---|---|---|
| A 参考项目研究 | 已完成 | 三个指定仓库、许可证和 WorkBuddy 官方资料已核对 |
| B 项目骨架 | 已完成最小版本 | Electron、React、TypeScript、SQLite、演示模式可启动 |
| C 文件导入 | 已完成 | JSON、CSV、TXT、标准化、指纹去重、增量记录和容错导入均已验证 |
| D1 今日情报候选 | 已完成 | 规则清洗、噪音过滤、保守归并、独立评分、持久化和证据上下文均已验证 |
| D2 今日情报增强 | 已完成 | Provider 抽象、严格 JSON、来源保护、缓存与规则降级均已验证 |
| E1 话题雷达基础 | 已完成 | 保守话题识别、7 天基线、Signal Score、持久化、趋势和证据均已验证 |
| E2 话题雷达增强 | 未开始 | 本轮不扩展语义模型或更长历史能力 |
| F 问我的聊天 | 已完成 | 查询理解、FTS5、结构化过滤、可选 Embedding、证据回答和上下文均已验证 |
| G WorkBuddy 验证 | 未开始 | 已完成文档事实核查，状态为 `NEEDS_PLATFORM_VALIDATION` |

## 已完成内容

- 初始化独立 Git 仓库，未接触 HotRadar。
- 建立 Electron 主进程、隔离的预加载桥和 React 渲染进程。
- SQLite 使用 WAL、外键、常用索引和 FTS5。
- 建立标准消息类型及任务书要求的核心表。
- 演示数据包含 4 个群、8 个用户、7 天、1468 条消息，并加入语义改写召回场景。
- 演示数据重复写入可安全忽略。
- `.gitignore` 已排除数据库、密钥、环境文件、日志和私人导入导出。
- 自动测试覆盖演示数据规模、种子幂等与 FTS5 基础检索。
- 增加统一文件 Adapter、逐条标准化和稳定消息指纹。
- 增加导入文件选择、结果统计和错误详情界面。
- 三种演示文件依次导入结果为：JSON 新增 5；CSV 新增 3、重复 2；TXT 新增 3、重复 2。
- 新增独立的 `intelligence/daily/` 候选流水线，页面不计算分数。
- 首页已移除硬编码占位数据，显示规则计算出的真实候选、分数和原因。
- 候选与来源消息使用关系表持久化，可查看每条原文及同群前后各两条上下文。
- E1 增强前的 Demo 当日 184 条消息曾生成 13 个 D1 候选；加入 E1 场景后，当日 319 条消息生成 18 个 D1 候选。
- 增加 `AIProvider`、`MockAIProvider` 和 `OpenAICompatibleProvider`，业务层不绑定模型 SDK。
- D2 最多接收 30 个 D1 候选，每个候选最多发送 4 条多样化证据，最终页面最多显示 10 条。
- AI 结果经过严格结构校验，来源编号和 D1 排名都由程序强制恢复。
- 同日、同 Provider、同模型、同候选集合使用 SQLite 缓存；请求失败自动显示规则结果。
- 新增独立 `intelligence/topics/` 流水线，复用 D1 清洗、实体、URL 和文本相似度能力。
- Topic 每日指标、历史基线、趋势、原因码和完整来源关系已持久化。
- Demo 中 NovaFlow 低基数跨群暴涨排名第一；单群 70 条 BuzzBoard 被压制到第 7；长期稳定 StackTalk 排名第 8。
- 启用正式“问我的聊天”页面，查找类展示原文，观点类基于最多 40 条证据复用 D2 AIProvider。
- 新增 EmbeddingProvider、MockEmbeddingProvider 和 OpenAICompatibleEmbeddingProvider；无配置或失败时自动退化为 FTS5。
- 原始问题和回答正文不写入长期数据库，AI 来源编号始终由程序生成。

## 重要决策

1. 全项目只使用 TypeScript，暂不引入 Python。
2. 以 Electron 主进程作为本地服务边界，不额外运行 HTTP 后端。
3. 使用 Electron 内置 Node.js 的原生 SQLite 接口，避免 `better-sqlite3` 二进制与 Electron 版本不匹配，也不要求小白安装 Visual Studio C++ 编译工具。
4. SQLite 文件默认放在 Electron 用户数据目录，不放在代码仓库。
5. 本阶段不复制参考仓库源代码，避免不必要的版权与维护耦合。
6. WorkBuddy 仅作为实验 Adapter，永不成为核心运行前置条件。

## 下一步

明天继续 V0.1 整体验收，不增加新产品功能。待办如下：

1. 按真实用户路径验收文件导入、今日情报、话题雷达和“问我的聊天”的完整操作流程。
2. 使用小规模脱敏聊天样本复核日期、群名、发送人、重复导入和证据上下文是否正确。
3. 分别验收无 Provider、Mock Provider 和实际兼容 Provider 下的降级与错误提示。
4. 核对应用重启后的数据库、候选、Topic、AI 缓存和消息向量是否保持一致。
5. 汇总验收问题，按严重程度区分必须修复、可延后和 V0.2 候选；验收结束前不扩展功能范围。

## 当前已知问题

- Node.js 原生 SQLite 仍会输出实验性功能警告，但当前测试和 Electron 运行不受影响。
- D1 中文同义归并仍以规则和浅层文本相似度为主，同一产品的复杂子事件可能拆分不足或过度归并。
- D2 尚未使用真实线上 API Key 做跨 Provider 兼容性验收；部分兼容服务可能不支持结构化输出参数。
- 话题雷达只有 7 天基线，暂不处理工作日周期、节假日、季节性和更长历史趋势。
- Topic 实体别名仍依赖规则配置，未登记的新中文产品名可能被拆成多个话题。
- 中文 FTS5 分词能力有限，目前由关键词包含匹配和可选 Embedding 补充。
- Embedding 采用最多 120 条初筛候选的线性重排，数据规模显著增大后需要重新评估性能和召回率。
- 查询理解为确定性规则，复杂否定、模糊人物称呼和多重条件可能解析不完整。
- 观点回答最多使用 40 条证据，只代表本次检索结果，不能视为全部聊天的完整统计结论。
- Mock AI 和 Mock Embedding 仅用于验证产品链路，真实模型的质量、费用、超时和隐私提示仍需在验收阶段确认。

## 本阶段验证记录

- `npm test`：通过，6 个测试文件、64 个测试全部成功，包含“问我的聊天”要求的 15 类专项用例及最早提及排序测试。
- `npm run typecheck`：通过。
- `npm run build`：通过，主进程、预加载桥和 React 页面均生成构建产物。
- `npm audit --audit-level=moderate`：通过，0 个已知漏洞。
- `npm run preview`：Windows 桌面进程成功启动，无运行时错误。
- 运行数据库核验：1468 条消息、4 个群、8 个用户、7 天，当日 319 条；五个指定 Demo 问题均得到符合预期的检索或拒答结果。
