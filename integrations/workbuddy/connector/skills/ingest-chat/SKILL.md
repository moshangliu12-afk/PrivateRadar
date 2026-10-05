---
name: privateradar-ingest-chat
display_name: PrivateRadar 微信聊天导入
description: 将当前输入中的一张或两张微信聊天卡片按确定性路径导入本机 PrivateRadar。
version: 0.2.0-alpha.16-skill.1
author: PrivateRadar
---

# PrivateRadar 微信聊天导入

当用户要求把当前分享的微信聊天导入 PrivateRadar 时，直接执行本流程。

正式路径只有两种：

- 一张聊天卡片：调用一次 `privateradar_ingest_messages`。
- 两张聊天卡片：把本次 current input 真实提供的全部 raw context blocks 原样传给 `privateradar_ingest_current_context_batch`，只调用一次。

## 一张聊天卡片

1. 只从当前卡片可见内容中提取消息，保持原始正文、可见 URL 和原始顺序。
2. 调用 `privateradar_ingest_messages`，使用 `import_mode: quick`。
3. 只有原文或用户明确提供群名时才传 `conversation_name`；缺失时省略。
4. 只有原文可靠提供发送人和逐条时间时才传相应字段；缺失时省略，不能补造。
5. `source_position` 按当前卡片中的原始顺序从 0 开始。

## 两张聊天卡片

用户分享两张微信聊天卡片并要求批量导入时：

1. 从本次 current input 取得平台真实提供的全部 raw context blocks。
2. 不按 raw context 数量判断附件数。WorkBuddy 可能重复序列化同一张卡片；不要自行去重。
3. 每个 raw context block 原样传递以下必填字段：
   - `file`
   - `extracted_dir_path`
   - `message_count`
   - `transcript`
4. 当前输入真实提供时，原样传递以下可选字段：
   - `first_sender`
   - `first_message_at`
   - `truncated`
5. 只调用一次 `privateradar_ingest_current_context_batch`，参数 `mode` 固定为 `current_context`。
6. Tool 负责 raw context normalization、逻辑附件归组、确定性 Parser、Directory Evidence 和导入。Skill 不承担这些职责。
7. Tool 必须最终得到恰好两个 logical attachments；数量不符、内容冲突、路径缺失、截断或解析失败时，以 Tool 的真实错误为准立即停止。

正式调用形状：

```json
{
  "mode": "current_context",
  "contexts": [
    {
      "file": "第一张卡片.zip",
      "extracted_dir_path": "平台明确提供的解压目录绝对路径",
      "message_count": 5,
      "transcript": "当前卡片内联提供的完整聊天正文",
      "first_sender": "原样可选值",
      "first_message_at": "原样可选值",
      "truncated": false
    },
    {
      "file": "第二张卡片.zip",
      "extracted_dir_path": "平台明确提供的解压目录绝对路径",
      "message_count": 5,
      "transcript": "当前卡片内联提供的完整聊天正文"
    }
  ]
}
```

## Collection ID 只显式转交

- 仅当本轮当前用户输入明确提供 `Collection <完整 UUID>`，或本次规范输入明确给出 `collection_id` 时，才在双卡参数顶层添加 `collection_id`，把该值原样传给 `privateradar_ingest_current_context_batch.collection_id`。
- 用户本轮没有显式提供时，省略 `collection_id`，不传空字符串或 null，沿用普通双卡导入。
- 禁止从旧聊天轮次寻找 Collection ID，禁止从最近一次导入复用，禁止从名称、群名、时间、正文或 PrivateRadar 当前页面状态猜测。
- 禁止修复、截断或补全 UUID；Collection identity 只认本轮明确提供的完整 UUID。
- 一张卡片同时要求加入 Collection 时，立即停止并报告 `COLLECTION_NOT_SUPPORTED_FOR_SINGLE_IMPORT`；不得降级成普通导入，不得自动转换成双卡链。
- Collection 只指定归属，不改变当前输入范围；仍只传本次 raw contexts，由现有 Tool 归组为恰好两个 logical attachments，不支持 N 卡。

## 时间真实性

- 原始材料直接提供且能与具体消息可靠对应的时间，使用 `timestamp_source: source_native`。
- 用户明确提供且能与具体消息可靠对应的时间，使用 `timestamp_source: user_supplied`。
- 没有可靠逐条时间时，省略 `timestamp` 和 `timestamp_source`。
- 禁止使用 ZIP 创建时间、WorkBuddy 接收时间、`imported_at`、文件名时间、当前时间、`source_position`、Evidence 时间、manifest 时间、mtime、ctime 或 birthtime 补造聊天时间。
- 原文没有时区时，解析得到的 `+08:00` 只能称为 system interpretation，不能称为原文提供的时区。

## 群名和发送人真实性

- 群名、发送人只接受原文直接提供或用户明确提供的值。
- 缺失时省略，不传字符串 `"unknown"`。
- 禁止根据正文、人名、机构、地点、文件名或聊天主题补造 sender、group 或 `conversation_name`。

## 强制禁止项

- 禁止调用 `privateradar_ingest_batch`。
- 禁止把双卡片拆成两次 `privateradar_ingest_messages`。
- 禁止自行解析双卡片 `transcript`，禁止自行生成双卡片 `messages` 数组。
- 禁止自行去重 raw contexts、计算 attachment identity 或判断 `raw count == 2`。
- 禁止读取 `聊天记录.txt` 替代 current input 中的 inline transcript。
- 禁止用 `ls`、`dir`、`glob`、`find` 或其他方式列举、扫描 `chat-history`。
- 禁止寻找 newest file、newest directory，禁止 filename → path guess、mtime guess、timestamp guess。
- 禁止扫描 WorkBuddy 历史附件、历史对话或日志来定位附件。
- 禁止猜测 ZIP path，禁止根据显示文件名拼接真实路径。
- 禁止使用脚本、Harness、stdio、JSON-RPC 或手动运行 `server.mjs` 作为替代通道。
- 禁止主动创建或修改 `MEMORY.md`、WorkBuddy memory 或 daily memory。
- 禁止自动 retry batch。
- 第一次批量调用失败后，禁止改用 legacy batch，禁止拆成两个 single，禁止任何自动重试。

第一次批量调用失败时，立即停止，只报告 Tool 返回的真实错误。

## 回复规则

- Tool 成功后，只报告整次导入与各附件的真实新增、重复、更新、无效和失败数量。
- 不重复调用 Tool 做校验，不追加话题分析，不写记忆。
- 示例：`批量导入完成：附件 2/2，新增 10，重复 0，更新 0，无效 0。`
