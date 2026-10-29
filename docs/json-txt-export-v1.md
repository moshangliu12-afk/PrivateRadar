# JSON 与 TXT 导出 V1

基线为已通过真实桌面验收的 Markdown Export 提交 `709d017a9af2be851e3bd68a351e9c4a1a6e70b1`。在设置页原导出面板中选择会话，再选择 Markdown、JSON 或 TXT；默认仍是 Markdown，目录选择和开始、取消、打开目录流程保持原样。

## 共用实现

聊天选择核心和 Markdown renderer 的文件字节保持不变。新增两个 renderer 和一个格式分发适配器，直接使用同一个不可变规范快照。复用现有 `exportProjection`、规范 JSON 摘要、内容哈希、文件名、路径租约、独占 staging、原子不替换发布、版本冲突、取消和错误处理。没有第二套数据库读取或文件发布管线。

Markdown 的正文、选择摘要和目录身份不变；新元数据增加明确格式与通用输出摘要，保留原 `markdown` 字段。旧元数据未带新字段时，仍可原位核验并复用，不写回旧文件。

JSON 和 TXT 的选择摘要在同一个投影中加入格式和渲染版本，避免三种格式互相复用错误。继续采用同样的目录结构，分别生成 `聊天.md`、`聊天.json` 或 `聊天.txt`，每个目录同时有核验元数据 `export.json`。JSON 聊天正文与元数据不是同一个文件。

## JSON 契约

顶层包含导出版本、导出时间、应用版本、会话身份及名称三层语义、消息数、选择范围、系统捕获时区、消息、必要来源与 Evidence 登记引用。

消息采用稳定字段顺序，包含身份、会话身份、来源名称及 provenance、发送人身份和可靠名称、时间、消息类型、完整正文、来源批次及位置、已有附件类型占位。可选缺失值统一用 `null`，附件或引用列表缺失时用空数组，不猜名称、时间或附件内容。

`timestamp` 仅使用核心已确认可靠的规范时间；`storedTimestamp` 是数据库保存的原时间字符串，配套 `timestampSource`，不冒充未经转换的原始输入。未知可靠时间为 `null`。来源 occurrence 继续带各自 provenance；不可靠名称不充当来源事实。

`conversation.sourceConversationName` 保留来源事实，`userConversationLabel` 保留用户设置，`displayConversationName` 是现有 resolver 的结果。两者为空时只有 display 为“未知会话”，source 仍为 `null`。

这是结构化聊天导出，不是 SQLite dump，也不是完整 Evidence 或附件备份。不导出表结构、FTS、原始内部 metadata、数据库文件路径或附件机器路径。用户消息正文中原本存在的路径文本属于原文，保持不变。

## TXT 契约

顶部为会话显示名、导出时间、数量、范围和时区，按已有日期分组，再显示时间、发送人和完整正文。使用普通文本分隔线，不生成 Markdown 标题、加粗、围栏或链接语法。原文自己包含的 Markdown 字符不会被删除或改写。

中文、emoji、空白、CRLF、换行及 URL 保留。未知时间和发送人使用明确展示占位；图片、文件或语音只使用现有登记类型的可读占位，不复制或探测实际附件。

## 安全与范围

三种格式均先完整写入并核验 staging，再一次原子发布；同数据完整导出保留，用户改写、缺失或损坏时创建新版本，不覆盖原文件。原数据库、消息关系、Evidence、FTS 和名称字段不写回，不创建第二运行数据库，不修改 schema、依赖或 Conversation Label 产品逻辑。

继续使用既有 Windows 本地固定 NTFS 输出范围和容量上限。新格式适配器限制输出和元数据字节总量，超限明确失败，不截断正文。

本轮运行 JSON/TXT 专项、格式发布及 UI/IPC 测试，Export Core、Markdown 与 Conversation Label 必要回归，类型检查、构建及 MCP 构建。随后交付独立 Windows 目录候选，真实桌面验收仍由用户在完整备份并复制校验后完成。不运行完整 Windows WorkBuddy P0，不发布、不升级版本、不进入下一功能。
