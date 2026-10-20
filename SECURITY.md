# 安全问题与报告方式

## 当前版本范围

当前版本为 `0.2.0-alpha.22`，发行标签为 `v0.2.0-alpha.22`；该 Pre-release 已提供 Windows x64、macOS Apple Silicon arm64 安装资产、FFmpeg 对应源码和 `SHA256SUMS.txt`，统一绑定源码提交 `a4d9174c713341243a00799c3432543aaa4e7747`。Windows 安装、启动、重启与普通导入人工验收通过，macOS CI / DMG 检查通过，没有本版实体 Mac 人工验证。历史发行身份保留；项目不承诺所有旧版本持续维护或固定安全响应期限。

Windows x64 采用 unsigned、非 Microsoft Store 分发；Mac 仅 Apple Silicon / arm64，采用 unsigned、not notarized、无 Developer ID 策略，不提供 Intel x64。Developer ID 和公证不作为当前发行 blocker。此前 Mac 包的核心功能实机验收为 alpha.20-derived 参考证据，首次启动需处理该 App 自身 quarantine；不得称 alpha.22 DMG 已实测通过。校验与单 App 操作范围见 [使用指南](USER_GUIDE.md)，不指导关闭系统级保护。

B0-1～4 已闭环，`P0_BINARY_LICENSE_BLOCKER_COUNT = 0`；alpha.22 安装资产、对应源码及许可材料已核验。对应源码包绑定发行提交 `a4d9174c713341243a00799c3432543aaa4e7747`；`SHA256SUMS.txt` 只记录 Windows、macOS 与对应源码三个资产的摘要。最新依赖审计 Critical = 0、Production = 0；已审核的开发或构建依赖告警仍有 2 High、8 Moderate。仓库保持 Private，公开需另行授权。

## 报告时保护数据

安全问题请用完全合成的最小重现。不要在 Issue、PR、讨论或附件中上传真实聊天、真实姓名 / 住宅定位、手机号、私人邮箱、SQLite 数据库、Evidence、私密日志、token、API key、Apple credential、certificate 或 P8 私钥。截图和堆栈也应移除账户、私人路径与数据。

普通功能问题可以提交不含敏感内容的合成重现。漏洞可利用步骤、未公开细节或秘密材料不要放入公开 Issue。

## 私密报告通道仍待建立

当前 GitHub Private Vulnerability Reporting 尚未启用并验证，没有可承诺可用的私密报告通道。本项目未提供私人邮箱作为公开安全联系方式。

在私密通道可用之前，如需联系维护者，只建立 [最小联系 Issue](https://github.com/moshangliu12-afk/PrivateRadar/issues)，写明“需要安全沟通方式”，不包含漏洞细节、可利用步骤或真实材料。等待维护者提供安全沟通方式后再协商重现信息；确认通道前不要发送敏感细节。

`SECURITY_PRIVATE_CHANNEL_STILL_REQUIRED = YES`。该文档不表示 GitHub 私密漏洞报告开关已开启。
