# PrivateRadar alpha.21 使用指南

PrivateRadar 帮你整理主动导入的聊天，并能回到原始消息查看依据。当前版本为 `0.2.0-alpha.21`，[v0.2.0-alpha.21 Pre-release](https://github.com/moshangliu12-afk/PrivateRadar/releases/tag/v0.2.0-alpha.21) 已提供 Windows x64、macOS Apple Silicon arm64 安装资产、FFmpeg 对应源码和 `SHA256SUMS.txt`。Windows 安装与主要功能人工验收通过；macOS CI 打包与 DMG 检查通过，尚无 alpha.21 实体 Mac 人工运行验收记录。历史 alpha.20 的 Windows 11 x64 封板结论保留；此前 Apple Silicon unsigned 包的实机结果仅为参考。

## Windows 安装与初次体验

alpha.21 已作为 Release 资产提供的 Windows 安装器为 `PrivateRadar-Setup-0.2.0-alpha.21-x64.exe`，仅 Windows x64，unsigned，非 Microsoft Store 分发，已通过人工安装与主要功能验收。从对应版本发行页获取，并与 `SHA256SUMS.txt` 核对摘要，再按安装向导安装；不要使用历史版本安装器替代。

Windows 可能出现 SmartScreen / 未知发布者提示。核验来源和摘要后，如果系统提供“更多信息 → 仍要运行”，可由你选择单次继续；组织策略可能禁止继续。不指导关闭 Defender 或系统级安全功能。

历史 [alpha.20 Pre-release 档案页](https://github.com/moshangliu12-afk/PrivateRadar/releases/tag/v0.2.0-alpha.20)保留原源码与 annotated tag 封板记录，没有上传该版本 Windows 安装器、Skill 或 macOS 资产。GitHub 自动生成的源码压缩包不属于手工上传安装资产。

安装后可在开始菜单或桌面打开 PrivateRadar，不需要安装 Node.js 或使用命令行。首次打开可点击“体验 Demo”，页面会明确标记演示数据。

## Windows 连接 WorkBuddy

1. 在 PrivateRadar 中点击“导入我的微信聊天”，再点击“配置 WorkBuddy”。
2. 回到 WorkBuddy 连接器列表，找到 PrivateRadar（`privateradar-workbuddy`），由你本人确认信任。
3. 回到 PrivateRadar，点击“检查连接”。更新后若提示需要重新确认信任，请在 WorkBuddy 中确认。
4. 若连接器更新后仍未刷新连接，请重新启动 WorkBuddy，再检查连接与信任状态。

## Windows 单张微信聊天记录

在 Windows 微信中选择聊天记录，通过系统分享发送一张微信聊天记录卡片到 WorkBuddy，并说：

> 把这份微信聊天记录导入 PrivateRadar。

正式导入需要当前卡片提供完整原文和原始来源。逐条发送人、完整日期与时分必须能可靠解析；缺失、截断、数量不符或来源冲突时会停止导入，不会补造，也不能改用旧入口绕过。群名没有可靠来源时保持未知，不必自行猜填。

## Windows 两张微信聊天记录

同一次发送两张微信聊天卡片到 WorkBuddy，并说：

> 把这两份微信聊天记录批量导入 PrivateRadar。

单卡或同次两张卡片都使用正式原始来源链。导入结束后查看整次及各附件的成功、重复或失败统计。当前不支持三张以上卡片；若提示材料缺失或冲突，请重新分享完整卡片，不要要求应用猜测历史附件或补造发送人和时间。

你不需要找 ZIP、填写路径或 JSON、复制聊天文本、选择证据，或手工调用工具。

## macOS 安装与首次启动

alpha.21 已作为 Release 资产提供 `PrivateRadar-0.2.0-alpha.21-macOS-arm64.dmg`，仅 Apple Silicon / arm64，不提供 Intel x64。文件名不含 `unsigned`，但实际仍为 unsigned、not notarized、无 Developer ID；用户无需 Apple Developer Program。该包已通过 CI 打包与 DMG 检查，尚无 alpha.21 实体 Mac 人工运行验收记录。

安装步骤：

1. 从对应版本发行页取得 DMG 与 `SHA256SUMS.txt`，核验下载来源及 DMG SHA256。
2. 打开 DMG，将 `PrivateRadar.app` 拖入 `/Applications`，再从“应用程序”打开。
3. 此前参考候选首次直接打开曾提示“PrivateRadar 已损坏，无法打开”。若下载来源可信且 SHA256 一致，并且你选择继续，可在终端仅执行下面这条针对 PrivateRadar 自身的命令，再重新打开 App：

```sh
xattr -dr com.apple.quarantine "/Applications/PrivateRadar.app"
```

该命令仅移除 `/Applications/PrivateRadar.app` 自身的 quarantine 属性，不修复损坏的下载文件。不要扩大到其他路径或其他 App，不关闭 Gatekeeper、SIP，也不降低系统级安全策略。若摘要不符，先停止，不执行该操作。终端无需安装 Node.js 或开发工具。

此前已完成的 **alpha.20-derived reference runtime acceptance** 包括 DMG integrity、安装到 `/Applications`、synthetic JSON 导入、Search、Commitment Candidate、Confirm、Confirmed、Evidence、完全退出后重启及数据持久化，均通过；无崩溃、无数据丢失。首次启动体验为 `PASS_WITH_ISSUE`，按上述单 App 操作后成功运行。不能将这些结果写成 alpha.21 DMG 已完成实机验收。

alpha.21 已完成 CI / 包核验，实体 Mac 人工运行验收与上述参考候选分开记录。源码开发方式另见 [README](README.md) 和 [贡献指南](CONTRIBUTING.md)。

## macOS 手动 JSON

在 Mac 的文件导入入口选择 JSON 文件。该入口仅接受 JSON，不提供 Windows WorkBuddy 配置或正式分享链，也不承诺 CSV / TXT 能力。手动 JSON 会保留原始文件字节与消息快照为本地 Evidence；其来源身份与 WorkBuddy 原始卡片分开，不从文件声明恢复微信卡片来源事实。

此前实体源码验收还覆盖关键词命中、承诺候选确认 / 忽略、同来源上下文及 Finder 打开对应 Evidence 目录；与 alpha.21 新包验收分开记录。可以使用 Command+A / C / V 操作输入框。来源缺失或冲突按既有保守规则处理，不猜造。

## 查看结果

- 今日情报：先查看“今天最重要”。其下的“你关注的关键词今天有新消息”独立展示关注词信号，不把关键词命中当作最重要。该区块按可靠聊天时间判断当前本地日期，今天导入的旧聊天不会因此成为今天的新消息；点击“查看全部”进入关键词雷达。
- 问我的聊天：搜索原文，按日期、群或人物条件查找，并查看上下文；没有足够证据时明确提示。
- 话题雷达：区分新出现与正在升温的话题；历史消息缺少可靠时间或发送人时，相应统计会保守降级。
- 关键词雷达：配置关注词，回看历史命中；可查看对应来源上下文和附件证据。
- 承诺候选：查看候选原话和匹配原因，再选择确认或忽略。候选不是事实或任务。
- 承诺表达（已确认）：只读回看你已确认的原话及来源；确认的是原话表达了承诺，不表示承诺已履行。
- 批量收集：查看批量导入及归集记录；加入指定收集集合仅支持同次双卡，单卡暂不支持。

关键词和承诺结果的“查看上下文”“查看证据”对应当前来源。证据暂不可用时，保留原话并提示，不替换成其他附件。普通文件格式另见 [文件导入格式](IMPORT_FORMATS.md)。Windows 封板的部分展示正文仍可能裁剪末尾换行，专项限制见 [已知问题](KNOWN_ISSUES.md)；Mac 手动 JSON 的原文保留与来源冲突使用独立契约，平台边界以上述章节为准。

## 数据与卸载

数据默认保存在 Electron 本地用户数据目录；Windows 通常为 `%APPDATA%\PrivateRadar\`，实际位置可在设置页打开。Windows 安装器默认卸载配置保留用户数据；升级前仍应备份。Mac 参考候选已验证安装和重启持久化；alpha.21 新包及卸载后的保留行为不能据此视为已验收。PrivateRadar 原生微信分享入口已延期，Windows 继续通过 WorkBuddy 主动分享导入。

远程 AI 与 Embedding 由用户在本机独立配置；启用后可能发送聊天证据，没有逐次确认门禁。数据库没有实现加密，详见 [隐私说明](PRIVACY.md)。问题报告应遵循 [安全说明](SECURITY.md)，不上传真实聊天、数据库或 Evidence。
