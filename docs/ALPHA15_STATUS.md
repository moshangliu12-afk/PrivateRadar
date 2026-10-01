# PrivateRadar alpha.15 开发状态

截至 2026-10-01，状态为 **READY TO BUILD ALPHA.15 RC**（`READY_TO_BUILD_ALPHA15_RC`）。产品版本为 `0.2.0-alpha.15`，源码准备与测试稳定性审计完成；尚未制作 RC 安装包、执行安装版迁移验收或正式发布。用户正式环境继续使用 `0.2.0-alpha.14.1`。

## 已完成阶段

| 阶段 | 内容 | 提交 / 结果 |
| --- | --- | --- |
| Step 5G | 确定性 WorkBuddy 聊天文本输入契约 | `a30c9a2042e9c3f592286fac8e65e2a9a00be6ad` |
| Step 5H | 目录证据持久化与校验 | `c9c1b302b6bcb09e4bf128d333e09816773c815f` |
| Step 5I | 当前上下文双附件集成 | `ee73f525594a1d72ee456c23d0fb90a288b54675` |
| Step 5J | 真实 WorkBuddy 双卡验收、随后回滚 | `PASS_WITH_ISSUE`，随后 `ROLLBACK_VERIFIED` |
| Step 5K | alpha.14.1 维护修复前向合入 | 见下方三个提交 |
| Step 5L-B | 正式工具、Skill 与安全部署打包契约 | `74fc0c7d9bf7e6c43bec791f6a1907d902e8f556` |
| Step 5L-C | 版本元数据与 RC 文档准备 | 产品、Connector、MCP 版本统一；发布说明、已知问题、用户指南与检查表完成 |
| Step 5L-C.1 | 测试稳定性审计 | `TEST_STABILITY_FIXED`；最新全量 582 项通过、4 项既有跳过、0 项失败 |
| Step 5L-C.2 | 状态同步与检查点提交核验 | 本检查点固化 RC 准备及确定性测试修复，不制作安装包 |

Step 5K 提交：

- `436c1aa220e70dcd2b7f18552c5f19c5c8a42aa2`
- `f569302f25eb670603d937621852ce65081b76d6`
- `4973517d6244917cfffeb1a9b92ca4eab906023b`

## 真实验收与边界

Step 5J 同次两张卡片：Card A 5 条、Card B 5 条，共 10 条消息、10 条 FTS 记录、1 个会话、2 个附件项、2 个任务、2 个来源批次和 2 套目录证据。结果为 `PASS_WITH_ISSUE`，随后完成 `ROLLBACK_VERIFIED`；隔离验收证据已保留，本文件不收录真实聊天正文或本机验收绝对路径。

当前正式设计：当前上下文 → 原始上下文 → 输入门禁 → 恰好 2 个逻辑附件 → 确定性解析 → 目录证据 → 各自独立的附件项、任务和来源批次。重复序列化可以令原始上下文数量大于逻辑附件数量；冲突重复输入拒绝导入，不扫描目录或猜测历史附件。

正式公开工具仅为 `privateradar_ingest_messages` 与 `privateradar_ingest_current_context_batch`。`privateradar_ingest_batch` 仅保留内部兼容实现、处理器、ZIP 证据与测试，不公开给 Agent 或 UI。

产品、Connector 和 MCP 版本对齐 `0.2.0-alpha.15`；两份正式 Skill 保持字节同步的 `0.2.0-alpha.15-skill.3`。官方旧 Skill 安全升级、自定义 Skill 保留与原子替换契约已在 Step 5L-B 完成。

## RC 验证与已知问题

Step 5L-B 基线：574 项测试通过、4 项跳过、0 项失败；类型检查、生产构建、Connector 构建与差异空白检查通过。不将该历史基线视为本轮结果。

最新验证基线为 Step 5L-C.1：全量 582 项通过、4 项既有跳过、0 项失败；35 个文件中 32 个通过、3 个跳过，耗时 410.50 秒。类型检查、生产构建、Connector 构建与差异空白检查通过。版本、Tool、Skill、部署与 first-use 专项 54 项通过，包含 8 项版本契约测试。

此前跨月搜索断言确认为 `NON_DETERMINISTIC_TEST`，而非生产 Search 回归。仅在测试共享 fixture 创建前固定 `Asia/Shanghai` 时区与 `2026-09-29T12:00:00+08:00` 参考时间，结束后恢复真实时钟与原时区；保留空结果断言。单项、全文件、Search 专项、跨启动时区与全量均通过，生产 Search 未修改，没有确认相关产品回归。

此前双卡显式同项重放超时归类为 `TRANSIENT_TIMEOUT_NOT_REPRODUCED`：连续五次单项、整文件 34 项、当前上下文 / Parser / Gate 组合 148 项、Batch / Evidence 组合 172 项和全量均通过。120 秒上限未调整，未加等待或重试包装，未发现新增临时目录或原生辅助进程残留；不把尚未确认的资源竞争当作已证实根因。

中文明确日期搜索漏召回、多行消息末尾单个换行裁剪已记录为 `NON_BLOCKING_KNOWN_ISSUE`，见 [已知问题](../KNOWN_ISSUES.md)；本轮不修复。

RC 安装包尚未制作；全新安装、alpha.14.1 到 alpha.15 的 212 条消息隔离升级、安装版真实工具列表、双卡链路、重启恢复与备份回滚尚待执行，见 [RC 检查表](../ALPHA_RELEASE_CHECKLIST.md)。不宣称任意数量附件、OCR、PDF 正文解析、语义检索、微信数据库直读、macOS 或所有去重情况已验证。
