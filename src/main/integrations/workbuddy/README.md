# WorkBuddyAdapter

正式接入只通过 WorkBuddy 官方本地 stdio MCP Connector 调用 `privateradar_ingest_messages`。运行时代码由以下部分组成：

- `server.ts`：stdio 进程生命周期与不含正文的生命周期日志。
- `tool.ts`：MCP Tool 注册及结构化输入、输出。
- `validation.ts`：字段、来源标记及批量上限。
- `ingest.ts`：WorkBuddy 输入到既有导入、标准化、身份、去重和 SQLite 流程的适配。
- `batch-metadata.ts`：批次元数据、完整度计算和能力降级提示。

## 两种导入模式

- 快速导入：一次确认群名；发送人和时间允许保持缺失。
- 完整导入：一次确认群名、大致日期和可用的发送人映射，不逐条询问。

`approximate_date` 和 `imported_at` 只属于批次，绝不复制到消息 `timestamp`。只有来源可逐条对应的时间才进入消息时间字段。

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
