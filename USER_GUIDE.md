# PrivateRadar Alpha 使用指南

PrivateRadar 把看不完的群聊整理成值得关注的信息，并让你随时搜索过去的聊天。所有结果都可以回到原始消息查看依据。

## 安装

1. 双击 `PrivateRadar-Setup-0.2.0-alpha.3-x64.exe`。
2. 如果 Windows 提示发布者未知，请先确认安装包来自你信任的 PrivateRadar 测试发布人，再决定是否继续。
3. 按向导完成安装，然后从开始菜单或桌面打开 PrivateRadar。

不需要安装 Node.js，也不需要使用命令行。

## 先体验一下

首次打开后点击“体验 Demo”，可以直接查看今日情报、话题雷达和聊天搜索。页面会明确标记“当前为演示数据”。

## 连接 WorkBuddy

1. 在 PrivateRadar 中点击“导入我的微信聊天”。
2. 点击“配置 WorkBuddy”，PrivateRadar 会自动完成连接准备。
3. 回到 WorkBuddy 的连接器列表，找到 PrivateRadar（`privateradar-workbuddy`）。
4. WorkBuddy 会请你确认信任。这是正常的安全保护，必须由你本人点击。
5. 回到 PrivateRadar，点击“检查连接”。

如果更新后看到“需要重新确认信任”，说明微信连接组件确实发生了配置变化。再次在 WorkBuddy 中找到 `privateradar-workbuddy` 并确认即可。

## 从微信导入

1. 在 Windows 微信中多选聊天记录。
2. 选择转发或系统分享，然后选择 WorkBuddy。
3. 输入“将这份聊天记录导入 PrivateRadar”。
4. 默认使用快速导入，只需确认群名。原始时间和发送人缺失时也可以导入，但部分趋势和人数统计会降低精度。

## 三个核心页面

- 今日情报：查看今天最值得关注的消息。
- 话题雷达：查看相对过去七天正在升温的话题。
- 问我的聊天：用自然语言搜索聊天，并查看原始依据。

## 数据与卸载

聊天数据默认保存在 `%APPDATA%\PrivateRadar\`。可以在设置页点击“打开数据目录”或“打开日志目录”。

可以从 Windows 的“已安装的应用”卸载 PrivateRadar。默认卸载会删除应用程序和快捷方式，但保留聊天数据，避免误删。
