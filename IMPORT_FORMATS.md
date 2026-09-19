# PrivateRadar 文件导入格式

阶段 C 有意采用小而稳定的格式约定。三种文件中的每条消息都会先转换成 `StandardMessage`，不会直接写入后续系统。

## 公共字段

必填信息：

| 含义 | 推荐字段 | 兼容字段 |
|---|---|---|
| 群名 | `conversation_name` | `conversationName`、`chat_name`、`chatName`、`group_name`、`groupName`、`group` |
| 发送人 | `sender_name` | `senderName`、`sender` |
| 时间 | `timestamp` | `time`、`datetime` |
| 正文 | `content` | `text`、`message` |

可选信息：

- `message_id`：来源提供的稳定消息编号。也兼容 `messageId`、`source_message_id`、`sourceMessageId`、`id`。
- `platform`：来源平台，省略时为 `local-file`。
- `conversation_id`、`sender_id`：来源提供的群和发送人编号。
- `message_type`：省略时根据是否含链接判断为 `text` 或 `link`。
- `links`、`attachments`、`reply_to`。

时间推荐使用带时区的 ISO 8601，例如 `2026-09-12T10:20:00+08:00`。`YYYY-MM-DD HH:mm:ss` 也可使用，系统按中国标准时间 `+08:00` 解释。

## JSON

支持消息数组：

```json
[
  {
    "message_id": "m-001",
    "conversation_name": "示例群",
    "sender_name": "林舟",
    "timestamp": "2026-09-12 10:20:00",
    "content": "这是一条消息"
  }
]
```

也支持 `{ "messages": [...] }`。单条坏记录只计入无效数；整个 JSON 语法损坏时任务失败并留下失败记录。

## CSV

第一行必须是表头，至少包含群名、发送人、时间和正文对应字段。字段可以使用双引号；正文中的逗号、换行和双引号按标准 CSV 转义处理。

```csv
message_id,conversation_name,sender_name,timestamp,content
m-001,示例群,林舟,2026-09-12 10:20:00,"正文可以包含,逗号"
```

## TXT

支持两种行格式。

第一种是制表符分隔，最后的消息编号可省略：

```text
timestamp<TAB>conversation_name<TAB>sender_name<TAB>content<TAB>message_id
2026-09-12 10:20:00<TAB>示例群<TAB>林舟<TAB>这是一条消息<TAB>m-001
```

第二种适合人工阅读：

```text
[2026-09-12 10:20:00] 示例群 | 林舟：这是一条消息
```

空行、以 `#` 开头的注释和标准表头会被忽略。不符合格式的非空行计入无效消息。

## 示例文件

- `examples/demo-chat.json`
- `examples/demo-chat.csv`
- `examples/demo-chat.txt`

单个文件当前限制为 50 MB。建议大文件按月份拆分；时间范围可以重叠，系统会自动去重。
