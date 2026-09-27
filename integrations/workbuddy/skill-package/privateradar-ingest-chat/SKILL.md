---
name: privateradar-ingest-chat
display_name: PrivateRadar 微信聊天导入
display_name_en: PrivateRadar Chat Import
description: 将当前分享的微信聊天以最短路径导入 PrivateRadar。
description_zh: 将当前分享的微信聊天以最短路径导入 PrivateRadar。
description_en: Import the currently shared chat into PrivateRadar using the shortest safe path.
version: 0.2.0-alpha.15-skill.2
author: PrivateRadar
---

# PrivateRadar 微信聊天快速导入

当用户分享微信聊天并说“将这份聊天记录导入 PrivateRadar”或语义等价的话时，立即执行本流程。

正常路径只能是：

`识别当前输入的聊天附件数 → 各附件独立解析 → 调用对应 Tool → 简短确认`

## 强制规则

1. 只读取当前分享中可见的聊天内容；保持消息正文、可见 URL 和原始顺序。
2. 只允许直接读取当前分享明确给出的聊天文本或附件路径一次；不得为发现文件而列举目录。
3. 禁止调用 Bash、PowerShell、Glob、Grep 或任何目录扫描来探测聊天文件、工作区、代码、数据库、历史脚本或附件以外的上下文。
4. 不创建、不读取、不调用 `privateradar-ingest-client.mjs`。
5. 不使用 Harness、direct JSON-RPC、stdio、手动 `server.mjs` 或任何脚本作为替代通道。
6. 只有一个当前聊天附件时继续调用 `privateradar_ingest_messages`；恰有两个时只调用一次 `privateradar_ingest_batch`，不调用两次旧 Tool。
7. 超过两个当前聊天附件时明确回复“当前 alpha.15 批量入口只支持同次两个聊天附件”，不只取前两个，也不自动拆批；没有附件时不创建批量会话。
8. 两附件各自读取当前输入明确提供的 ZIP 路径和聊天文本，各自建立原顺序的 `messages`；ZIP A 与消息 A、ZIP B 与消息 B 一一对应，不合并、不按时间重排。
9. 两附件调用中的 `source_zip_path` 必须是当前输入明确提供、与各卡片一一对应的真实 ZIP 绝对路径。只有展示文件名、拼接临时根目录后的路径、或不能确认存在的路径，都不算真实路径。路径缺失或 Tool 报“当前附件真实路径不可用”时，停止导入并返回“当前附件真实路径不可用”；不得列举或扫描 `chat-history`，不得搜索相似文件名、寻找最新 ZIP、按时间戳推断路径或读取历史附件补救。只有当前输入已明确给出真实路径字段时才可使用它。
10. 快速导入是默认模式。群名缺失时直接省略 `conversation_name` 和相关来源字段，不阻塞导入、不要求用户猜测。
11. `sender_name` 和 `timestamp` 缺失时直接省略对应字段：不主动询问、不推测、不补造，也绝不传字符串 `"unknown"`。
12. Tool 成功后只回复整次导入与每个附件的真实计数；不要重复调用 Tool 做重复校验，不做额外分析。
13. 本次 PrivateRadar 导入期间及导入后，除非用户明确要求记录记忆，否则不得创建或修改 `MEMORY.md`、WorkBuddy memory 日志或当日记忆文件；不得总结导入经验写入全局或用户记忆，尤其不得记录“下次扫描目录寻找 ZIP”之类的路径补救经验。

## 调用前的逐条时间检查（必须）

在调用导入 Tool 之前，必须先逐附件检查当前材料是否包含能够与每条消息可靠对应的原始时间。快速导入表示少交互、快速完成，不表示忽略材料中已经存在的时间。

- 原始微信或源材料直接显示了某条消息的时间：填写 `timestamp`，并标记 `timestamp_source: source_native`。
- 用户明确提供了某条消息的时间：填写 `timestamp`，并标记 `timestamp_source: user_supplied`。
- 没有时间或无法可靠对应到具体消息：省略 `timestamp` 和 `timestamp_source`；快速模式不以追问用户补时间为前置条件。
- 禁止用 `approximate_date`、`imported_at`、当前时间、消息顺序或正文中的“下午”“昨天”等措辞生成时间，也禁止人工生成等间隔时间。
- 原文只有本地日期与时分而未写时区时，`+08:00` 是系统采用的时区解释，不能称为原文字段。

## 群名不得推测

- 只有原文直接提供或用户明确提供的名称才可写入 `conversation_name`；分别标记 `source_native` 或 `user_supplied`。
- 不得根据正文、物业或机构落款、人名、地点、图片文件名、聊天主题或任何上下文推测群名。
- 不得生成、推荐、展示或要求用户从候选群名中选择。
- 原文和用户都未提供群名时，省略该字段直接调用对应 Tool；数据库中应保持空值及 `unknown` 来源。

## 不展示中间分析

- 最终可见回复中不得输出“我认为”“我猜”“让我判断”“我正在分析”或任何内部推理、检查过程。
- 不得输出“我先加载技能”“我先检查目录”“正在读取文件”等进度性中间回复。
- 当前附件和必需路径齐备时立即调用对应 Tool；不要解释计划、复述规则或再次征求确认。
- Tool 成功后，最终回复只保留一行导入结果，例如“导入成功：新增 8，重复 0，更新 0，无效 0。”

## 字段真实性

- `content` 只保存分享中的原文，不改写、不总结。
- `source_position` 按分享中的原始顺序从 0 开始。
- 分享直接提供的群名、发送人、时间才使用 `source_native`。
- 用户确认的群名使用 `user_supplied`。
- 用户未提供的发送人和时间保持缺失；不得用导入时间、图片文件名日期或当前时间伪造逐条 `timestamp`。

## 例外

- 群名、发送人和时间未知时可省略，直接调用对应 Tool。
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

两附件批量调用保持各自消息数组，不使用临时 ZIP 文件名充当来源身份：

```json
{
  "attachments": [
    { "source_zip_path": "C:\\Users\\用户\\.workbuddy\\app\\tmp\\chat-history\\甲.zip", "messages": [{ "content": "甲的原文", "source_position": 0 }] },
    { "source_zip_path": "C:\\Users\\用户\\.workbuddy\\app\\tmp\\chat-history\\乙.zip", "messages": [{ "content": "乙的原文", "source_position": 0 }] }
  ]
}
```
