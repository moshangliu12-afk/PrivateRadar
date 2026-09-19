import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { StandardMessage } from '../shared/models'

const GROUPS = [
  ['group-ai', 'AI 产品观察站'],
  ['group-dev', '独立开发者茶馆'],
  ['group-content', '内容创作实验室'],
  ['group-tools', '效率工具交流群']
] as const

const USERS = [
  ['u01', '林舟'], ['u02', '小满'], ['u03', '阿诚'], ['u04', '云舒'],
  ['u05', '嘉木'], ['u06', '北辰'], ['u07', '方糖'], ['u08', '木棉']
] as const

const ORDINARY = [
  '早上好，今天继续推进手上的事情。',
  '收到，我晚一点看一下。',
  '中午有人一起吃饭吗？',
  '这个周末天气看起来不错。',
  '感谢分享，先收藏了。',
  '我也遇到过类似情况，稍后再聊。'
]

const SIGNALS = [
  'Claude Code 新版的子代理体验明显更顺，适合拆分代码审查任务。',
  '有人试过 Anthropic coding agent 吗？听说现在能并行处理多个开发任务。',
  'Claude 编程工具最近更新后，长任务的上下文保持能力更好了。',
  '这个公众号排版工具支持 Markdown 导入，地址是 https://example.com/wechat-layout 。',
  '分享一个微信小程序的开源项目：https://github.com/example/miniprogram-starter 。',
  '本地运行的 Ollama 很适合敏感资料，聊天原文不用发到云端。',
  '提醒：明天下午三点有 AI 产品发布会，报名今晚截止。',
  '实测新的知识库检索方案，全文搜索和语义检索混合效果更稳。'
]

function localDate(daysAgo: number): string {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - daysAgo)
  return date.toISOString().slice(0, 10)
}

function fingerprint(message: StandardMessage): string {
  return createHash('sha256')
    .update([
      message.platform,
      message.conversationId,
      message.senderId,
      message.timestamp,
      message.content.trim().replace(/\s+/g, ' ')
    ].join('\u001f'))
    .digest('hex')
}

export function createDemoMessages(): StandardMessage[] {
  const messages: StandardMessage[] = []
  for (let day = 6; day >= 0; day -= 1) {
    const date = localDate(day)
    for (let index = 0; index < 172; index += 1) {
      const group = GROUPS[index % GROUPS.length]
      const user = USERS[(index + day) % USERS.length]
      const isSignal = index % 7 === 0 || (day === 0 && index % 5 === 0)
      const content = isSignal
        ? SIGNALS[(index + day) % SIGNALS.length]
        : ORDINARY[(index * 3 + day) % ORDINARY.length]
      const minute = (index * 7) % 60
      const hour = 8 + (index % 14)
      const timestamp = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`
      messages.push({
        messageId: `demo-${date}-${index}`,
        platform: 'demo',
        conversationId: group[0],
        conversationName: group[1],
        senderId: user[0],
        senderName: user[1],
        timestamp,
        content,
        messageType: content.includes('http') ? 'link' : 'text',
        links: content.match(/https?:\/\/\S+/g) ?? [],
        attachments: [],
        replyTo: null,
        source: 'demo-generator',
        rawMetadata: { demo: true, sequence: index },
        conversationNameSource: 'source_native',
        senderNameSource: 'source_native',
        timestampSource: 'source_native',
        contentSource: 'source_native',
        stableIdentity: `demo:${date}:${index}`,
        sourceBatchId: `demo:${date}`,
        sourcePosition: index
      })
    }
  }
  messages.push(...createDesignedTodayMessages())
  messages.push(...createTopicRadarScenarioMessages())
  return messages
}

function createDesignedTodayMessages(): StandardMessage[] {
  const date = localDate(0)
  const rows = [
    ['group-ai', 'AI 产品观察站', 'u01', '林舟', '09:02', 'PrivateIndex 开源了本地聊天索引方案：https://github.com/example/private-index'],
    ['group-dev', '独立开发者茶馆', 'u03', '阿诚', '09:08', '刚试了 GitHub 上的 PrivateIndex，十万条消息导入很顺：https://github.com/example/private-index'],
    ['group-tools', '效率工具交流群', 'u06', '北辰', '09:16', '推荐这个 private-index 项目，本地优先设计值得参考：https://github.com/example/private-index'],
    ['group-ai', 'AI 产品观察站', 'u02', '小满', '10:05', 'LocalLens 2.0 今日正式发布，新增离线文档检索，官方说明：https://locallens.example.com/changelog/2.0'],
    ['group-content', '内容创作实验室', 'u04', '云舒', '10:40', `今天早上出门的时候天气还不错，路上买了咖啡，后来又绕路去了趟超市，回家以后整理桌面，想了很久中午吃什么，最后还是点了经常吃的那一家。${'然后继续聊了一些没有结论的日常琐事。'.repeat(12)}`],
    ['group-ai', 'AI 产品观察站', 'u05', '嘉木', '11:10', 'DataNest 1.4 今天发布了增量同步功能。'],
    ['group-dev', '独立开发者茶馆', 'u07', '方糖', '11:18', 'DataNest 新版本加入增量同步，升级后不用重新扫描全部文件。'],
    ['group-tools', '效率工具交流群', 'u08', '木棉', '11:26', '刚升级 DataNest 1.4，增量导入功能已经可以用了。'],
    ['group-dev', '独立开发者茶馆', 'u03', '阿诚', '13:05', '官方安全公告：依赖解析漏洞已修复，请升级到 4.2.1：https://docs.example.org/security/4.2.1'],
    ['group-content', '内容创作实验室', 'u04', '云舒', '14:20', '2026 年内容工具调研报告已经整理成 PDF 文件，下载：https://example.com/reports/content-tools.pdf'],
    ['group-ai', 'AI 产品观察站', 'u01', '林舟', '15:00', 'GPT-5.6 发布了'],
    ['group-tools', '效率工具交流群', 'u06', '北辰', '16:15', '明天 10 点产品内测报名截止，申请文档：https://example.com/beta']
  ] as const
  return rows.map((row, index) => ({
    messageId: `demo-designed-${date}-${index}`,
    platform: 'demo',
    conversationId: row[0],
    conversationName: row[1],
    senderId: row[2],
    senderName: row[3],
    timestamp: `${date}T${row[4]}:00+08:00`,
    content: row[5],
    messageType: row[5].includes('http') ? 'link' : 'text',
    links: row[5].match(/https?:\/\/\S+/g) ?? [],
    attachments: [],
    replyTo: null,
    source: 'demo-generator',
    rawMetadata: { demo: true, designedScenario: true },
    conversationNameSource: 'source_native',
    senderNameSource: 'source_native',
    timestampSource: 'source_native',
    contentSource: 'source_native',
    stableIdentity: `demo:designed:${date}:${index}`,
    sourceBatchId: `demo:designed:${date}`,
    sourcePosition: index
  }))
}

function createTopicRadarScenarioMessages(): StandardMessage[] {
  const messages: StandardMessage[] = []
  const risingCounts: Record<number, number> = { 6: 0, 5: 0, 4: 1, 3: 1, 2: 2, 1: 3, 0: 28 }
  const spreadingCounts: Record<number, number> = { 6: 1, 5: 2, 4: 3, 3: 5, 2: 8, 1: 12, 0: 20 }

  for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
    const date = localDate(daysAgo)
    const steadyCount = daysAgo === 0 ? 13 : 12
    for (let index = 0; index < steadyCount; index += 1) {
      messages.push(scenarioMessage('steady', date, index, `StackTalk 日常技术社区讨论，插件生态和使用经验第 ${index + 1} 条。`, index % 4, index % 6))
    }
    for (let index = 0; index < risingCounts[daysAgo]; index += 1) {
      messages.push(scenarioMessage('rising', date, index, `NovaFlow 新版工作流引擎正在扩散，第 ${index + 1} 位用户分享了实际体验。`, index % 4, index % 8))
    }
    const spamCount = daysAgo === 0 ? 70 : 1
    for (let index = 0; index < spamCount; index += 1) {
      messages.push(scenarioMessage('spam', date, index, `BuzzBoard 单群刷屏测试消息 ${index + 1}，内容来自同一个发送人。`, 1, 2))
    }
    for (let index = 0; index < spreadingCounts[daysAgo]; index += 1) {
      messages.push(scenarioMessage('spread', date, index, `MeshNote 协作文档在不同群逐步传播，第 ${index + 1} 条体验反馈。`, index % Math.min(4, Math.max(1, spreadingCounts[daysAgo])), index % 8))
    }
  }

  const today = localDate(0)
  messages.push(scenarioMessage('single', today, 0, 'SoloKit 1.0 发布离线备份功能，官方说明：https://solokit.example.com/releases/1.0', 2, 5))
  for (let index = 0; index < 3; index += 1) {
    messages.push(scenarioMessage('claude-crash', today, index, `Claude Code Windows 启动崩溃问题，用户 ${index + 1} 报告了相同错误。`, index % 2, index))
  }
  messages.push(scenarioMessage('semantic-layout', localDate(2), 0, 'Markdown 编辑器适合公众号排版，导出后的文章样式很稳。', 2, 3))
  return messages
}

function scenarioMessage(
  scenario: string,
  date: string,
  index: number,
  content: string,
  groupIndex: number,
  userIndex: number
): StandardMessage {
  const group = GROUPS[groupIndex % GROUPS.length]
  const user = USERS[userIndex % USERS.length]
  const hour = 7 + (index % 15)
  const minute = (index * 11 + scenario.length) % 60
  return {
    messageId: `demo-topic-${scenario}-${date}-${index}`,
    platform: 'demo',
    conversationId: group[0],
    conversationName: group[1],
    senderId: user[0],
    senderName: user[1],
    timestamp: `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:30+08:00`,
    content,
    messageType: content.includes('http') ? 'link' : 'text',
    links: content.match(/https?:\/\/\S+/g) ?? [],
    attachments: [],
    replyTo: null,
    source: 'demo-generator',
    rawMetadata: { demo: true, topicRadarScenario: scenario },
    conversationNameSource: 'source_native',
    senderNameSource: 'source_native',
    timestampSource: 'source_native',
    contentSource: 'source_native',
    stableIdentity: `demo:topic:${scenario}:${date}:${index}`,
    sourceBatchId: `demo:topic:${scenario}:${date}`,
    sourcePosition: index
  }
}

export function seedDemoData(db: DatabaseSync): { inserted: number; duplicates: number } {
  const now = new Date().toISOString()
  const insertConversation = db.prepare(`
    INSERT OR IGNORE INTO conversations (id, platform, name, conversation_type, created_at)
    VALUES (?, 'demo', ?, 'group', ?)
  `)
  const insertParticipant = db.prepare(`
    INSERT OR IGNORE INTO participants (id, platform, display_name, created_at)
    VALUES (?, 'demo', ?, ?)
  `)
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (
      id, platform, conversation_id, conversation_name, sender_id, sender_name,
      timestamp, content, message_type, links_json, attachments_json, reply_to,
      source, raw_metadata_json, stable_identity, source_batch_id, source_position,
      conversation_name_source, sender_name_source, timestamp_source, content_source,
      fingerprint, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO message_links (message_id, url, canonical_url)
    VALUES (?, ?, ?)
  `)

  let inserted = 0
  let duplicates = 0
  db.exec('BEGIN')
  try {
    for (const [id, name] of GROUPS) insertConversation.run(id, name, now)
    for (const [id, name] of USERS) insertParticipant.run(id, name, now)
    for (const message of createDemoMessages()) {
      const result = insertMessage.run(
        message.messageId,
        message.platform,
        message.conversationId,
        message.conversationName,
        message.senderId,
        message.senderName,
        message.timestamp,
        message.content,
        message.messageType,
        JSON.stringify(message.links),
        JSON.stringify(message.attachments),
        message.replyTo,
        message.source,
        JSON.stringify(message.rawMetadata),
        message.stableIdentity,
        message.sourceBatchId,
        message.sourcePosition,
        message.conversationNameSource,
        message.senderNameSource,
        message.timestampSource,
        message.contentSource,
        fingerprint(message),
        now
      )
      if (Number(result.changes) === 1) inserted += 1
      else duplicates += 1
      for (const url of message.links) insertLink.run(message.messageId, url, url)
    }
    db.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES ('demo_mode', 'true', ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(now)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { inserted, duplicates }
}
