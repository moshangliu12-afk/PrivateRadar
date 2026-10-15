# FFmpeg 保守源码交付

使用 Python 3.12 或更新版本的标准库执行 `scripts/prepare-ffmpeg-corresponding-source.py`，
指定仓库外的 `--cache` 和尚不存在的 `--output` 目录。
默认仅使用缓存；显式加 `--download` 才会从 `sources.lock.json` 中的固定官方地址下载。
不执行下载的源码，不构建 Electron、Chromium 或 FFmpeg，不修改系统配置或项目依赖。

来源树、Git blob、SHA-256、必要许可、22 份配置和两份原始参数全部先校验。
任一缺失或摘要不匹配均失败，不生成可交付清单。缓存文件不可任意替代。
包内保留原始上游许可；完整 FFmpeg fork 含可选组件的 GPL 正文，
这不改变本次已核验发布配置的 `LGPL-2.1-or-later` 分类。

目录对应关系：`ffmpeg/` 对应 Chromium `src/third_party/ffmpeg`；
`opus/` 对应 `src/third_party/opus`；`chromium-build-context/` 对应 Chromium 根目录；
`llvm-runtime/{libcxx,libcxxabi,compiler-rt}` 对应各 Chromium wrapper 的 `src/`；
`llvm-header-context/libc` 对应 `third_party/llvm-libc/src`；
`toolchain/nasm-source` 对应 `third_party/nasm`；
`electron-build-context/electron` 对应 `src/electron`。
这些是来源位置索引，不是可以直接构建全部 Electron 的工作区。

固定 FFmpeg BUILD.gn 实际调用 `tools/generate_stubs/generate_stubs.py`，
本包按这个真实路径纳入；旧说明中的 `media/generate_stubs.py` 不存在于此固定提交。
原始生成配置直接来自固定 fork，未重新生成。
FFmpeg patch 队列仅含 `link_with_loader_path.patch`；构建上下文的 Chromium patch
是完整原队列中的选定子集，顺序见清单，未宣称包含整套 Electron 补丁。

包内 manifest 不写自身及整个 archive 的摘要，避免循环；外置同名 manifest
包含完整归档清单（含包内 manifest）、压缩后大小和最终 SHA-256。
两份文件用途不同，发行时应把外置 manifest 与 `.tar.xz` 一同交付。
固定排序、Git 权限、零时间与所有者；压缩工具版本改变仍可能改变压缩字节，
每次生成必须重新核验最终摘要。

正式生成要求 `git status --porcelain` 为空，包括暂存变更和未跟踪文件。
脚本自动读取当前 `git rev-parse HEAD`，只接受 40 位小写十六进制提交，
不使用分支名称、父提交、模板旧值或硬编码回退；干净的 detached HEAD 也可生成。
准备前后及归档结束时再次核对工作区和 HEAD，变更即拒绝交付。

包内与外置清单的正式发行身份是动态生成的 `privateradar.source_commit`。
原有 `source_commit_before_delivery_change` 仅保留历史方案设计基线，不能用于发行关联；
`privateradar.version` 也不能代替提交身份。静态模板禁止包含正式 `source_commit`。
生成结果位于仓库外，不把未来提交号写回受跟踪文件，避免提交自引用。

后续验收可导入准备脚本中的
`verify_private_radar_source_binding(expected_commit, manifest)`：
分别以 Windows 候选提交与 Mac CI `head_sha` 作为预期值核对清单。
验收方还必须确认这两个预期值相同；旧清单、缺失字段及任何 SHA 不一致都必须拒绝。
