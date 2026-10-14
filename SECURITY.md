# 安全问题与报告方式

## 当前版本范围

当前可复现的 Windows 验收基线为 `0.2.0-alpha.20`，Windows 11 x64 已封板；GitHub 档案页属于 Pre-release。其他旧 alpha 版本是历史记录，本项目不承诺所有旧版本持续维护或固定安全响应期限。

macOS 当前是 Apple Silicon 开发候选，只完成源码运行与未签名打包 CI 等阶段验证。打包应用实体验收、签名、公证和正式发行未完成，当前没有正式 Mac 安装器支持承诺。

## 报告时保护数据

安全问题请用完全合成的最小重现。不要在 Issue、PR、讨论或附件中上传真实聊天、真实姓名 / 住宅定位、手机号、私人邮箱、SQLite 数据库、Evidence、私密日志、token、API key、Apple credential、certificate 或 P8 私钥。截图和堆栈也应移除账户、私人路径与数据。

普通功能问题可以提交不含敏感内容的合成重现。漏洞可利用步骤、未公开细节或秘密材料不要放入公开 Issue。

## 私密报告通道仍待建立

当前 GitHub Private Vulnerability Reporting 尚未启用并验证，没有可承诺可用的私密报告通道。本项目未提供私人邮箱作为公开安全联系方式。

在私密通道可用之前，如需联系维护者，只建立 [最小联系 Issue](https://github.com/moshangliu12-afk/PrivateRadar/issues)，写明“需要安全沟通方式”，不包含漏洞细节、可利用步骤或真实材料。等待维护者提供安全沟通方式后再协商重现信息；确认通道前不要发送敏感细节。

`SECURITY_PRIVATE_CHANNEL_STILL_REQUIRED = YES`。该文档不表示 GitHub 私密漏洞报告开关已开启。
