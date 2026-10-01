# PrivateRadar

PrivateRadar 是一个本地优先的个人聊天情报系统。它的目标不是展示聊天记录，而是可靠回答：今天什么最重要、什么正在变热、以前看过的东西在哪里。

PrivateRadar V0.1 三个核心需求已经完成：今日情报、跨群话题雷达和“问我的聊天”。

## 目前可以体验什么

- Windows 11 桌面应用。
- 无需微信或真实聊天记录的演示模式。
- 4 个模拟群、8 个模拟用户、连续 7 天、1468 条本地消息。
- 今日情报、话题雷达和“问我的聊天”页面。
- 无需本机编译工具的 SQLite 本地数据库和 FTS5 全文索引基础。
- JSON、CSV、TXT 文件选择、逐条容错、稳定去重和导入结果统计。
- 可配置噪音过滤、保守候选归并、独立重要性评分和可追溯原始依据。
- Provider 无关的 D2 结构化整理、来源保护、持久化缓存和失败降级。
- 保守话题归并、7 天历史基线、独立 Signal Score、迷你趋势和原始证据追溯。
- FTS5、日期/群/人物过滤和基于有限证据的回答；真实语义检索仍不属于当前正式能力。

alpha.15 源码进入 RC 构建准备阶段，尚未正式发布，当前日常版本仍为 alpha.14.1。alpha.15 的 WorkBuddy 路线保留单卡导入，并新增同次两张微信聊天卡片批量导入。使用说明见 [USER_GUIDE.md](./USER_GUIDE.md)，安装版待验收项目见 [ALPHA_RELEASE_CHECKLIST.md](./ALPHA_RELEASE_CHECKLIST.md)。

## 启动

开发环境先安装 Node.js 24 或更高版本，然后在本目录打开 PowerShell：

```powershell
npm install
npm run dev
```

应用首次启动会创建空数据库。真实运行数据默认进入 Electron 的用户数据目录，不会写入 Git 仓库；开发时可通过 `.env.example` 中的开关注入内置 Demo。

点击右上角“导入聊天记录”即可选择文件。三种格式的字段说明和示例见 [IMPORT_FORMATS.md](./IMPORT_FORMATS.md)。

## 自检

```powershell
npm test
npm run typecheck
npm run build
```

已验证环境：Windows 11、Node.js 24、Electron 44。首次依赖安装会下载 Electron，所需时间取决于网络。

## 当前目录

```text
PrivateRadar/
├── src/
│   ├── main/        Electron 主进程、SQLite、演示数据
│   ├── preload/     安全的页面调用桥
│   ├── renderer/    React 界面
│   └── shared/      标准消息与共享类型
├── tests/           自动测试
├── PRIVATE_RADAR_REFERENCE_RESEARCH.md
├── DEVELOPMENT_PROGRESS.md
└── package.json
```

## 隐私与安全

- 聊天原文默认只保存在本机。
- 不读取或破解微信数据库，不 Hook 微信，不提取密钥。
- 不提交 API Key、Token、本地数据库或真实聊天导出。
- 后续使用远程 AI Provider 前，必须明确提示可能发生的数据外发。

## AI 开发配置

复制 `.env.example` 中需要的变量到本机环境。可用 `PRIVATE_RADAR_AI_PROVIDER=mock` 验证不联网的完整链路；远程服务需要配置 Base URL、Model 和 API Key。任何密钥都不应写入源码、日志或提交到 Git。

## 开发路线

阶段 D1 设计见 [DAILY_INTELLIGENCE_D1.md](./DAILY_INTELLIGENCE_D1.md)，D2 设计见 [DAILY_INTELLIGENCE_D2.md](./DAILY_INTELLIGENCE_D2.md)，E1 设计见 [TOPIC_RADAR_E1.md](./TOPIC_RADAR_E1.md)，聊天检索设计见 [ASK_MY_CHATS.md](./ASK_MY_CHATS.md)。完整进度见 [DEVELOPMENT_PROGRESS.md](./DEVELOPMENT_PROGRESS.md)。
