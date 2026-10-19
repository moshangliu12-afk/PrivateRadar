# PrivateRadar alpha.21 已知问题与范围

本文记录 alpha.21 发行准备沿用的现存限制、已解决事项与历史环境问题；alpha.20 历史封板结论保留。B0-1～4 已闭环，许可证 P0 为零；alpha.21 Windows 本地安装候选已完成构建与人工验收，GitHub Release 尚未创建且未公开发布，GitHub Support 公开门禁仍开放。没有覆盖的输入或环境不能据此视为已验收，当前状态见 [README](README.md)。

## A. 现存限制与非阻塞记录

### 来源本地时间的时区解释

`SOURCE_LOCAL_TIME_TIMEZONE_INTERPRETATION`：WorkBuddy 原文完整日期与时分可以作为来源事实；原文未提供时区时，解析器采用的 `+08:00` 是系统解释。当前日历归属还受运行环境本地时区影响，不能把解释写成来源自带时区，也不能声称所有跨时区输入已完全解决。

### SQLite 正常启动的原始文件头变化

`SQLITE_STARTUP_HEADER_BYTE_CHANGE`：正常应用启动可能改变原始数据库文件头的计数器。alpha.20 部署验收中的变化来自既有初始化路径，逻辑结构和全部业务表数据保持一致；这不是数据库损坏。后续核验仍须分别检查业务表、逻辑结构和 Evidence，不能只凭整个数据库文件哈希下结论。

### 多行正文末尾空白规范化

`messages.content` 仍经过既有首尾空白规范化，末尾换行可能被裁剪。`messages.json` 和 `raw_metadata_json` 保留完整来源；不能声称展示正文与来源文本字节完全一致。该限制继续保留，不把历史 Parser 的原文保留能力误写成 importer 无裁剪。

### 当前能力边界

- 正式 WorkBuddy 原始上下文入口支持一个或两个逻辑附件。逐条发送人、完整日期与时分缺失或不能可靠解析时拒绝输入，不改走旧规范消息入口，不补造时间。历史未知字段与内部兼容数据仍保留，不自动回填。
- 指定收集集合仅支持同次双卡；不支持单卡归集、任意数量卡片、OCR 或 PDF 正文解析。
- 真实语义检索和微信数据库直读不属于当前正式能力；原生微信分享入口继续延期。Mac 仅支持 Apple Silicon / arm64 手动 JSON，不提供 Intel x64 或 Windows WorkBuddy 正式链，也不承诺 CSV / TXT。
- 已验收覆盖以 Windows 11 x64 和既有 WorkBuddy 链路为主，其他版本、平台和全新实体机器覆盖有限。
- Windows x64 安装器为 unsigned、非 Microsoft Store 分发，可能出现 SmartScreen / 未知发布者提示；不指导关闭系统保护。
- Mac DMG 为 unsigned、not notarized、无 Developer ID。此前 alpha.20-derived 参考候选首次提示“PrivateRadar 已损坏，无法打开”，核验来源与 SHA256 后，仅移除 PrivateRadar.app 自身 quarantine 才成功启动；操作边界见 [使用指南](USER_GUIDE.md)。
- 参考 Mac 核心功能实机验收为 PASS，首次安装体验为 PASS_WITH_ISSUE。alpha.21 新 DMG 尚未构建或实测，需先核验新旧运行代码与运行库差异；不直接继承实机 PASS。

## B. 已解决事项

### 已解析的明确日期残留为正文查询词

状态：`RESOLVED`。原问题是已被日期解析器消费的明确日期仍进入正文检索词，导致可靠消息漏召回。当前查询理解会清理已消费的日期及对应范围连接符，保留业务正文；代码和中文明确日期回归用例支持该具体问题已解决。

范围仅限现有日期解析器已消费的明确日期，不代表所有中文日期表达、模糊日期或所有搜索问题均已解决。实现见 [日期文本清理](src/main/retrieval/query-understanding.ts)，对应测试见 [日期检索回归](tests/search-relative-date.test.ts)。

## C. 历史构建与环境记录

### Windows 工作树换行转换

`WORKTREE_LINE_ENDING_CONVERSION`：Windows 的 `core.autocrlf` 可能令工作树字节与 Git blob 或包内文件不同，影响字节断言。核验须区分工作树换行与封板产物字节；这是开发 / 构建环境边界，不是产品数据问题，也不表示正式 Skill 被改写。

### NSIS 缓存文件的 EFS 加密

`NSIS_EFS_ENCRYPTED_CACHE_ARTIFACT`：alpha.20 candidate 首次构建遇到默认 NSIS 缓存文件受 EFS 加密，复制失败。使用同版本、同哈希的未加密隔离缓存后构建已恢复，当前不再是 blocker。旧默认缓存未被解密或修改，不能宣称用户机器上的旧缓存已永久修复。

alpha.15 的候选准备状态与当时检查项继续保留在 [历史发布说明](ALPHA_RELEASE_NOTES.md)及[历史检查表](ALPHA_RELEASE_CHECKLIST.md)，不代表 alpha.20 当前仍待发布或安装验收。
