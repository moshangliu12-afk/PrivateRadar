# PrivateRadar Alpha 最终发布检查

## 发布身份

- 产品名称：PrivateRadar
- 冻结版本：`0.2.0-alpha.3`
- 目标平台：Windows 11 x64
- 安装方式：NSIS 引导式安装
- 安装包：`release/PrivateRadar-Setup-0.2.0-alpha.3-x64.exe`

`package.json`、`package-lock.json`、Connector 元信息和 MCP Server 版本均已对齐为 `0.2.0-alpha.3`。正式 Connector ID、Tool 名和启动配置保持不变。

## 正式数据边界

- 当前用户正式数据目录：`C:\Users\Example\AppData\Roaming\PrivateRadar`
- 正式 SQLite：`C:\Users\Example\AppData\Roaming\PrivateRadar\private-radar.db`
- 正式 Connector 目录：`C:\Users\Example\AppData\Roaming\PrivateRadar\workbuddy\privateradar-workbuddy`
- `work/alpha-install/user-data`：仅为隔离测试资产，生产版及正式 Connector 均不引用；本轮保留，不删除。

安装升级保留用户数据库和设置。NSIS 配置 `deleteAppDataOnUninstall: false`，默认卸载只移除程序文件与快捷方式，不删除聊天数据。

## 正式 WorkBuddy Connector

- Connector ID：`privateradar-workbuddy`
- Tool：`privateradar_ingest_messages`
- WorkBuddy 5.5.5 GUI：绿色、已启用、已信任
- 注册方式：PrivateRadar 自动合并到 WorkBuddy 官方用户级配置，用户不需编辑文件；安全信任仍由用户本人确认。
- 旧 `privateradar-local-spike`：关闭，不参与连接检测、导入或生产运行。
- 配置稳定性：固定 ID、Tool 名、命令、参数顺序、工作目录和数据库路径；WorkBuddy 自动补充 `disabled: false` 不会被误判为配置变化。

Harness、直接 JSON-RPC driver、临时调用工具及 Electron 自动验收脚本统一隔离在 `tools/debug/`；Spike 和 Alpha 测试数据隔离在 `work/`。打包白名单不包含 `tools/`、`scripts/` 或 `work/`。

## 验收结果

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| Windows x64 安装 | 通过 | 默认目录及合法自定义目录均完成安装验证 |
| 无 Node/npm 启动 | 通过 | 安装版自包含运行依赖 |
| 开始菜单与桌面快捷方式 | 通过 | 安装创建、卸载移除正常 |
| Demo Mode | 通过 | 首次用户可直接体验三个核心页面 |
| WorkBuddy 自动注册 | 通过 | 正式条目自动注册，无需导入文件夹或手工编辑配置 |
| WorkBuddy 信任与连接检测 | 通过 | GUI 信任后 PrivateRadar 显示“已连接” |
| 微信分享端到端 | `SUCCESS` | Windows 微信分享经 WorkBuddy GUI、正式 Tool 写入同一正式 SQLite，UI 自动显示导入成功 |
| 今日情报 | 通过 | 可生成候选并查看原始依据 |
| 跨群话题雷达 | 通过 | 完整数据正常分析；缺少时间/发送人时按规则降级 |
| 问我的聊天 | 通过 | FTS 和混合检索可用，可查看原始上下文 |
| 10 万条性能 | 通过 | SQLite + Electron 满足 V0.1/Alpha 使用目标 |
| 升级保留数据 | 通过 | 数据库、设置、导入历史、Daily 与 Topic 数据保留 |
| 卸载 | 通过 | 应用文件、进程和快捷方式移除，用户数据默认保留 |
| 数据库完整性 | 通过 | 正式端到端库 `PRAGMA quick_check = ok` |
| Windows 安全 | 已知限制 | 安装包未签名，可能出现 SmartScreen 或未知发布者提示 |

## 正式端到端记录

验收链路：

`Windows 微信 → WorkBuddy GUI → privateradar-workbuddy → privateradar_ingest_messages → C:\Users\Example\AppData\Roaming\PrivateRadar\private-radar.db → PrivateRadar UI`

正式库在 `0.2.0-alpha.3` 覆盖升级前后均保存 81 条唯一消息、5 个导入任务，最新成功任务 ID 保持不变。`PRAGMA quick_check` 为 `ok`；安装升级未改写正式数据库，也未改变 WorkBuddy 配置或信任记录。

## 已知限制

- 微信系统分享不能稳定提供原始发送人和原始时间。
- 快速导入默认只确认群名；缺失发送人和时间会降低话题雷达的人数及趋势精度。
- 缺失字段必须省略并保存为空值，不能传入字符串 `"unknown"`。
- 安装包未签名，首批用户需确认安装包来源后自行决定是否继续。
- 物理全新 Windows 机器覆盖有限；已通过隔离用户数据、合法自定义安装目录及移除 Node/npm 环境进行近似验证。

## 最终构建结果

- 自动测试：`146/146` 通过，共 14 个测试文件；本补丁新增 9 项正确性回归测试。
- TypeScript typecheck：通过。
- Electron production build：通过。
- WorkBuddy MCP build：通过，正式服务产物约 1.4 MB。
- Windows installer build：通过。
- 安装包绝对路径：`C:\Users\Example\Documents\Codex\2026-09-12\files-pasted-by-the-user-privateradar\outputs\PrivateRadar\release\PrivateRadar-Setup-0.2.0-alpha.3-x64.exe`
- 安装包大小：`116,712,841` 字节（约 `111.31 MiB`）。
- 安装包 SHA-256：`C0E483AC75157EACDEDCB30751CCB13052BEF4C3FB024DD24889F6AB6690808E`
- 覆盖升级验证：已安装包内版本为 `0.2.0-alpha.3`；正式库仍为 81 条消息且 `quick_check=ok`；WorkBuddy 配置与信任文件 SHA-256 在升级前后完全一致。

## 发布判断

最终回归、安装产物核对及覆盖升级验收均已通过。PrivateRadar `0.2.0-alpha.3` 修复了未知发送者人数、批次查询索引和导入批次时间语义，已达到可继续交给真实用户进行 Alpha 内测的标准。
