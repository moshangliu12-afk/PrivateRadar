---
name: privateradar-ingest-chat
description: 当用户要求把微信分享或当前上下文中的聊天记录导入 PrivateRadar 时使用；走最短导入路径，不扫描代码，不寻找脚本替代方案。
---

# 快速写入 PrivateRadar

用户明确要求导入时，正常路径必须收敛为：

`解析分享 → 必要时只确认群名 → 立即调用 privateradar_ingest_messages → 简短确认`

## 最短路径（必须遵守）

1. 只读取用户分享的聊天内容，只提取原始顺序、正文、可见 URL，以及来源真实提供的群名、发送人和时间。
2. 不做话题分析、摘要或内容评价，不浏览项目代码，不检查数据库，不扫描脚本，不写工作日志或记忆文件。
3. 快速导入是默认模式。若群名已经存在于分享或用户消息中，直接调用 Tool，不再询问导入模式。
4. 若群名缺失，只问一次：“这份聊天的群名/会话名是什么？默认按快速导入，发送人和时间缺失可直接省略。”不要逐条追问。
5. 用户明确说发送人或时间未知、允许按 `unknown` 处理时，调用参数中直接省略对应字段；绝不能传字符串 `"unknown"`，也不再尝试推测。
6. Tool 可用时只能调用 `privateradar_ingest_messages`。禁止寻找或使用脚本、Harness、stdio、JSON-RPC、手动 `server.mjs` 等替代方案。
7. Tool 成功后只回复一到两句：导入是否成功，以及新增/重复/更新/无效数量。除非存在数据完整度降级，否则不要追加分析。

## 快速导入

只确认群名。调用 Tool 时传递 `import_mode: quick`，在 `batch_metadata` 中传群名及 `conversation_name_source: user_supplied`。发送人和时间缺失时省略字段，不得补造，不得再次确认。

## 完整导入

仅当用户主动要求提高精度时使用。一次性确认群名、大致日期，以及来源能够区分发送人时的标记映射；不要逐条询问。调用 Tool 时传递 `import_mode: complete`：

- 群名写入 `batch_metadata.conversation_name`，来源为 `user_supplied`。
- 大致日期写入 `batch_metadata.approximate_date`，来源为 `user_supplied`。它不是原始消息时间，不得复制到各条 `timestamp`。
- 发送人规则写入 `batch_metadata.sender_mapping`。每条消息只传来源中真实存在的 `sender_marker`，由 Adapter 一次性映射。

如果分享本身包含可逐条对应的原始时间，可传入各条 `timestamp`；用户确认或补充的值标记为 `user_supplied`。不要把大致日期、导入时间或当前时间批量伪造成逐条原始时间。

## 必要字段规则

从当前分享中提取消息并保持原始顺序：

- `source_batch_id`：来源有稳定分享 ID 时填写；没有则省略。

- `platform`：已知时填写来源平台；本次测试微信内容填写 `wechat`。
- `conversation_name`：原文能够确认时填写群名或会话名。
- `conversation_name_source`：原始分享提供用 `source_native`，用户确认用 `user_supplied`。
- `sender_name`：原文能够确认时填写发送人。
- `sender_name_source`：只按真实来源标记；缺失则连同名称一起省略。
- `timestamp`：原文能够确认时填写原始时间，优先使用带时区的 ISO 8601。
- `timestamp_source`：只按真实来源标记；缺失则连同时间一起省略。
- `content`：保持原始正文，不补写、不总结。
- `content_source`：微信分享直接提供的正文填写 `source_native`。
- `source_message_id`：只有来源提供可靠 ID 时才填写。
- `source_position`：按原始顺序从 0 开始填写；补全元数据时不得改变。

禁止猜测缺失字段。正文缺失的单条消息可以作为无效记录交给 Tool，其余消息继续导入。一次最多提交 500 条。失败时只说明 Tool 返回的错误和可执行的重试建议，不寻找替代通道。
