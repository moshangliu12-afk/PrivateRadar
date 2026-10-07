---
name: privateradar-ingest-chat
display_name: PrivateRadar 微信聊天导入
description: 将当前输入中的一张或两张微信聊天卡片按确定性原始来源路径导入本机 PrivateRadar。
version: 0.2.0-alpha.18-skill.1
author: PrivateRadar
---

# PrivateRadar 微信聊天导入

当用户要求把当前分享的微信聊天导入 PrivateRadar 时，使用本流程。

## 单卡与双卡统一入口

一张或两张聊天卡片都把本次当前输入真实提供的全部原始上下文块，原样传给 `privateradar_ingest_current_context_batch`，只调用一次。

- 正式快速导入只接受原始当前上下文，不接受由 Agent 提取或重建的 `messages`。
- `privateradar_ingest_messages` 是已停用的公开旧入口，会拒绝仅含规范消息的调用；禁止调用或降级到该入口。
- 当前上下文入口保持快速导入，不增加 `complete`、元数据补全或未知时间解析能力。

## 原始上下文转交

1. 从本次当前输入取得平台真实提供的全部原始上下文块；单卡与双卡使用相同流程。
2. 不按原始上下文数量判断附件数。WorkBuddy 可能重复序列化同一张卡片；不要自行去重。
3. 每个原始上下文块原样传递以下必填字段：
   - `file`
   - `extracted_dir_path`
   - `message_count`
   - `transcript`
4. 当前输入真实提供时，原样传递以下可选字段：
   - `first_sender`
   - `first_message_at`
   - `truncated`
5. 只调用一次 `privateradar_ingest_current_context_batch`，参数 `mode` 固定为 `current_context`。不要添加 `messages`、`import_mode`、批次身份或推导的来源字段。
6. 工具负责原始上下文归组、确定性解析、目录证据和导入。Skill 不承担这些职责，不改写正文、发送人、原始时间、换行或顺序。
7. 工具归组后只接受一个或两个逻辑附件，每个附件 1–500 条消息；不支持任意数量卡片。
8. 原始字段缺失、路径不可用、截断、副本冲突、数量不符或解析失败时，立即停止，只报告工具返回的真实错误；不得改用规范消息、旧入口或脚本。

正式调用形状：

```json
{
  "mode": "current_context",
  "contexts": [
    {
      "file": "当前卡片.zip",
      "extracted_dir_path": "平台明确提供的解压目录绝对路径",
      "message_count": 5,
      "transcript": "当前卡片内联提供的完整聊天正文",
      "first_sender": "原样可选值",
      "first_message_at": "原样可选值",
      "truncated": false
    }
  ]
}
```

示例只展示一份原始上下文。实际调用必须传递本次全部原始上下文块，不为凑足数组数量复制或删除块；附件数量由工具归组决定。

## Collection ID 只显式转交

- 仅当本轮当前用户输入明确提供 `Collection <完整 UUID>`，或本次规范输入明确给出 `collection_id` 时，才在参数顶层添加 `collection_id`，把该值原样传给 `privateradar_ingest_current_context_batch.collection_id`。
- 用户本轮没有显式提供时，省略 `collection_id`，不传空字符串或 null。
- 禁止从旧聊天轮次寻找 Collection ID，禁止从最近一次导入复用，禁止从名称、群名、时间、正文或 PrivateRadar 当前页面状态猜测。
- 禁止修复、截断或补全 UUID；归集身份只认本轮明确提供的完整 UUID。
- 一张卡片同时要求加入 Collection 时，立即停止并报告 `COLLECTION_NOT_SUPPORTED_FOR_SINGLE_IMPORT`；不得降级成普通导入，不得自动转换成双卡链。
- 归组后仅有一个逻辑附件但传入 `collection_id` 时，以工具的同一拒绝结果为准，不移除归集编号后再次调用。
- Collection 只指定归属，不改变当前输入范围；仅两个逻辑附件支持归集，不支持单卡归集或任意数量卡片。

## 时间真实性与严格解析

- 原文的发送人、逐条完整日期与时分由现有确定性解析器读取，Skill 原样传递 `transcript`。
- 没有可靠逐条时间时，当前解析器拒绝输入；不能省略时间后改走旧单卡入口，不能补造时间。
- 禁止使用 ZIP 创建时间、WorkBuddy 接收时间、`imported_at`、文件名时间、当前时间、`source_position`、Evidence 时间、manifest 时间、mtime、ctime 或 birthtime 补造聊天时间。
- 原文没有时区时，解析得到的 `+08:00` 仅是系统解释，不能称为原文提供的时区。
- `source_native` 与 `user_supplied` 等来源标记由既有解析和导入逻辑保存；Skill 不添加或改写消息时间来源。

## 群名和发送人真实性

- 发送人只接受原始文本明确提供的值，不能用正文中的“我”或其他人名推断。
- 群名缺失时保持未知，不从文件名或主题补齐，不添加当前工具未声明的字段。
- 禁止根据正文、人名、机构、地点、文件名或聊天主题补造 sender、group 或 `conversation_name`。
- 不添加字符串 `"unknown"` 作为事实元数据。

## 强制禁止项

- 禁止调用 `privateradar_ingest_batch`。
- 禁止调用 `privateradar_ingest_messages`，禁止仅传规范消息的降级。
- 禁止把双卡片拆成两个调用。
- 禁止自行解析单卡或双卡 `transcript`，禁止自行生成 `messages` 数组。
- 禁止自行去重原始上下文、计算附件身份或用原始块数量决定卡片数量。
- 禁止读取 `聊天记录.txt` 替代当前输入中的内联原始文本。
- 禁止用 `ls`、`dir`、`glob`、`find` 或其他方式列举、扫描 `chat-history`。
- 禁止寻找最新文件或目录，禁止根据显示文件名、修改时间或聊天时间猜测路径。
- 禁止扫描 WorkBuddy 历史附件、历史对话或日志来定位附件。
- 禁止猜测 ZIP 路径，禁止根据显示文件名拼接真实路径。
- 禁止使用脚本、Harness、stdio、JSON-RPC 或手动运行 `server.mjs` 作为替代通道。
- 禁止主动创建或修改 `MEMORY.md`、WorkBuddy 记忆或每日记忆。
- 禁止自动重试；第一次调用失败后禁止改用旧入口、拆卡或任何自动重试。
- 禁止回溯旧的单卡消息补造附件项、原始证据、来源关联或承诺候选。

第一次调用失败时，立即停止，只报告工具返回的真实错误。

## 回复规则

- 工具成功后，只报告整次导入与各附件的真实新增、重复、更新、无效和失败数量。
- 不重复调用工具做校验，不追加话题分析，不写记忆。
- 示例：`导入完成：附件 1/1，新增 5，重复 0，更新 0，无效 0。`
