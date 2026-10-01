# WorkBuddyAdapter

正式接入通过 WorkBuddy 官方本地 stdio MCP Connector。正式 `tools/list` 只公开两个入口：单卡片使用 `privateradar_ingest_messages`，双卡片使用 `privateradar_ingest_current_context_batch`。旧 ZIP 批量 handler 仅保留内部兼容性与回归测试，不对 WorkBuddy 公开。运行时代码由以下部分组成：

- `server.ts`：stdio 进程生命周期与不含正文的生命周期日志。
- `tool.ts`：MCP Tool 注册及结构化输入、输出。
- `validation.ts`：字段、来源标记及批量上限。
- `ingest.ts`：WorkBuddy 输入到既有导入、标准化、身份、去重和 SQLite 流程的适配。
- `batch-metadata.ts`：批次元数据、完整度计算和能力降级提示。
- `batch-tool.ts`：当前上下文批量入口、Directory Evidence，以及内部 legacy ZIP handler 与现有会话编排的接线。

当前上下文批量 Tool 接收本次输入真实提供的 raw context blocks。每个 block 原样携带 `file`、`extracted_dir_path`、`message_count` 与 inline `transcript`，并可携带 `first_sender`、`first_message_at`、`truncated`。Tool 自己完成重复 serialization 归组、确定性 Parser、Directory Evidence 与导入，最终必须恰好得到两个 logical attachments。Skill 不生成双卡 `messages`，不读取 `聊天记录.txt` 替代 inline transcript，也不扫描目录、猜测 ZIP 路径或按时间寻找附件。

内部 legacy ZIP handler 继续保留原有路径边界、ZIP Evidence、validation 和回归测试，但不注册到正式 MCP。它要求两个真实 ZIP 绝对路径和各自消息数组；这不是 alpha.15 Skill 的正式调用路径。

## 两种导入模式

- 快速导入：一次确认群名；发送人和时间允许保持缺失。
- 完整导入：一次确认群名、大致日期和可用的发送人映射，不逐条询问。

`approximate_date` 和 `imported_at` 只属于批次，绝不复制到消息 `timestamp`。只有来源可逐条对应的时间才进入消息时间字段。

调用 Tool 前必须先检查当前材料是否包含可逐条对应的原始时间。快速导入只减少交互，不得跳过这项检查。源材料直接提供的时间标记为 `source_native`，用户明确提供的时间标记为 `user_supplied`；没有可靠时间时省略时间字段。

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
