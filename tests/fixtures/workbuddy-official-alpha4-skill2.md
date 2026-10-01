---
name: privateradar-ingest-chat
display_name: PrivateRadar 微信聊天导入
display_name_en: PrivateRadar Chat Import
description: 将当前分享的微信聊天以最短路径导入 PrivateRadar。
description_zh: 将当前分享的微信聊天以最短路径导入 PrivateRadar。
description_en: Import the currently shared chat into PrivateRadar using the shortest safe path.
version: 0.2.0-alpha.4-skill.2
author: PrivateRadar
---

# PrivateRadar 微信聊天快速导入

当用户分享微信聊天并说“将这份聊天记录导入 PrivateRadar”或语义等价的话时，立即执行本流程。

正常路径只能是：

`解析聊天 → 缺群名时只询问一次群名 → 调用 privateradar_ingest_messages → 简短确认`

## 强制规则

1. 只读取当前分享中可见的聊天内容；保持消息正文、可见 URL 和原始顺序。
2. 只允许直接读取当前分享明确给出的聊天文本或附件路径一次；不得为发现文件而列举目录。
3. 禁止调用 Bash、PowerShell、Glob、Grep 或任何目录扫描来探测聊天文件、工作区、代码、数据库、历史脚本或附件以外的上下文。
4. 不创建、不读取、不调用 `privateradar-ingest-client.mjs`。
5. 不使用 Harness、direct JSON-RPC、stdio、手动 `server.mjs` 或任何脚本作为替代通道。
6. 正式且唯一的导入通道是 `privateradar_ingest_messages`。
7. 快速导入是默认模式。若分享或用户消息已有 `conversation_name`，立即调用 Tool。
8. 若缺少 `conversation_name`，只问一次且逐字使用：“这份聊天的群名或会话名是什么？”
9. `sender_name` 和 `timestamp` 缺失时直接省略对应字段：不主动询问、不推测、不补造，也绝不传字符串 `"unknown"`。
10. 用户确认群名后，立即按 `import_mode: quick` 调用正式 Tool；不要再询问日期、发送者或逐条时间。
11. Tool 成功后只回复导入成功与新增、重复、更新、无效数量；不要重复调用 Tool 做重复校验，不做额外分析。

## 调用前的逐条时间检查（必须）

在调用 `privateradar_ingest_messages` 之前，必须先检查当前材料是否包含能够与每条消息可靠对应的原始时间。快速导入表示少交互、快速完成，不表示忽略材料中已经存在的时间。

- 原始微信或源材料直接显示了某条消息的时间：填写 `timestamp`，并标记 `timestamp_source: source_native`。
- 用户明确提供了某条消息的时间：填写 `timestamp`，并标记 `timestamp_source: user_supplied`。
- 没有时间或无法可靠对应到具体消息：省略 `timestamp` 和 `timestamp_source`；快速模式不以追问用户补时间为前置条件。
- 禁止用 `approximate_date`、`imported_at`、当前时间、消息顺序或正文中的“下午”“昨天”等措辞生成时间，也禁止人工生成等间隔时间。

## 群名不得推测

- 只有用户明确提供的名称才可写入 `conversation_name`，并标记 `conversation_name_source: user_supplied`。
- 不得根据正文、物业或机构落款、人名、地点、图片文件名、聊天主题或任何上下文推测群名。
- 不得生成、推荐、展示或要求用户从候选群名中选择。
- 用户未提供群名时，只能提出上述唯一问题；不得以任何推测值调用 Tool。

## 不展示中间分析

- 最终可见回复中不得输出“我认为”“我猜”“让我判断”“我正在分析”或任何内部推理、检查过程。
- 不得在提问前输出“我先加载技能”“我先检查目录”“正在读取文件”等进度性中间回复。
- 用户回答群名后，同一轮立即调用 `privateradar_ingest_messages`；不要解释计划、复述规则或再次征求确认。
- Tool 成功后，最终回复只保留一行导入结果，例如“导入成功：新增 8，重复 0，更新 0，无效 0。”

## 字段真实性

- `content` 只保存分享中的原文，不改写、不总结。
- `source_position` 按分享中的原始顺序从 0 开始。
- 分享直接提供的群名、发送人、时间才使用 `source_native`。
- 用户确认的群名使用 `user_supplied`。
- 用户未提供的发送人和时间保持缺失；不得用导入时间、图片文件名日期或当前时间伪造逐条 `timestamp`。

## 例外

- 如果用户明确选择“按未知字段导入”，群名、发送人和时间均可省略，直接调用正式 Tool。
- 只有用户主动要求“提高分析精度”时，才可以一次性询问群名、大致日期和发送人标记；这不是快速导入的默认路径。
- 单条正文缺失时可随本批提交，让 Tool 将该条记为无效；其余有效消息仍应导入。

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

源材料没有可靠逐条时间时，省略时间字段：

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

缺少时间是允许的；不得为满足字段完整度伪造时间。
