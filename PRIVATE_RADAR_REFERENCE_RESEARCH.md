# PrivateRadar V0.1 参考项目研究

研究日期：2026-09-12

## 研究边界与结论

本次只研究任务书指定的三个项目，并固定到以下提交：

| 项目 | 研究提交 | 许可证 | 本项目处理方式 |
|---|---|---|---|
| `zjp1997720/wechat-radar` | `de7ec99fed90ba3c5644fbe1ac233ff981cc53f7` | MIT | 学习本地看板、SQLite 聚合、话题与来源关联思想 |
| `ye4wzp/chat-analyzer` | `fa5c85a1ad4de07eeda5504fda2741b6477fa6ef` | MIT | 学习统一消息层、增量同步、去噪、时间窗口、语义检索与测试方式 |
| `JimLiu/baoyu-skills` 的 `baoyu-wechat-summary` | `1567581c26ec29f4216c6e6835415bf30343b0e3` | MIT | 学习增量游标、历史归档、来源归属、事实修订与防提示注入规则 |

三个仓库的 MIT 许可证均允许商业使用、修改和再分发，但复制有版权意义的代码时必须保留版权声明和许可文本。PrivateRadar 当前没有复制上述仓库代码，只吸收架构思想，因此没有引入第三方源代码或运行时依赖。

## 1. wechat-radar

### 值得学习

- Dashboard-first：先呈现当日统计、重点信息和趋势，而不是让用户先面对聊天框。
- SQLite 本地聚合：使用 WAL、索引和预编译查询，运行数据放在仓库之外。
- `topics` 与 `topic_messages` 分离：话题结论和来源消息是多对多关系，可直接支撑“查看依据”。
- 先规则清洗、再模型聚类：过滤占位消息、链接包装、过短内容与重复转发后再调用模型，节省成本且结果更稳定。
- 演示数据可独立启动：没有真实微信数据也能看到产品价值。
- 链接规范化、跨群计数、历史均值对比等都应独立成可测试模块。

### 不直接复用

- 它当前以 Next.js 浏览器看板为主，不是 Windows Electron 桌面应用。
- 微信数据入口与 `wx-cli`、macOS 环境耦合，不符合 PrivateRadar 的文件导入优先原则。
- 其现有消息主键偏向单一微信来源，不足以覆盖多平台标准消息模型。
- 规则式话题定义适合看板增强，但不能成为 PrivateRadar 的唯一主题识别机制。

## 2. chat-analyzer

### 值得学习

- 所有来源进入统一 `messages` 表，平台只是字段；这是 PrivateRadar 的核心数据原则。
- `(platform, chat_id, source_id)` 唯一索引与 `INSERT OR IGNORE` 展示了增量导入的基础做法。
- 数据库启用 WAL、合理索引与忙等待，适合本地持续导入。
- 分析流水线先做 `pre_filter`，再按 30 分钟间隔切对话窗口；大窗口拆分并保留少量重叠。
- AI 结果保留 `source_message_ids`，检索结果与答案可以回查证据。
- Embedding 记录模型信息，模型变化时可重建索引。
- 对时间标准化、重复分析、增量处理和来源编号写了行为测试。

### 不直接复用

- 后端采用 Python、FastAPI 和 `aiosqlite`，会增加 PrivateRadar 的语言和部署复杂度。
- 其范围包含联系人画像、待办、QQ、Telegram 等，均超出 V0.1。
- 目前主要语义索引面向知识条目，而 PrivateRadar 需要以原始消息和话题证据为核心。
- 当前代码未把 FTS 作为统一消息搜索的完整基础设施，PrivateRadar 将直接使用 SQLite FTS5。

## 3. baoyu-wechat-summary

### 值得学习

- `history.json` 保存最新断点，追加式历史文件保存每次摘要元数据；“快速游标 + 不可变审计记录”的组合很实用。
- 增量模式会剔除断点之前的消息，并在无新消息时停止，避免重复花费。
- 摘要中的话题、引言、人物都强调来源归属，适合转化为结构化的 `source_message_ids`。
- 对事实记忆设置“具体事实、有证据、无人反驳”门槛，并保留修订与作废记录。
- 明确把群消息视为数据而非系统指令，防止聊天内容对分析代理进行提示注入。

### 不直接复用

- 它是依赖 `wx-cli` 的代理技能，不是可嵌入桌面应用的数据引擎。
- 本地文件式画像和群记忆超出 V0.1，且人物画像已被任务书明确禁止。
- `MM-DD HH:MM` 断点存在跨年比较风险；PrivateRadar 统一使用带时区的 ISO 8601 时间和稳定消息指纹。

## 最终复用决定

本阶段采用“思路复用、代码零复制”：

1. 采用统一标准消息模型，任何数据源只能经 Adapter 写入核心数据库。
2. SQLite 启用 WAL、外键、常用组合索引和 FTS5。
3. 消息同时保留来源编号与内容指纹；阶段 C 用二者完成可解释去重。
4. 分析产物必须通过关系表或 JSON 来源编号指回原始消息。
5. 使用“规则去噪 → 时间窗口 → 候选提取 → 语义聚类 → 模型摘要”的流水线。
6. 增量状态保存在 `import_jobs.cursor_json`，每次运行另写 `analysis_runs`，兼顾续跑与审计。
7. 群聊内容进入模型前按不可信数据处理，模型输出做结构校验。

## 最终 V0.1 架构

```text
JSON / CSV / TXT / 演示数据 / WorkBuddy（实验）
                    │
                 Adapter
                    │
          StandardMessage + 校验
                    │
      指纹去重 + 增量游标 + 导入审计
                    │
       SQLite（消息、FTS5、分析、来源）
                    │
     Intelligence Engine + AIProvider
          ┌─────────┼─────────┐
       今日情报   话题雷达   问我的聊天
          └─────────┼─────────┘
             Electron + React
```

### 进程边界

- Electron 主进程：文件系统、SQLite、导入和分析任务。
- 预加载桥：只暴露白名单 IPC 方法，不向页面暴露 Node.js。
- React 渲染进程：只负责页面和用户交互。
- AI Provider：以后支持 OpenAI 兼容接口与 Ollama；真实调用必须由用户显式配置，并提示数据可能离开本机。

### 数据库取舍

- 当前已建立任务书要求的 10 类核心表。
- 实现使用 Electron 44 内置 Node.js 的原生 SQLite 接口，避免 Windows 用户为原生扩展安装 C++ 编译环境；如果后续性能实测达不到 10 万条目标，再通过仓储层替换实现。
- 消息主键使用适配器提供的稳定编号；`fingerprint` 作为跨重复导入防线。
- 时间统一存储带时区的 ISO 8601 字符串。
- FTS5 与 `messages` 通过触发器同步。
- Embedding 先保留表结构，阶段 F 再选择本地向量计算或兼容接口。

## 明确不采用的内容

- 不读取、破解、Hook 或解密微信数据库。
- 不依赖 `wx-cli`、WeFlow 或 WorkBuddy。
- 不复制三个参考仓库的 UI、提示词或实现代码。
- 不引入 Python 服务，不做登录、云同步、人物画像或待办。

## WorkBuddy：已知事实与待验证项

### 官方资料已确认

- WorkBuddy 连接器官方推荐 MCP + Skill；本地 MCP 可使用 `stdio`，远程 MCP 支持 HTTPS 的 SSE 或 Streamable HTTP。
- 自定义连接器包含元信息、MCP 配置、图标和可选 Skill；一个连接器配置一个 MCP Server。
- 官方提供 OAuth 2.1 + PKCE 流程，也支持用户本地填写 Token。
- 第三方应用开放“本地助理在线状态与会话消息历史”权限，但需要应用注册、用户授权和平台审核。
- 这些能力证明 PrivateRadar 可以作为“被 WorkBuddy 调用的 MCP 工具”进行后续原型验证。

### 尚未验证

- 用户从微信把聊天记录分享到 WorkBuddy 后，模型上下文是否包含群名、发送人、原始时间、网址和稳定消息顺序。
- Connector 的 MCP 工具调用能否收到上述字段的结构化形式，而非只有一段模型整理后的文本。
- 本地助理“会话消息历史”接口是否能读取微信分享卡片内部结构；官方说明只证明可读 WorkBuddy 会话，不等于可读微信原始消息。
- 申请与审核是否对个人开发者开放、是否产生费用、配额和发布限制。

因此当前状态为 `NEEDS_PLATFORM_VALIDATION`，不是 `BLOCKED_BY_PLATFORM`。阶段 G 将用最小 MCP `import_messages` 工具实测；失败时记录为 `BLOCKED_BY_PLATFORM`，FileAdapter 仍是正式入口。

## 研究来源

- <https://github.com/zjp1997720/wechat-radar>
- <https://github.com/ye4wzp/chat-analyzer>
- <https://github.com/JimLiu/baoyu-skills/tree/main/skills/baoyu-wechat-summary>
- <https://open.workbuddy.cn/docs/connector>
- <https://open.workbuddy.cn/docs/third-party-app>
