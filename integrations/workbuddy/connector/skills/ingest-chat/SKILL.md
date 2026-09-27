---
name: privateradar-ingest-chat
description: 当用户要求把微信分享或当前上下文中的聊天记录导入 PrivateRadar 时使用；走最短导入路径，不扫描代码，不寻找脚本替代方案。
---

# 快速写入 PrivateRadar

用户明确要求导入时，正常路径必须收敛为：

`识别当前附件数 → 逐附件解析分享 → 调用对应导入 Tool → 简短确认`

## 最短路径（必须遵守）

1. 只读取用户分享的聊天内容，只提取原始顺序、正文、可见 URL，以及来源真实提供的群名、发送人和时间。
2. 不做话题分析、摘要或内容评价，不浏览项目代码，不检查数据库，不扫描脚本，不写工作日志或记忆文件。
3. 快速导入是默认模式。群名缺失时省略 `conversation_name`，不阻塞导入，不要求用户猜测。
4. 当前输入只有一个聊天附件时沿用 `privateradar_ingest_messages`；恰有两个时各自读取当前明确提供的 ZIP 路径与聊天文本，各自建立消息数组，只调用一次 `privateradar_ingest_batch`。
5. 用户明确说发送人或时间未知、允许按 `unknown` 处理时，调用参数中直接省略对应字段；绝不能传字符串 `"unknown"`，也不再尝试推测。
6. 超过两个聊天附件时明确回复“当前 alpha.15 批量入口只支持同次两个聊天附件”；不得只取前两个或自动拆批。没有附件时不创建批量会话。
7. 每张卡片的 ZIP 必须直接取自当前输入中该卡片自己的附件元数据所明确给出的、已复制完成的真实绝对路径。`chipId` / `attachment_id` 只有在当前输入明确给出，且正式授权的当前附件路径解析能力确实可用时，才能逐卡片解析；当前没有该正式解析能力时，不得自行使用标识找文件。显示文件名不等于落盘文件名，绝不能 `join(chatHistoryRoot, displayFilename)`。路径缺失、不能确认属于当前卡片、或 Tool 报“当前附件真实路径不可用”时，停止导入并返回“当前附件真实路径不可用，未执行导入。”；禁止列举或扫描 `chat-history`、搜索相似文件名、寻找最新 ZIP、按时间戳推断路径或读取历史附件补救。ZIP A 只配消息 A，ZIP B 只配消息 B，不合并数组、不按时间重排。
8. 只能调用对应的正式 MCP Tool。禁止寻找或使用脚本、Harness、stdio、JSON-RPC、手动 `server.mjs` 等替代方案。
9. Tool 成功后只回复整次导入和各附件的真实新增/重复/更新/无效数量。除非存在数据完整度降级，否则不要追加分析。
10. 本次 PrivateRadar 导入期间及导入后，除非用户明确要求记录记忆，否则不得创建或修改 `MEMORY.md`、WorkBuddy memory 日志或当日记忆文件；不得总结导入经验写入全局或用户记忆，尤其不得记录“下次扫描目录寻找 ZIP”之类的路径补救经验。

## 调用前的逐条时间检查（必须）

在调用导入 Tool 之前，必须逐附件检查当前材料是否包含能够与每条消息可靠对应的原始时间。快速导入表示少交互、快速完成，不表示忽略材料中已经存在的时间。

- 原始微信或源材料直接显示了某条消息的时间：为该条填写 `timestamp`，并标记 `timestamp_source: source_native`。
- 用户明确提供了某条消息的时间：为该条填写 `timestamp`，并标记 `timestamp_source: user_supplied`。
- 没有时间或无法可靠对应到具体消息：省略该条的 `timestamp` 和 `timestamp_source`；快速模式不以追问用户补时间为前置条件。
- 禁止用 `approximate_date`、`imported_at`、当前时间、消息顺序或正文中的“下午”“昨天”等措辞生成时间，也禁止人工生成等间隔时间。
- 原文未写时区时，`+08:00` 只是系统解释，不是原文原生字段。

## 快速导入

调用对应 Tool 时使用 `import_mode: quick`。只有原文或用户明确提供群名时才传群名和相应来源；缺失时直接省略。发送人和时间缺失时也省略，不得补造。

## 完整导入

仅当用户主动要求提高精度时使用。可一次性确认用户愿意提供的群名、大致日期，以及来源能够区分发送人时的标记映射；群名缺失仍可导入，不要逐条询问。调用对应 Tool 时传递 `import_mode: complete`：

- 仅在用户明确确认群名时写入 `batch_metadata.conversation_name`，来源为 `user_supplied`；缺失不阻塞导入。
- 大致日期写入 `batch_metadata.approximate_date`，来源为 `user_supplied`。它不是原始消息时间，不得复制到各条 `timestamp`。
- 发送人规则写入 `batch_metadata.sender_mapping`。每条消息只传来源中真实存在的 `sender_marker`，由 Adapter 一次性映射。

如果分享本身包含可逐条对应的原始时间，可传入各条 `timestamp`；用户确认或补充的值标记为 `user_supplied`。不要把大致日期、导入时间或当前时间批量伪造成逐条原始时间。

## 必要字段规则

从当前分享中按附件分别提取消息并保持各自原始顺序。两附件调用参数使用 `attachments`，每项包含当前输入明确给出的 `source_zip_path` 和自己的 `messages`，可选 `display_name`、`source_hint`、`batch_metadata` 与 `import_mode`：

- `source_batch_id`：仅旧单附件 Tool 在来源有稳定分享 ID 时填写；新批量 Tool 不传此字段，附件项会持久生成自己的稳定来源编号。

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

禁止猜测缺失字段。正文缺失的单条消息可以作为无效记录交给 Tool，其余消息继续导入。每附件最多提交 500 条。失败时只说明 Tool 返回的真实错误，不寻找替代通道。

## 正式调用示例

源材料含有可逐条对应时间时：

```json
{
  "import_mode": "quick",
  "batch_metadata": {
    "conversation_name": "产品交流群",
    "conversation_name_source": "user_supplied"
  },
  "messages": [
    {
      "platform": "wechat",
      "conversation_name": "产品交流群",
      "content": "新版已经发布。",
      "source_position": 0,
      "timestamp": "2026-09-20T12:02:00+08:00",
      "timestamp_source": "source_native"
    }
  ]
}
```

源材料没有可靠逐条时间时，正确做法是省略时间，而不是补造：

```json
{
  "import_mode": "quick",
  "batch_metadata": {
    "conversation_name": "产品交流群",
    "conversation_name_source": "user_supplied"
  },
  "messages": [
    {
      "platform": "wechat",
      "conversation_name": "产品交流群",
      "content": "新版已经发布。",
      "source_position": 0
    }
  ]
}
```
