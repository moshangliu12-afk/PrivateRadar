# WorkBuddy → PrivateRadar Connector Spike

验证日期：2026-09-13  
WorkBuddy 版本：5.5.5  
范围：仅验证 WorkBuddy 调用本机 PrivateRadar MCP Tool，以及当前上下文中的结构化聊天消息能否写入。未开发正式产品功能，未读取微信数据库，未使用 Hook、私有 API、抓包、wx-cli 或 WeFlow。

## 最终状态

**PARTIAL**

- `LOCAL_MCP_VERIFIED`：已验证。
- `WORKBUDDY_CONNECTOR_RECOGNIZED`：已验证。
- `WORKBUDDY_INVOCATION_VERIFIED`：已验证一次真实 WorkBuddy 自然语言调用。
- `CURRENT_CONTEXT_TO_PRIVATERADAR_VERIFIED`：已用人为制作的非敏感微信聊天文本验证。
- `WECHAT_SYSTEM_SHARE_ENTRY_NOT_VERIFIED`：未通过微信或 Windows 系统分享入口实际发送聊天记录，因此不能宣称完整的“微信分享 → PrivateRadar”链路已经验证。
- `SKILL_PACKAGE_CREATED_NOT_INSTALLED`：已按官方目录格式建立 Skill；真实调用使用 WorkBuddy 自定义 MCP 配置与 Tool 描述完成，未单独安装或验证该 Skill 包。

## 1. 官方能力核对

### 官方明确支持

1. WorkBuddy 连接器支持 MCP + Skill，并将其列为已有 API 服务或可开发 MCP Server 时的推荐方式。
2. 本地 MCP Server 可以使用 `stdio`；`mcp.json` 支持 `command`、`args`、`cwd`、`runtime`、`timeout` 等公开字段。
3. MCP Tool 应提供清晰稳定的名称、描述、参数、返回值和可读错误，单次调用建议在 30 秒内返回。
4. MCP 已有清晰标准工具描述时，Skill 是可选项；Skill 可补充调用时机、参数、错误处理和安全确认规则。
5. WorkBuddy 客户端支持“自定义连接器”，可在 MCP 服务管理中配置自定义 MCP Server。
6. WorkBuddy 5.5.0 更新日志明确写有：Windows 和 macOS 系统分享入口支持将微信聊天记录发送到 WorkBuddy。
7. 第三方应用与 Local Assistant API 属于另一条 OAuth 2.1 + HTTPS Open API 路线，可向本地助理发送文本及读取助理消息历史；本 Spike 没有使用这条路线，也没有申请 OAuth 权限。

官方来源：

- [WorkBuddy 连接器开发文档](https://open.workbuddy.cn/docs/connector)
- [WorkBuddy 用户文档：连接器与自定义连接器](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Connector)
- [WorkBuddy 第三方应用](https://open.workbuddy.cn/docs/third-party-app)
- [WorkBuddy Open API](https://open.workbuddy.cn/docs/openapi)
- [WorkBuddy 5.5.0 更新日志](https://www.workbuddy.cn/docs/workbuddy/Changelog)
- [MCP 官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

### 官方没有承诺

1. 没有发现官方承诺 Connector 可以主动读取微信数据库、微信内存或任意微信历史；这些能力不在本 Spike 范围内。
2. 更新日志只确认微信聊天记录能够通过系统分享入口进入 WorkBuddy，没有承诺分享上下文一定保留群名、每条发送人、原始时间、URL 或严格顺序。
3. 没有发现官方承诺 MCP Connector 能直接收到“微信分享事件”的原始结构化载荷；公开路径是先进入 WorkBuddy 上下文，再由 Agent 决定是否调用 Tool。
4. 本地自定义 MCP 配置与市场连接器包不是同一验证层级；市场提交、审核、OAuth 和第三方应用发布均未验证。

### 验证前假设

1. WorkBuddy 5.5.5 能使用官方自定义 MCP 配置连接本地 `stdio` Server。
2. Tool 的参数描述足以让 WorkBuddy 从当前提示中的聊天文本构造 `messages` 数组。
3. 使用现有 PrivateRadar JSON Adapter、标准化、指纹与 SQLite 导入流程，可以避免建立第二套数据库或去重逻辑。

以上三项均在限定场景下得到验证。

## 2. 最小 MCP Server

独立模块位于 `src/main/integrations/workbuddy/`，没有修改 Daily Intelligence、Topic Radar 或搜索算法。

唯一 Tool：`privateradar_ingest_messages`

输入为 `messages` 数组，每条支持：

- `platform`
- `conversation_name`
- `sender_name`
- `timestamp`
- `content`
- `source_message_id`，可选

处理链路：

`MCP Tool → 现有 JSON Adapter → normalizeMessage → Standard Message → fingerprint / source_message_id 去重 → 现有 SQLite 与 FTS`

Tool 返回结构化统计：`status`、`recognized_count`、`imported_count`、`duplicate_count`、`invalid_count` 和有限错误列表。单次最多接收 500 条，少量坏数据不会让整批失败。

连接器样例位于 `integrations/workbuddy/connector/`，包含官方格式的 `connector-meta.json`、`mcp.json`、`icon.svg` 和 `skills/ingest-chat/SKILL.md`。服务使用 MCP 官方 TypeScript SDK 2.0.0 构建为独立 `stdio` 文件。

## 3. 本地 MCP Harness 结果

使用 MCP 官方客户端经真实 `stdio` 子进程发现并调用 Tool：

| 调用 | 有效识别 | 新增 | 重复 | 无效 | 状态 |
| --- | ---: | ---: | ---: | ---: | --- |
| 第一次，4 条正常 + 1 条坏数据 | 4 | 4 | 0 | 1 | partial |
| 第二次，完全相同参数 | 4 | 0 | 4 | 1 | partial |

数据库最终保持 4 条。URL `https://github.com/example/claude-code-demo` 被保存到现有 `message_links` / `links_json`，FTS 可检索 `GitHub`，现有“问我的聊天”搜索能够找到王五分享的仓库。

## 4. WorkBuddy 实际调用结果

### Connector 识别

本机 WorkBuddy 5.5.5 读取官方配置文件 `C:\Users\Example\.workbuddy\mcp.json` 后：

1. MCP 服务管理显示 `privateradar-local-spike`。
2. 首次连接显示官方“信任”确认。
3. 确认后状态变为“1 启用”，不再显示失败。

### 自然语言调用

向 WorkBuddy 当前上下文提供 4 条人为制作的非敏感测试微信消息，并明确要求调用 `privateradar_ingest_messages`。WorkBuddy 实际完成调用并报告：

- 新增：4 条
- 重复：0 条
- 无效：0 条

随后检查目标 SQLite：4 条消息全部存在，群名、发送人、时间、正文、URL 和顺序均与提示一致；`source_message_id` 为 `workbuddy-live-001` 至 `workbuddy-live-004`。

WorkBuddy 首次调用后仍有后台进程。为避免强制结束可能承载用户会话的进程，没有再次从 GUI 启动第二个 WorkBuddy 实例。改用 MCP 官方客户端，对同一实际数据库重放完全相同的 4 条参数：

- 新增：0 条
- 重复：4 条
- 数据库仍为 4 条
- FTS 命中：1 条
- `PRAGMA quick_check`：`ok`

因此 Tool 与数据库层的重复调用安全已经验证；“第二次调用由 WorkBuddy GUI 发起”没有单独验证，不将其写成已验证事实。

## 5. 微信分享上下文核对

本轮验证的是“当前 WorkBuddy 上下文包含人为制作的微信聊天文本”，不是从微信客户端或 Windows 分享入口发起的真实分享动作。

| 字段 | 当前上下文测试 | 微信系统分享入口 |
| --- | --- | --- |
| 群名 | 可获得，`AI开发群` | 未验证 |
| 发送人 | 可获得，张三/李四/王五/赵六 | 未验证 |
| 原始时间 | 可获得并标准化，分钟与顺序正确 | 未验证 |
| 正文 | 可获得，原文写入 | 未验证 |
| URL | 可获得并保存 | 未验证 |
| 消息顺序 | 可获得，数据库顺序正确 | 未验证 |

这意味着验证 B 已成立：只要必要字段确实存在于当前上下文，WorkBuddy 能结构化后调用 PrivateRadar Tool。真实微信系统分享是否提供这些字段仍需一份由用户主动分享的测试素材才能判断。

## 6. 自动测试与安全边界

新增自动测试覆盖：

1. MCP Tool 可发现并正常接收消息。
2. Standard Message 转换。
3. URL 与来源消息 ID 保留。
4. fingerprint / source_message_id 去重。
5. 少量无效消息容错。
6. 重复调用幂等。
7. 写入现有 SQLite。
8. FTS 与现有搜索可检索。

最终回归结果：`npm test` 共 8 个测试文件、92 项测试全部通过；原有 89 项无回归。`npm run build` 通过，包含 TypeScript 类型检查、Electron production 构建和独立 MCP Server 构建。

没有写入 API Key，没有日志记录聊天隐私数据，没有申请 OAuth，没有修改 WorkBuddy 或微信。测试数据全部为人为制作内容。

## 7. 技术结论

核心路线可行：WorkBuddy 可以通过官方本地 MCP 配置识别并自然语言调用 PrivateRadar `stdio` Tool；当聊天记录已经位于当前上下文并包含必要字段时，可以写入现有数据库并保持幂等。

当前最大障碍不是 MCP，而是微信系统分享上下文的数据完整性尚未实际验证。正式开发 WorkBuddy Adapter 之前，建议先用一份用户主动分享的非敏感测试群聊，确认 WorkBuddy 实际收到的群名、发送人、原始时间和顺序；若字段缺失，再决定是否接受降级或停止，不应绕过微信或 WorkBuddy 平台限制。

## 8. 真实微信系统分享复验记录（2026-09-13）

本次真实分享会话未完成“WorkBuddy GUI 调用 MCP Tool”的验收。技术日志显示两层原因：

1. 原连接在会话动态配置重建时被 WorkBuddy 删除并立即重启，旧的手工 `server.connect(new StdioServerTransport())` 入口在重连阶段以 `MCP error -32000: Connection closed` 退出。
2. 服务端改为 MCP 官方 `serveStdio` 生命周期入口、增加固定 `cwd` 和独立数据库后，`mcp.json` 内容变化导致 WorkBuddy 的安全审批哈希变化。WorkBuddy 日志持续记录 `skipping untrusted server "privateradar-local-spike"`，因此 Tool 没有被索引到本次真实分享会话。

服务端已改用 `serveStdio(..., { legacy: 'serve' })`，并增加不记录聊天正文的生命周期日志；本地连续两次连接、Tool 发现与关闭均正常。新的配置必须在 WorkBuddy GUI 中按官方信任提示重新批准，批准前不能视为连接恢复。

本次会话随后使用工作区脚本直接驱动 `server.mjs`，这不满足“必须由 WorkBuddy GUI 实际调用”的验收条件。只读核对确认目标 SQLite 中有 8 条消息，导入任务 `9b56dac2-4c47-44fd-bb67-532c74912499` 统计为新增 8、重复 0、无效 0，`PRAGMA quick_check` 为 `ok`；这些只能证明脚本直连落库成功，不能证明 Connector 调用成功。本轮按要求不进行第二次导入，结论保持 `PARTIAL`。

### GUI 重新批准后的最终干净复测

用户在 WorkBuddy GUI 中重新批准配置哈希 `0dea79d0a6f1c6c542b8c928e8dee8ee467359a180d661ce9f8efd76b8aa1205` 后，连接器进入当前微信系统分享会话索引。清空目标库后仅执行一次自然语言导入，WorkBuddy 会话日志明确记录：

- `executeMcpTool: tool=mcp__privateradar-local-spike__privateradar_ingest_messages`
- `serverName=privateradar-local-spike`
- `directHit=true`

目标 SQLite 随后产生唯一导入任务 `2103c577-97f6-4086-b74c-5b1485da6246`：识别 8、新增 8、重复 0、无效 0、状态 `success`；消息总数为 8，`PRAGMA quick_check` 为 `ok`。本次没有使用脚本、Harness、直接 JSON-RPC 或手动启动 `server.mjs` 代替 WorkBuddy 调用，也没有执行第二次导入。

最终链路已验证：`微信系统分享 → WorkBuddy GUI → privateradar_ingest_messages → SQLite`，Spike 状态更新为 `SUCCESS`。

### fingerprint 补全风险

当前无可靠 `source_message_id` 时，fingerprint 明确包含平台、群名、发送人、标准化时间和正文。以后把“我/对方”或推测时间补成真实发送人、真实时间，会得到新 fingerprint，并作为新消息插入；普通重新导入不会原地更新旧记录。若需要补全，必须另行设计可审计的来源映射或显式更新流程，不能把重新导入当作更新机制。
