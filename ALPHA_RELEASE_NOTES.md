# PrivateRadar 0.2.0-alpha.3 发布说明

## 当前版本

本次冻结版本为 `0.2.0-alpha.3`，面向第一批 1～3 名 Windows 11 用户进行 Alpha 内测。本版本在保留上一版 Daily 刷新修复的基础上，修正未知发送者人数统计、批次查询索引和导入批次时间语义。

修复后，应用会以最新成功导入任务作为 Daily 缓存修订号；运行期间发现 WorkBuddy 新导入时自动刷新今日情报，并让话题雷达重新读取数据。消息时间与缺失时间的既有语义保持不变。

## 三大核心功能

- 今日情报：从大量聊天中筛选值得关注的信息，并保留原始消息依据。
- 跨群话题雷达：以七天历史为基线识别正在升温的话题；缺少时间或发送人时按数据完整度降级。
- 问我的聊天：组合全文、结构化条件与可选语义检索，在本地聊天记录中查找信息并展示上下文。

## 微信与 WorkBuddy 导入

用户在 PrivateRadar 中点击“配置 WorkBuddy”，然后在 WorkBuddy 中信任 `privateradar-workbuddy`。此后可从 Windows 微信系统分享测试聊天到 WorkBuddy，并输入“将这份聊天记录导入 PrivateRadar”。WorkBuddy 会调用 `privateradar_ingest_messages`，消息经过标准化、稳定身份、去重和元数据来源标记后写入正式数据库。

快速导入默认只确认群名。微信分享未提供发送人或原始时间时，相应字段保持空值并标记为来源未知，不生成假数据。

## Local First 数据策略

聊天原文默认保存在用户电脑。当前正式数据目录为 `C:\Users\Example\AppData\Roaming\PrivateRadar`，正式数据库为其中的 `private-radar.db`。安装升级不删除该数据库，默认卸载也保留用户数据。

`work/alpha-install/user-data` 仅是隔离测试资产，不属于生产运行路径。调试 Harness、直接 JSON-RPC 工具和 Spike 数据均不进入普通用户安装包或正式导入链路。

## 端到端验收

2026-09-13 至 2026-09-14 已在实际 Windows 桌面环境完成正式链路验收：

`Windows 微信 → WorkBuddy GUI → privateradar-workbuddy → privateradar_ingest_messages → 正式 SQLite → PrivateRadar UI`

正式数据库端到端链路已验证；`alpha.3` 覆盖升级前后均保存 81 条唯一消息、5 个导入任务，FTS 可检索，`PRAGMA quick_check` 返回 `ok`。安装升级未改变 WorkBuddy 配置与信任记录；今日情报、话题雷达和聊天搜索回归正常。最终状态为 `SUCCESS`。
