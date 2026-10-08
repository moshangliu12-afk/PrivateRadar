# WorkBuddyAdapter

正式接入通过 WorkBuddy 官方本地 stdio MCP Connector。单卡与双卡统一使用 `privateradar_ingest_current_context_batch`，只转交本次真实提供的原始上下文。`tools/list` 保留两个既有工具名称，但 `privateradar_ingest_messages` 公开旧入口无写入拒绝仅含规范消息的调用，不能作为降级路径。旧 ZIP 批量处理函数仅保留内部兼容性与回归测试，不对 WorkBuddy 公开。运行时代码由以下部分组成：

- `server.ts`：stdio 进程生命周期与不含正文的生命周期日志。
- `tool.ts`：MCP Tool 注册及结构化输入、输出。
- `validation.ts`：字段、来源标记及批量上限。
- `ingest.ts`：WorkBuddy 输入到既有导入、标准化、身份、去重和 SQLite 流程的适配。
- `batch-metadata.ts`：批次元数据、完整度计算和能力降级提示。
- `batch-tool.ts`：当前上下文批量入口、Directory Evidence，以及内部 legacy ZIP handler 与现有会话编排的接线。

当前上下文工具接收本次输入真实提供的全部原始上下文块。每块原样携带 `file`、`extracted_dir_path`、`message_count` 与内联 `transcript`，并可携带 `first_sender`、`first_message_at`、`truncated`。工具完成重复序列化归组、确定性解析、目录证据与导入，归组后仅接受一个或两个逻辑附件。单卡可能被平台重复序列化为多份原始块，不能把原始块数量当作附件数量。Skill 不解析单卡或双卡正文、不生成 `messages`、不读取 `聊天记录.txt` 替代内联正文，也不扫描目录、猜测 ZIP 路径或按时间寻找附件。

当前路径先保存每个附件独立的原始目录证据与含原始文本的结构化快照，再沿用 Item → occurrence → canonical message 导入链。只有本次真实新增来源位置会登记承诺提取运行记录；重复规范消息仍可能有新的来源。旧的仅含规范消息的单卡导入不回扫、不补造附件项或证据、不自动补建承诺候选。缺少原始来源或解析失败时停止，不能改用公开旧入口。

内部旧 ZIP 处理函数 `privateradar_ingest_batch` 继续保留原有路径边界、ZIP 证据、校验和回归测试，但不注册到正式 MCP。它要求两个真实 ZIP 绝对路径和各自消息数组，不是当前 Skill 的正式调用路径。

当前源码中产品、Connector 元数据与 MCP 服务版本为 `0.2.0-alpha.19`；两份 Skill 源同步为 `0.2.0-alpha.18-skill.1`。部署从 Connector 内嵌 Skill 取源，并校验独立版本及完整哈希。官方 alpha.16-skill.1 旧内容继续按精确哈希受管，允许原子升级；当前同内容不重写，自定义内容保留并返回明确状态。这份源码契约不代表本轮已更新正式用户 Skill、连接器或数据库。

## 正式入口与内部兼容模式

- 正式单卡与双卡入口均保持快速导入，不扩展 `complete`、元数据补全或未知时间解析能力；当前工具不接收 `import_mode`。
- 内部规范消息适配器继续保留旧 `quick / complete` 和批次元数据语义，供既有持久快照及兼容调用使用，不恢复公开仅含规范消息的入口。
- 单卡归组后不得携带 `collection_id`，必须拒绝且不得去掉编号再次调用；双卡继续只转交本轮明确的完整 Collection UUID，不新增单卡归集。

`approximate_date` 和 `imported_at` 只属于批次，绝不复制到消息 `timestamp`。只有来源可逐条对应的时间才进入消息时间字段。

单卡与双卡都直接交付原始上下文。当前确定性解析器要求逐条完整日期与时分，缺失时拒绝整个输入，Skill 不补造时间、不生成消息数组或改走旧入口。源材料直接提供的时间由既有解析逻辑标记为 `source_native`，时区解释另行保留；不改动解析语法。

## 内部兼容的规范消息格式

以下消息格式仅说明保留的内部适配器，不是公开工具调用或失败降级方案。源材料直接提供的时间为 `source_native`，用户明确提供的时间为 `user_supplied`；没有可靠逐条时间时，内部旧消息格式仍省略时间字段。这不表示当前原始上下文解析器已支持缺时间。

带原始时间的最小消息示例：

```json
{
  "conversation_name": "产品交流群",
  "content": "新版已经发布。",
  "source_position": 0,
  "timestamp": "2026-09-20T12:02:00+08:00",
  "timestamp_source": "source_native"
}
```

没有可靠逐条时间时，应使用不含时间字段的消息：

```json
{
  "conversation_name": "产品交流群",
  "content": "新版已经发布。",
  "source_position": 0
}
```

不得使用批次大致日期、导入时间、当前时间、消息顺序或正文措辞推导逐条时间，也不得人工生成等间隔时间。当前明确支持带时区 ISO 8601，以及 `YYYY-MM-DD HH:mm[:ss]` 或等价 `T` 分隔的无时区格式；后者按既定 `+08:00` 规则处理。不正式承诺中文自然语言日期、Unix 数字时间或其他模糊格式。

批次 `completeness_level` 表示当前最高可用完整度：

- `content_only`：只有正文。
- `conversation_known`：整批群名已确认。
- `approximate_time_known`：另有大致日期，但没有逐条精确时间。
- `sender_known`：整批发送人已可识别；大致日期状态仍由独立字段保留。
- `complete`：群名、发送人和逐条时间均已确认。

## 字段来源

`conversation_name`、`sender_name`、`timestamp` 和 `content` 分别保存来源标记：

`source_native > user_supplied > inferred > unknown`

缺失值保存为空值，来源保存为 `unknown`。不得用“未知群”“用户”或当前时间填充。后续只有更高可信来源可以覆盖较低可信来源。

## 消息身份

稳定身份与旧指纹职责分离：

- 有可靠 `source_message_id`：由 `platform + source_message_id` 生成稳定身份。
- 没有可靠来源 ID：由 `platform + source_batch_id + source_position + normalized content` 生成稳定身份。
- 未提供批次 ID 时，适配器按有序正文、平台和位置生成确定性批次身份。

WorkBuddy 消息的 `fingerprint` 由稳定身份派生，因此补充群名、发送人或时间不会改变身份或产生新消息。文件导入仍保留旧指纹作为跨文件重叠数据的兼容去重路径。

## 调试隔离

本地 JSON-RPC Harness 已移至 `tools/debug/`，不得作为正式运行时入口。正式运行只使用 `integrations/workbuddy/connector/` 中的官方 Connector 包。
