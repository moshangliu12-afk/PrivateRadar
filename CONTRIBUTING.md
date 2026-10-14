# 贡献指南

当前仓库仍为 Private，获取源码需要相应访问权限。项目自身采用 [Apache-2.0](LICENSE)，第三方组件保持各自许可。贡献以小范围、可复核的改动为主。

## 环境与安装

Node.js 要求为 `>=24`，使用 npm 与现有 `package-lock.json`。当前本地验收环境为 Node.js 24.14.0、npm 11.9.0；macOS 源码实体验收为 Apple Silicon arm64。不要为文档或普通 metadata 改动重新生成锁文件。

```sh
npm ci
npm run dev
```

`npm ci` 按锁文件安装，不应改写依赖版本。Electron 需要其安装脚本成功下载二进制。若环境的安装脚本安全机制没有执行 Electron 安装脚本，应先核实安装日志与锁定包来源；确认后可以执行：

```sh
node node_modules/electron/install.js
```

确认 Electron 的 `dist` 目录和 `path.txt` 已生成，再重新启动开发应用。不要把缺少 Electron 二进制视为产品签名 / 架构验收结论。密钥仅放在本机环境，远程服务发送行为见 [PRIVACY.md](PRIVACY.md)；没有联网配置也可运行本地规则模式。

## 提交前验证

```sh
npm test -- --maxWorkers=2 --testTimeout=30000
npm run typecheck
npm run build
```

当前 Windows 完整回归基线为 78 文件、1674 用例。提交前确认全部应执行用例通过，并说明运行平台及既有平台跳过；不得为凑通过数量放宽断言、关闭平台约束或随意增大超时。构建生成主进程、界面与 WorkBuddy Connector 输出，不等于安装器、签名或公证验收。

## 平台与换行

Windows 已验证正式 WorkBuddy 原始上下文链及 JSON / CSV / TXT 文件入口。Windows Directory Evidence 和部分安全测试使用 PowerShell / Win32 原生能力。Mac 当前入口仅为手动 JSON，使用 Finder 打开 Evidence；Windows 专有能力不能据同一命令在 Mac 上成功运行而视为已验收。macOS 正式发行状态见 [README](README.md)。

Windows `core.autocrlf` 可能使工作树字节与 Git blob 不同，影响字节契约测试。遇到此类环境问题，应在仓库外使用关闭自动换行转换的隔离检出，并核对待验提交的文件字节，再运行相同测试；不修改全局 Git 配置，不改业务代码或断言来适配换行。

`.gitattributes` 对 WorkBuddy 聊天历史 TXT fixture 声明 `-text`；其中的固定 LF / CRLF、BOM、末尾换行和哈希属于契约。禁止把整个 fixture 目录批量转换为 LF，也不得由编辑器顺手整理其空白。普通源码与原始输入 fixture 的换行校验应分别处理。

## 合成数据原则

所有新增或修改 fixture、测试数据、示例与截图必须 synthetic-only。只能使用明显虚构且无现实指向的实体，禁止真实聊天、姓名、住宅、手机号、私人邮箱、Evidence 和用户真实数据库。不能从隐私备份或旧历史恢复真实原文，也不能只换姓名后把可识别的原句继续作为示例。

保留需要验证的消息数量、重复关系、时间结构、特殊空白、emoji 和正 / 负 / 模糊语义；合成替换不能暗中改变断言目的、来源身份或证据规则。

## PR 基本要求

说明改动目的、范围、验证结果与平台限制。测试、类型检查和构建应通过；diff 中不得含私人数据或 secret，数据库和 Evidence 不进入提交。确认声明范围之外的源码、schema、fixture、依赖、版本与工作流没有附带变化。

默认不合并或发布未审核的安装器、签名产物或秘密配置；第三方二进制通知核验见 [许可清单](THIRD_PARTY_NOTICES.md)。安全问题使用 [SECURITY.md](SECURITY.md) 的联系方式与合成重现规则。
