# 调试工具隔离说明

本目录只保存开发期诊断工具，包括 MCP Harness、直接调用测试和 Electron 自动验收辅助脚本。

- 不属于 PrivateRadar 普通用户运行链路。
- 不得用于替代 WorkBuddy GUI 调用正式 Connector。
- 不会进入 Windows 安装包；安装包白名单仅包含构建后的应用与正式 `privateradar-workbuddy` 资源。
- 正式单卡与双卡导入都由 WorkBuddy 官方连接器调用 `privateradar_ingest_current_context_batch`，原样提交本次真实原始上下文与明确目录。旧 `privateradar_ingest_messages` 只返回 `RAW_CURRENT_CONTEXT_REQUIRED`，不得用于降级导入。

根目录当前不存在临时 ingest 脚本，也不存在供普通用户手工启动 `server.mjs` 的脚本。
