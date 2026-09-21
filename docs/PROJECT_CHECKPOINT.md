# PrivateRadar 项目交接检查点

## 冻结状态

- 当前版本：`0.2.0-alpha.12`
- 状态：**最终冻结**。除非有明确的新版本任务，不再修改 alpha.12。
- 目标平台：Windows 11 x64；Electron 桌面应用。
- 产品定位：本地优先的个人聊天情报系统。把用户主动导入的聊天记录保存在本机，提供今日情报、跨群话题雷达和“问我的聊天”。
- 正式安装包：`release/PrivateRadar-Setup-0.2.0-alpha.12-x64.exe`。

## 当前架构

```text
导入文件 / WorkBuddy 官方 MCP
  → Standard Message 标准化、provenance、稳定身份与去重
  → 本地 SQLite + FTS5
  → Daily / Topic / Search 三条独立读取链
  → Electron 主进程 IPC
  → React 渲染层
  → 本地用户反馈（不自动学习、不上传）
```

- 主进程：`src/main/`，负责 SQLite、导入、算法、MCP、IPC。
- 渲染层：`src/renderer/src/`，只展示数据并调用预加载 API。
- 预加载层：`src/preload/index.ts`；新增 IPC 时必须同步 `src/renderer/src/global.d.ts`。
- 核心模型：`src/shared/models.ts`。
- 默认 Local First：聊天正文、设置、缓存、反馈均留在用户电脑；没有默认网络上传或遥测。

## 产品能力状态

### 导入与消息治理

- JSON / CSV / TXT 文件导入稳定可用，全部先转换为 Standard Message；不得让原始格式直接进入分析层。
- WorkBuddy 正式入口是官方本地 stdio MCP Connector：
  - Connector ID：`privateradar-workbuddy`
  - Tool：`privateradar_ingest_messages`
  - 不使用旧 `privateradar-local-spike`，不使用 Harness、直接 JSON-RPC 或脚本兜底。
- WorkBuddy 支持快速导入：只确认群名；发送人、逐条时间缺失时保持 `null + unknown`，不补造。
- 完整导入可记录群名、用户补充的大致日期、可用发送人映射；`approximate_date` 和 `imported_at` **绝不能**写入消息 `timestamp`。
- 字段来源优先级：`source_native > user_supplied > inferred > unknown`。低可信来源不能覆盖高可信来源。
- 稳定身份与 fingerprint 已分离：
  - 有 `source_message_id`：优先 `platform + source_message_id`。
  - 无来源 ID：使用 `platform + source_batch_id + source_position + normalized content`。
  - 后续补群名、发送人或时间必须更新原消息，不得新增重复消息。
- unknown sender 仅可作为内部占位，不得计入真人、独立发送人或“来自 1 人”。

### 今日情报（Daily）

- D1 先做低信息过滤、候选归并与信息信号评分，门槛仍为 `3.2`，不得因单条普通聊天降低全局门槛。
- 媒体/附件纯占位、文件扩展名伪产品、文件名日期数字等 alpha.5 已修复；原消息仍保留并可搜索，但不得独立进入 D1。
- 当前 D1 算法版本：`daily-candidate-v1.3-action-signals`；D1 candidate eligibility、特征或评分语义变化时必须同步更新版本，使旧历史候选自然失效并按正常链路重算。
- alpha.10 使用共享确定性 signal analyzer 识别 `ACTION_REQUIRED`、`DEADLINE / TIME_SENSITIVE`、`CONSEQUENCE`、`VERIFIABLE_CHANGE`、`FAILURE / LOSS` 与 `RISK / LIMITATION`；不按群类型判断价值，也不让 AI 新增候选。
- Daily Value 层版本：`daily-value-v2`：
  - `MUST_SHOW` / `MAY_SHOW` / `DROP`
  - 优先级：`HIGH` / `MEDIUM` / `LOW`
  - 最终排序：`Daily Value → Priority → D1 importance_score`。
- 普通明确能力、配置或模型变化为 `MAY_SHOW / MEDIUM`；行动 + 截止 + 后果为 `MUST_SHOW / HIGH`；单条失败 + 明确损失为 `MAY_SHOW / LOW`；明确风险/限制默认 `MAY_SHOW / LOW`，仅有更强证据时才提升。
- Final Daily 允许为 0，禁止为了凑数量展示低价值候选。
- 典型冻结行为：消防安全通知可因风险与行动要求成为高优先级；裸链接、只有问题、opaque token、普通闲聊应被 Daily Value 挡出。
- 首页不展示“D1 候选”或 “D1 xx.xx 分”；“查看依据”展示中文化的今日价值、优先级、信息信号分和判断依据。
- alpha.11 仅增加 Daily 历史日期浏览：默认仍显示数据库中最新有消息的本地日期；Renderer 保存 `selectedDate` 与 `latestDate`，支持上一自然日、下一自然日和“回到最新”。
- 历史 Summary 使用可选且严格校验的 `YYYY-MM-DD` 参数贯通 Renderer → preload → IPC → main；无日期继续使用单值 `DashboardSummaryCache`，明确历史日期绕过该缓存。
- 日期导航按本地日历字段计算，不依赖 `toISOString()` 或 UTC 24 小时毫秒加减；无消息显示“当天没有聊天记录”，有消息但 Final Daily 为 0 显示“当天没有值得关注的情报”，统计卡统一使用“当日”语义。

### 问我的聊天（Search）

- alpha.7 已升级为确定性 Query Understanding V2 + 多路召回 + 基于证据的规则回答。
- 主要模块：
  - `src/main/retrieval/query-understanding.ts`
  - `src/main/retrieval/hybrid-search.ts`
  - `src/main/retrieval/service.ts`
- 支持弱化中文问句外壳、抽取主题/事件/时间/人物意图，做小规模事件与主题扩展，再结合 FTS、`includes`、实体与结构化过滤排序。
- “最近”查询：有原始时间的消息可验证时间范围；无原始时间但相关的消息可单列展示，必须说明无法确认发生时间；不得使用 `imported_at` 伪造聊天时间。
- “谁”查询：sender 缺失不能阻断主题召回；应说明发送者未提供。
- 无证据时必须回答“没有找到足够相关的聊天记录。”，不得补充外部常识。
- 可选 AI / Embedding Provider 的抽象仍存在，但默认未配置；当前 Search 不依赖真实 Embedding 或中文 FTS schema 迁移。
- alpha.8 修复：任何已完成 Search response 都显示反馈区；不能因关键词检索 `answer = null` 而隐藏反馈。

### 话题雷达（Topic Radar）

- 读取既有 messages / D1 实体能力，用 7 天历史基线计算 Topic 与 Signal Score。
- Topic、历史基线和 Signal Score 均在 `src/main/intelligence/topics/`。
- 缺少 conversation 不得伪装成跨群；缺少 sender 不得计入独立人数；缺少逐条 timestamp 不得进入精确趋势/历史基线。
- 当前数据源经常缺原始时间与发送人，因此 Topic 的多人和趋势能力会按规则降级；这是数据完整度限制，不是应靠假值修复的问题。

### WorkBuddy / MCP

- 正式 Connector 包：`integrations/workbuddy/connector/`；运行时代码：`src/main/integrations/workbuddy/`。
- WorkBuddy GUI → 正式 Connector → `privateradar_ingest_messages` → 正式 SQLite 的端到端链路已真实验收通过。
- WorkBuddy Skill：`privateradar-ingest-chat 0.2.0-alpha.4-skill.2`，保持不变。
- Connector ID 与 Tool 名不得无理由变更，否则 WorkBuddy 会要求用户重新信任。
- WorkBuddy 首次 Skill/模型响应耗时属于平台侧；不要为了优化该等待时间改 SQLite、FTS 或 Connector 协议。

### alpha.8 本地反馈闭环

- Daily 卡片：`有用` / `不该出现`；后者可选原因与备注。
- Daily 页底部：`今天有重要内容被漏掉了吗？`，记录 `MISSING_IMPORTANT` 备注。
- Search：已完成任意检索后显示 `这个结果找对了吗？`、`找对了`、`没找对`；关键词检索同样必须显示。
- 同一 Daily target 或相同 Search query + evidence 集合使用 `feedback_key` upsert，最新状态有效，旧状态不应在 UI 叠加为多个有效标签。
- 设置页可由用户主动“导出测试反馈”。导出只包含反馈条目及关联的最小消息片段/证据，不导出整个聊天数据库；无自动上传、无网络请求。
- 用户反馈仅用于未来人工分析和标注，**绝不在 alpha.8 自动改权重、排序、扩展词、Embedding 或模型**。

## alpha.9 Search 空白归一化修复与安装验收

- alpha.9 只修复 Search 中文本空白不一致导致的漏召回：Query 已归一化空白，但 hybrid-search 对原始正文直接 `includes`，双空格、多空格、换行或制表符会使 lexical / expansion 失配，即使 FTS 已命中仍可能被后续硬筛选淘汰。
- 修复将 Search 比较文本统一为 Unicode NFKC、连续空白折叠、trim 与 lowercase；未改变 Search V2 权重、阈值、实体、时间或排序逻辑。
- 未修改 D1、Daily Value、Topic、WorkBuddy Connector、MCP 协议、SQLite schema、identity / fingerprint 或去重规则。
- Windows 真实升级安装验收通过：既有 146 条消息、12 批导入和本地数据库保留；WorkBuddy 已连接；`圆点贴纸` 双空格历史消息无需重新导入即可命中 1 条并展示证据和 Search 反馈；普通关键词正常命中，不存在关键词保持 0；Daily、Topic 与 Settings 正常。（本条查询文本为本次隐私修订从零构造的合成等价展示；保留原始验收事实及计数，不宣称原始数据为合成数据。）
- 最新安装包：`release/PrivateRadar-Setup-0.2.0-alpha.9-x64.exe`（116,724,220 字节，2026-09-19 20:49:58）。
- alpha.9 是新的最终冻结基线。

## alpha.10 Daily 行动价值识别、历史候选失效与安装验收

- alpha.10 只改进 Daily 对行动、截止、后果、可核对变化、失败损失与风险限制的确定性识别；`minimumScore` 仍为 `3.2`，没有降低。
- 未修改 Search、Topic、WorkBuddy / MCP、SQLite schema、原始消息、FTS、identity / fingerprint、去重或反馈结构。
- `DAILY_VALUE_VERSION` 为 `daily-value-v2`，只负责 Value / Brief 缓存；`DAILY_ALGORITHM_VERSION` 为 `daily-candidate-v1.3-action-signals`，使旧 `v1.2` 历史 D1 candidate 自然失效并重新计算。
- 隔离副本持久化重算：2026-09-19 为 D1 `4`、Final `2`（社保认证 `MUST_SHOW / HIGH`、周六安全提醒 `MAY_SHOW / MEDIUM`）；2026-09-20 为 D1 `5`、Final `4`（模型替换、聊天转入工具为 `MAY_SHOW / MEDIUM`；失效风险、生成失败积分损失为 `MAY_SHOW / LOW`）。
- Windows 真实覆盖安装验收通过：167 条消息、14 个聊天批次和 167 条 FTS 保留；WorkBuddy、Topic、Search、Daily / Search 反馈正常；`圆点贴纸` 与“纸鲸调色”正常命中，不存在词保持 0，未发现普通闲聊明显误入 Daily。（本条查询文本为本次隐私修订从零构造的合成等价展示；保留原始验收事实及计数，不宣称原始数据为合成数据。）
- 最新安装包：`release/PrivateRadar-Setup-0.2.0-alpha.10-x64.exe`（116,725,107 字节，2026-09-21 16:00:04）。
- alpha.10 是新的最终冻结基线。

## alpha.11 Daily 历史浏览与安装验收

- alpha.11 只实现 Daily 历史日期浏览，未修改 SQLite schema、Daily signals、D1 score、`minimumScore = 3.2`、`daily-candidate-v1.3-action-signals`、`daily-value-v2`、Search、Topic、WorkBuddy、MCP、identity / dedup、FTS 或原始 messages。
- 默认 Daily 继续打开数据库中最新有消息的日期，而不是系统日历今天；最新日期禁用“下一天”，“回到最新”仅在历史日期显示。
- 历史日期通过可选 `date?: YYYY-MM-DD` 请求 Summary；日期必须为真实本地日历日期。无参数保持 latest 单值缓存行为，明确历史日期直接读取/生成对应 Summary，避免误用最新摘要缓存。
- Windows 真实覆盖安装验收通过：默认 `2026-09-20` 的当日消息为 21、当日情报为 4（模型替换、聊天转入 WorkBuddy、外部改动失效风险、生成失败积分损失）；上一日 `2026-09-19` 的当日消息为 8、当日情报为 2（社保认证、周六提醒）。左右导航、“回到最新”、最新日期禁用未来、当日统计文案、Search、Topic、WorkBuddy、Daily / Search 反馈均正常。
- 最新安装包：`release/PrivateRadar-Setup-0.2.0-alpha.11-x64.exe`（116,725,947 字节，2026-09-21 17:59:33）。
- alpha.11 是新的最终冻结基线。

## alpha.12 Settings 数据状态与安装验收

- alpha.12 只新增 Settings“数据状态”区域，复用现有 `import_jobs`、`messages` 与 WorkBuddy 连接状态；没有新增 schema 或 migration。
- 数据状态区分最近一次终态导入与最近成功导入，展示用户可理解的来源、完成时间、新增、重复、更新与错误数量；不向 Renderer 暴露 `error_details_json`、`source_batch_id`、内部 adapter 名称或不存在的 `skipped_count`。
- “数据最新至”沿用 Daily 的本地日期归属语义：优先消息真实 `timestamp`，缺失时使用 `imported_at` 参与日期计算；仅展示事实，不做新鲜度评分、过期判断、自动提醒、后台轮询或定时同步。
- Settings 最终卡片采用紧凑布局：最近导入与轻量状态标签、导入结果指标、数据最新至 / 累计 / WorkBuddy 横向三列；Windows 正式安装版已人工验收通过。
- 正式验收数据保持为 167 条 messages、14 个 chat batches、167 条 FTS；WorkBuddy 已连接，数据库完整性正常。
- 未修改 Search、Daily、Topic、WorkBuddy ingest / MCP、SQLite schema、FTS、identity / fingerprint、去重、feedback、EmbeddingProvider 或语义检索相关实现。
- 最新安装包：`release/PrivateRadar-Setup-0.2.0-alpha.12-x64.exe`（116,726,980 字节，2026-09-21 21:49:54）。
- alpha.12 是新的最终冻结基线。

## SQLite、migration 与兼容性约束

正式用户数据目录：

```text
%APPDATA%\PrivateRadar\
  private-radar.db
  workbuddy\privateradar-workbuddy\
  backups\
```

- 正式 SQLite：`%APPDATA%\PrivateRadar\private-radar.db`，绝不放在安装目录。
- `work/alpha-install/user-data` 只是隔离测试资产，生产应用与正式 Connector 不得引用或清理。
- 启动初始化入口：`src/main/schema.ts` → `initializeDatabase()`；采用 WAL、foreign keys、busy timeout。
- migration 必须幂等、向后兼容、保留现有消息与导入历史；新 schema 不得假定用户从空库升级。
- 核心表：
  - `conversations`、`participants`、`messages`、`message_links`
  - `import_jobs`、`message_import_batches`
  - `daily_intelligence_candidates`、`daily_candidate_sources`、`daily_briefs`、`daily_ai_briefs`
  - `topics`、`topic_messages`、`topic_daily_metrics`、`topic_daily_sources`
  - `query_answer_runs`、`embeddings`、`app_settings`
  - `user_feedback`（alpha.8）
  - `messages_fts`（FTS5 `unicode61`，由 messages trigger 同步）
- 必须保留索引：`idx_messages_source_batch`、稳定 identity / source identity 索引、conversation/time 与 sender/time 索引、FTS trigger、feedback 索引。
- `message_import_batches` 时间语义：
  - `first_attempt_at`：首次尝试；
  - `last_attempt_at`：最后一次尝试；
  - `last_success_at`：最近成功时间；
  - `imported_at` 仅作兼容字段，绝不可成为消息原始时间。
- 对正式数据库做验证时，优先复制到 `work/` 或临时目录；不得用测试脚本写正式库。

## 已冻结、不得无理由破坏的行为

1. 不改 D1 权重、3.2 门槛、`NEW_TOPIC` 或 Daily Value v2，除非新版本有足够真实用户标注并明确立项。
2. 不把 Daily Value、D1 信号分和优先级重新混为单一分数。
3. 不因反馈点击即时学习或改变 Daily/Search 结果。
4. 不让 `imported_at`、批次 `approximate_date` 冒充原始消息时间。
5. 不把 `unknown` 字符串写入真实元数据字段；缺失字段用 `null`，来源标记用 `unknown`。
6. 不把 unknown sender 算作真人或“1 人”。
7. 不改 WorkBuddy Connector ID、Tool 名、稳定启动配置，除非同时设计重新信任提示并做 GUI 验收。
8. 不以脚本、Harness、直接 JSON-RPC 或手动 `server.mjs` 替代 WorkBuddy GUI 正式导入验收。
9. 不修改正式数据库、Connector 配置或安装包来跑隔离 Spike。
10. Search、Topic、Daily 的来源链必须保留 `source_message_ids` 并可查看原始依据/上下文。

## 测试、构建与安装状态

- alpha.8 功能基线全量回归：有正式数据库安全副本环境时 `186/186` 通过。
- 最近一次无需正式库的全量回归：`183` 通过、`4` 条正式数据库副本测试按环境变量跳过。
- alpha.10 最终回归：Daily `50` 通过；全量 `189` 通过、`4` 跳过；TypeScript typecheck、Electron production build、WorkBuddy MCP build、Windows installer build 全部通过。
- alpha.11 最终回归：Daily / dashboard `54` 通过；全量 `194` 通过、`4` 跳过；TypeScript typecheck、Electron production build、WorkBuddy MCP build、Windows installer build 和真实历史浏览 UI 验收全部通过。
- alpha.12 最终回归：first-use `9/9` 通过；全量 `198` 通过、`4` 跳过；TypeScript typecheck、Electron production build、WorkBuddy MCP build、Windows installer build 和 Settings 数据状态真实 UI 验收全部通过。
- 最新安装包：`release/PrivateRadar-Setup-0.2.0-alpha.12-x64.exe`。
- 最新安装包大小：`116,726,980` 字节；构建时间：`2026-09-21 21:49:54`。
- Windows 真实 smoke：已完成 alpha.11 → alpha.12 覆盖升级、启动、数据保留、Settings 数据状态与紧凑三列布局验收；结果通过。
- 安装升级与默认卸载不得删除 `%APPDATA%\PrivateRadar`；NSIS 配置 `deleteAppDataOnUninstall: false`。
- 未配置代码签名；Windows SmartScreen / 未知发布者提示仍是 Alpha 已知限制。

## 当前已知限制

1. Windows 微信系统分享不能稳定提供每条消息的原始发送人和原始时间。
2. 因此快速导入数据可以用于正文 Search 与 Daily，但 Topic 的独立人数、跨群传播和精确趋势可能降级。
3. WorkBuddy 分享包路线目前只能可靠导入正文；历史微信本地数据库读取 Spike 已判定 `NO-GO`，不要重新安装、初始化或绕过微信数据保护。
4. Search V2 依赖小规模、可解释的查询扩展；尚未有真实 Embedding，FTS 使用 `unicode61`，复杂中文同义表达仍可能漏召回。
5. Daily Value v2 仍以有限人工价值标注和确定性规则设计，当前重点是 Precision；新的 MAY_SHOW recall gaps 需要更多真实反馈后再单独立项。
6. AI Provider / Embedding Provider 是可选架构；无配置时规则模式必须完整可用。
7. Feedback 导出可能包含用户主动评价过的聊天片段，只能由用户显式触发、选择位置并自行决定如何分享。
8. WorkBuddy 平台的 Skill/模型编排会带来较长首次响应时间；当前无证据表明 PrivateRadar 本地导入、SQLite 或 FTS 是该瓶颈。
9. 当前主要验证 Windows 11 + WorkBuddy 5.5.5；其他 WorkBuddy 版本、macOS 和全新实体机器覆盖有限。

## 下一版本开始前必须阅读

1. `docs/PROJECT_CHECKPOINT.md`（本文件）
2. `package.json`
3. `src/shared/models.ts`
4. `src/main/schema.ts`
5. `src/main/import/normalize.ts`、`src/main/import/fingerprint.ts`、`src/main/import/importer.ts`
6. `src/main/integrations/workbuddy/README.md` 及同目录实现文件
7. `src/main/intelligence/daily/pipeline.ts`、`signals.ts`、`importance-score.ts`、`daily-value.ts`、`brief.ts`、`repository.ts`
8. `src/main/intelligence/topics/pipeline.ts`、`signal-score.ts`、`repository.ts`
9. `src/main/retrieval/query-understanding.ts`、`hybrid-search.ts`、`service.ts`
10. `src/main/feedback/repository.ts`
11. `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/data-refresh.ts`
12. `tests/feedback.test.ts`、`tests/chat-search.test.ts`、`tests/daily-intelligence.test.ts` 与 `work/alpha8-feedback-validation/` 的安全副本验证。

## NEW_CODEX_SESSION_PROMPT

```text
继续 PrivateRadar。请先阅读 docs/PROJECT_CHECKPOINT.md，严格把 0.2.0-alpha.12 视为冻结基线。

不要修改 D1、Daily Value、Search、Topic、WorkBuddy、MCP、SQLite identity、正式数据库或正式安装包，除非我明确指定一个新的版本目标、范围、验收条件和允许改动的模块。

先只读确认：当前工作目录、git status、package.json 版本、PROJECT_CHECKPOINT 的冻结约束。随后只执行我本次明确提出的任务。

任何涉及正式数据库的验证必须先复制到隔离副本；不得用 Harness、脚本或直接 JSON-RPC 伪造 WorkBuddy GUI 正式链路；不得把 imported_at 或 approximate_date 当作消息原始时间；不得把 unknown sender 计入真人统计。
```
