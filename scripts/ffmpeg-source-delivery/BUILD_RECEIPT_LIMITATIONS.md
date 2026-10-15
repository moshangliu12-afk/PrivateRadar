# 构建收据边界

这是两平台共用的固定来源、补丁、配置、许可与构建上下文保守超集。
两份 `build-receipts/*/args.gn` 来自官方 Electron Siso report，保持原始字节。
官方完整最终 FFmpeg target graph、link response 和 link map 未被当前可访问的官方 artifact 留存。
本包不声称持有这些收据，也不是可按位重现官方 Electron FFmpeg 二进制的构建套件。

完整固定 FFmpeg fork 原样保留；Electron 的 FFmpeg 补丁另外提供，尚未覆盖进原树。
影响 Chromium build glue 的 Electron 补丁另附其原队列和在队列中的顺序。
构建上下文范围宽于已证明的实际编译文件范围，不宣称是精确最小闭包。

LLVM libc++、libc++abi、compiler-rt 为完整固定 split repo，未带入整个 LLVM monorepo。
LLVM libc 也保守保留固定 split 快照，但本目标已识别用途仅为头文件与定义，
分类为 `HEADER_ONLY_INPUT`；不意味着其运行库静态链接进了 FFmpeg。
Windows 系统及工具链库仅记录身份与已观察输入，不分发 Microsoft 工具链二进制或伪造其源码。
PGO 数据和 SDK 未装入本包，清单中的 expected SHA-256 是官方状态记录，不是本地实测归档摘要。

本地源码验证通过不等于真实安装器、Mac App/DMG 和最终发行资产已通过验收。
正式 macOS 签名后，用户替换兼容动态库及本地重新签名的运行行为必须另行验收。
