# PrivateRadar alpha.15 RC 发布检查表

目标版本：`0.2.0-alpha.15`；目标平台：Windows 11 x64。本文件是检查表，不是安装版验收通过声明。正式用户仍使用 `0.2.0-alpha.14.1`。

## 源码准备

- [x] 产品、lockfile 根包、Connector 与 MCP 版本统一为 `0.2.0-alpha.15`。
- [x] 两份正式 Skill 保持 `0.2.0-alpha.15-skill.3`，不重新设计或递增。
- [x] 正式公开工具仅为单卡与当前上下文双卡；旧批量工具保留内部兼容，不公开。
- [x] 用户级官方 Skill 安全升级、自定义 Skill 保留与原子替换的部署专项通过。
- [x] 发布说明、已知问题、用户指南与当前状态文档更新。
- [x] 版本、Tool exposure、Skill 契约、部署与 first-use 专项：54 项通过，含 8 项版本一致性测试。
- [x] 跨月 Search 测试采用确定性时钟隔离，单项、全文件、跨启动时区及 Search 专项通过。
- [x] 双卡显式重放连续五次单项及三组组合复测通过，未提高 120 秒上限。
- [x] 最新源码全量：582 项通过、4 项既有跳过、0 项失败；35 个文件中 32 个通过、3 个跳过。
- [x] 类型检查通过。
- [x] 生产构建通过，不包含 installer 打包。
- [x] Connector 构建通过。
- [x] 差异空白检查通过。

当前状态为 `READY_TO_BUILD_ALPHA15_RC`，最新验证基线来自 Step 5L-C.1。跨月失败为 `NON_DETERMINISTIC_TEST`，已用 test-only 时钟隔离修复；重放超时为 `TRANSIENT_TIMEOUT_NOT_REPRODUCED`，没有确认生产回归。Step 5L-C.2 仅同步状态文档、复核版本专项和差异并创建检查点，不重复全量或构建。详情见 `docs/ALPHA15_STATUS.md`。

## RC 制作与隔离验收（本轮尚未执行）

- [ ] 另行授权后制作安装包，命名由产品版本推导为 `PrivateRadar-Setup-0.2.0-alpha.15-x64.exe`，核对包内元数据和构建产物。
- [ ] 全新隔离安装与无 Node/npm 环境启动。
- [ ] 确认新库与迁移库的 `PRAGMA user_version = 4`。
- [ ] alpha.14.1 → alpha.15 的真实安装版数据库迁移（schema 3 → 4）；不得直接测试正式库。
- [ ] 212 条消息隔离副本升级：前后核对消息、FTS、任务、来源、设置和数据库完整性。
- [ ] 安装版 Connector 仅公开 `privateradar_ingest_messages`、`privateradar_ingest_current_context_batch`。
- [ ] 安装版官方 Skill 为 `0.2.0-alpha.15-skill.3`；升级保留自定义 Skill。
- [ ] 重启 WorkBuddy 后通过真实连接确认 `tools/list` 和信任状态，不能仅以内存测试替代。
- [ ] 安装版单卡真实导入与 UI 反馈。
- [ ] 安装版同次双卡导入：两逻辑附件、独立项 / 任务 / 来源批次 / 目录证据。
- [ ] 目录证据完整性与哈希校验；拒绝损坏证据。
- [ ] 证据持久化后重启、重试与恢复，不依赖原 WorkBuddy 临时材料。
- [ ] 隔离卸载、重装与升级的数据保留验证。
- [ ] 验证已记录的中文明确日期搜索、末尾单个换行问题及完整来源保留，不隐瞒或误称已修复。
- [ ] 备份、回滚演练及回滚后的数据与连接一致性核对。

## 边界与既有证据

Step 5J 的真实双卡 5 + 5 条验收为 `PASS_WITH_ISSUE`，随后 `ROLLBACK_VERIFIED`；不是 alpha.15 RC 安装版通过证明。Step 5L-B 源码基线为 574 项通过、4 项跳过、0 项失败，构建和类型检查通过；不能代替本轮新版本验证。

本轮不制作 installer、不创建 Skill ZIP、不安装、不 tag、不 push、不 release。不得修改正式数据库、正式 Connector、正式 Skill 或正式 WorkBuddy 配置。三个历史未跟踪 Skill ZIP 保持不动且不提交。

发布前必须完成另行授权的 RC 验证，并复核 [已知问题](KNOWN_ISSUES.md)。未执行项目保持未勾选，不沿用 alpha.3 的历史通过状态。
