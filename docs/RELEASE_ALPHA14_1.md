# PrivateRadar 0.2.0-alpha.14.1 维护版本说明

## 发布范围

本版本基于正式 `0.2.0-alpha.14`，仅包含以下维护修复：

- 聊天日期只使用可靠原始时间，未知时间不再通过导入时间归入 Home、Settings、Daily、Topic 或 Search 的聊天日期。
- Daily 历史缓存校验时间来源，仅使受影响的结果失效并按新规则重建。
- Search 忽略空会话名称，不生成错误名称过滤或破坏查询正文。
- Search 忽略纯标点、纯符号名称；含 Unicode 字母或数字的合法名称继续参与查询理解。

未知原始聊天时间继续保存为 `timestamp = null`、`timestamp_source = unknown`。导入时间保持独立语义，不用于补造聊天时间。普通 Search 仍可找回未知时间消息，明确日期的可靠结果排除这些消息。

## 唯一保留的已知问题

某些纯中文明确日期查询可能因日期字面量仍参与内容查询，导致可靠消息漏召回。这是正式 alpha.14 已存在的问题，本次维护发布不修改它，也不因此阻止发布。

## 版本与组件边界

产品版本及锁文件根版本为 `0.2.0-alpha.14.1`；Electron、Settings 和 Windows 安装器从产品版本读取版本信息。

WorkBuddy Connector 和 Skill 保持 alpha.14 体系，其独立组件版本不随产品维护版本机械替换。本版本不包含 alpha.15 Batch Tool、Evidence 持久化、Path Handoff 或批量 UI。

## 发布前验证

2026-09-28 已完成：

- 完整测试 279 项、21 个测试文件全部通过，类型检查、生产构建、Connector 构建及差异检查通过。
- 使用项目现有 `npm run dist:win` 流程生成 Windows x64 NSIS 安装器。
- 真实安装至独立目录，安装器退出码为 0；正式产品登记、快捷方式和安装缓存恢复，正式应用及 Connector、Skill 文件哈希不变。
- 已安装应用使用独立 userData 和新的 SQLite 在线备份，Settings 显示 `0.2.0-alpha.14.1`。
- Home 默认 `2026-09-27`、当日消息 7 条，Settings 数据最新至 `2026-09-27`。
- `Claude-Sonnet-5` 与“资格认证”各命中 1 条真实消息，后者显示“时间未提供”，不标记可靠时间；应用正常退出，退出码为 0。
- 真实安装后的 Connector 仅注册 `privateradar_ingest_messages`；Skill 与 alpha.14 标签一致，未包含 alpha.15 实验工具、表和批量 UI。
- 正式库消息、全文索引、导入任务、来源批次维持 212、212、25、23；业务表行内容哈希保持不变，既有 Connector 心跳独立更新。

## 安装器信息

- 文件：`release/PrivateRadar-Setup-0.2.0-alpha.14.1-x64.exe`
- 大小：116,728,924 字节。
- SHA-256：`4c74aa58b6b8a096b25971e51c4c640a8c102b15a3fadd39733d2d6e2547660d`
- 生成时间：`2026-09-28 16:51:24 +08:00`。

本轮仅准备版本、构建并验收安装器、提交发布元数据。正式 alpha.14 标签保留，维护版本尚未创建标签或对外发布。
