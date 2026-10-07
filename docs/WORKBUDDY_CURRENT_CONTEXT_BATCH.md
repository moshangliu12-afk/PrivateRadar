# alpha.18 当前卡片上下文单卡与双卡导入

历史 alpha.15 的 Step 5I 源码接线及隔离验证已完成；Step 5J 完成真实 WorkBuddy 双卡 5+5 验收，结果为 `PASS_WITH_ISSUE`，随后 `ROLLBACK_VERIFIED`。当时形成 10 条 messages、10 条 FTS、1 个 Session、2 个 Item、2 个 Job、2 个 source batch 和 2 套 Directory Evidence。历史证据不在此文档复制，也不作为当前单卡修复已部署或已验收的证明。

当前 alpha.18 源码将单卡与双卡统一到原始上下文入口；Skill 源版本为 `0.2.0-alpha.18-skill.1`。本轮源码变更不安装、不发布、不改正式用户 Skill，不回溯旧的仅含规范消息导入。

正式设计：WorkBuddy 当前输入 → 原样转交全部原始上下文 → 输入归组门禁与确定性解析 → 一个或两个逻辑附件 → 目录证据 → 每个附件独立的 Item / Job / source batch → occurrence → canonical message。

原始上下文数量可以大于逻辑附件数量；同一卡片重复序列化两份仍归组为一个附件，四份原始块也可能归组为两个附件。正式产品只支持一个或两个逻辑附件，不承诺任意数量卡片。

## 工具契约

旧 `privateradar_ingest_batch` 仅为内部兼容路径，保留 `{ attachments: [...] }`、两个 `source_zip_path + messages` 附件及 ZIP Evidence，不出现在正式 tools/list。公开旧 `privateradar_ingest_messages` 保留工具名称，但无写入拒绝仅含规范消息的调用，不允许单卡或双卡降级到它。

单卡与双卡正式工具均为 `privateradar_ingest_current_context_batch`，由 `0.2.0-alpha.18-skill.1` 从当前输入原样转交全部原始块并只调用一次：

```json
{
  "mode": "current_context",
  "contexts": [
    {
      "file": "当前卡片原始显示名.zip",
      "extracted_dir_path": "当前卡片明确提供的本地目录绝对路径",
      "message_count": 3,
      "transcript": "当前卡片完整 inline transcript",
      "first_sender": "可选，原值",
      "first_message_at": "可选，原值",
      "truncated": false
    }
  ]
}
```

示意中只展示一份原始块，实际执行必须传入当前输入中的全部原始块，归组后仅允许一个或两个逻辑附件。工具不要求 Agent 去重、生成 messages、重新读取 TXT 或寻找路径。`first_sender`、`first_message_at`、`truncated` 可以缺失；其含义沿用既有契约。`file` 只保存为显示名和快照元数据。

输入继续使用严格对象：顶层只接收 `mode / contexts` 及双卡显式归集使用的 `collection_id`，context 只接收上列字段。自由 messages、ZIP 路径、批次身份、`import_mode` 及其他字段不接受。原始上下文入口保持快速导入，不扩展 `complete`。归组后单卡携带 `collection_id` 时必须在创建记录或证据前拒绝，不能去掉编号后重试。

集中资源限制保持不变：最多 16 个原始块；每份 transcript 最多 262144 个 JavaScript UTF-16 代码单元；所有原始 transcript 合计最多 4 MiB UTF-8；每卡消息数 1–500；目录路径最多 4096、显示名最多 255 个代码单元。这是控制重复序列化、解析与快照内存的保守预算，结合既有 Parser 500 条与目录快照 8 MiB 上限，不是 WorkBuddy 实际容量或 16 个附件支持声明。逻辑附件仅允许一个或两个。

`truncated=true` 由 Gate 拒绝。新入口额外保守拒绝独立行的 `[truncated]`、`[内容已截断]`、`[聊天记录已截断]`、`<truncated/>` 标记；普通省略号不视为截断。这些是入口拒绝规则，不声称上游一定使用这些标记；原始正文恰好包含独立标记时也会拒绝，等待明确完整输入。

## 顺序与零副作用边界

1. 严格类型与容量检查。
2. 直接调用 `gateWorkBuddyBatchCurrentInput`。既有门禁在按精确目录字符串归组时完成 Parser、首条元数据、截断字段和副本冲突校验，再检查逻辑数量为一或二。单卡同时携带归集编号时拒绝。之后补充检查正文中的独立截断标记，保持既有冲突优先级。不增加第二套去重或重复解析。
3. 逐项目录入口预检及快照结构验证。检查绝对路径、存在、普通目录、允许根范围、非根自身、realpath；复用 Step 5H 原生句柄逐层拒绝祖先或当前目录重解析点。全部完成前不创建 Session、Item、Job 或 Evidence。
4. 短事务创建一个 Session、一个或两个 Item。目录项来源类型设为 `directory`，内容身份保持 null。
5. 每项分别准备目录证据与消息快照；准备错误登记到对应 Item，双卡时不阻止另一项。
6. 调用既有 `executeBatchImportSession`，生成包含实际一个或两个 Item 的汇总结构。输入和输出数量契约同时调整，避免单卡已导入后才因旧双卡输出校验失败。

现有根规则统一复用：`options.chatHistoryRoot` 用于项目内部隔离测试；实际默认来自 `homedir()/.workbuddy/app/tmp/chat-history`，不硬编码用户。调用者的工具参数不能覆盖允许根。路径只来自明确传入的 `extracted_dir_path`，不列举允许根、匹配显示文件名、按时间猜测或查日志。

入口预检不递归哈希源树。预检句柄释放后到证据准备期间的源变化，由 Step 5H 再次取得安全句柄、复制前后核验及发布后复验处理；这种运行期失败保留 Session/Item 失败状态，不伪装成入口零副作用失败。

## 消息与证据

消息仅取 Gate 返回的 Parser 结果；消息数组不接受 Agent 构造。每卡 `expectedMessageCount` 来自原始 `message_count`。当前 Parser 要求逐条完整日期与 HH:mm，缺失则整批拒绝，不扩展未知时间语法。

`saveDirectoryEvidence` 负责安全暂存、清单与内容身份计算、同根原子发布和最终目录复验。之后才通过带条件的 SQL 登记 `attachment_identity / evidence_relative_path / evidence_status`。身份是 manifest 内容身份，不是 TXT、transcript、路径、显示名或 ZIP 的哈希。预检不预先计算身份，也不在 Item 创建时写占位身份。

不同路径归组得到不同 Item；即使目录内容身份相同，item UUID、`workbuddy:item:<item UUID>` 来源批次、证据目录和任务仍独立。

目录结构仍是 `evidence/<item UUID>/source/`、`manifest.json`、`messages.json`。不生成 ZIP。消息快照除解析后的 messages 外，还保留 `parser` 的语法版本与时区解释，以及 `current_context` 的原始 transcript、路径、显示名、首条元数据、数量和 context 索引。快照保留 Parser 原值；现有 importer 的正文首尾空白规范化保持原行为。

目录证据通过验证后才保存快照，快照完成后再次整体校验；既有 Item 导入也继续验证持久证据和快照。失败 Item 不能进入 importer。

原文日期与时分为 `source_native`，`+08:00` 明确保存在 `timezone_interpretation` 中作为系统解释，不标成原文时区。底层目录快照和旧 ZIP 入口仍允许既有未知时间消息并保持 `timestamp=null / timestamp_source=unknown`；这不表示当前 Parser 已支持缺时间语法。目录时间、manifest、导入时间均不参与消息时间生成。

## 失败、重复与恢复

入口失败整次拒绝且零新增记录。Session 创建后的证据或导入失败保留对应失败项；双卡的另一项成功时按既有语义汇总为 `partial_success`，有已提交消息但后续失败则使用 `needs_attention` 判断。单卡失败不伪装为双卡汇总，没有跨项回滚。

`prepareWorkBuddyCurrentContextBatch` 提供内部证据准备阶段，返回既有 Session ID；工具只暴露一次准备并执行的入口，不新增重试协议。准备完成后使用原有 Session/Item API 即可执行或恢复，不需要 raw contexts 或原临时路径。

普通重复执行成功 Item 被原子 claim 拒绝；显式 `deterministic_replay` 沿用既有稳定批次与 source_position，duplicate-only、updated-only 都维持成功语义，不重新定义 ImportResult。重新调用整个输入工具属于新 Session，不是同 Item 重试；不宣称跨工具调用幂等。

恢复仍限持久来源与明确状态的安全边界：Session 为 `in_progress`，恰有一个未开始且持久证据完整的 Item。成功项不重放；状态含糊的处理中项拒绝；已终结的失败或需关注项不自动重试。双卡两个都未开始、准备过程中中断、已终结 Session 及缺损 Evidence 不属于自动恢复范围。准备完成且 Session 仍为 pending 时可走既有首次执行 API。单卡只适配相同持久 Item 链，不从旧规范消息或历史临时目录重建来源。

## 后续边界

真实双卡字段映射已在 Step 5J 验证；严格字段仍须由当前上下文直接提供，不能靠历史记录补齐。该结果不等于 RC 安装版验收，也不代表任意输入、附件数量或性能场景都已验证。

保留 Step 5H 的强杀、断电孤立目录维护事项，不新增自动清理。完整安全边界仍限 Windows 本地固定磁盘，原生能力不可用时拒绝，没有普通复制降级。

Step 5K 已吸收 alpha.14.1 的时间语义、Daily 缓存、空名称及纯符号名称 Search 维护修复。Step 5L-B 的 Packaging Contract checkpoint 为 `74fc0c7d9bf7e6c43bec791f6a1907d902e8f556`。

两个非阻塞已知问题继续保留：部分多行消息进入 messages.content 时末尾一个换行可能被规范化移除，但 messages.json 和 raw_metadata_json 保留完整来源；某些纯中文明确日期 Search 可能漏召回。详见根目录 KNOWN_ISSUES.md。
