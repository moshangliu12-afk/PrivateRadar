import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { hybridSearch } from '../src/main/retrieval/hybrid-search'
import { understandQuery } from '../src/main/retrieval/query-understanding'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'

const databases: DatabaseSync[] = []
const anchorDate = '2026-09-19'
const searchOptions = { anchorDate, aiProvider: null, embeddingProvider: null }

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  databases.push(db)
  return db
}

function addConversation(db: DatabaseSync, id: string, name: string): void {
  db.prepare(`
    INSERT INTO conversations (id, platform, name, conversation_type, created_at)
    VALUES (?, 'wechat', ?, 'group', '2026-09-19T00:00:00.000Z')
  `).run(id, name)
}

function addMessage(db: DatabaseSync, id: string, conversationId: string, name: string | null, timestamp: string | null = null): void {
  db.prepare(`
    INSERT INTO messages (
      id, platform, conversation_id, conversation_name, sender_id, sender_name,
      sender_name_source, timestamp, timestamp_source, content, message_type,
      source, fingerprint, imported_at
    ) VALUES (?, 'wechat', ?, ?, 'sender', NULL, 'unknown', ?, ?,
      '资格认证', 'text', 'fixture', ?, '2026-09-19T11:46:39.338Z')
  `).run(id, conversationId, name, timestamp, timestamp ? 'source_native' : 'unknown', id)
}

describe('查询理解忽略不可用名称', () => {
  it.each([
    ['', '资格认证'],
    ['   ', '资格认证'],
    ['', '领取社保待遇'],
    ['   ', '领取社保待遇'],
    ['', 'microsoft/vscode'],
    ['   ', 'microsoft/vscode']
  ])('会话名为 %j 时保持查询 %s 完整且不追加过滤', (name, query) => {
    const db = database()
    addConversation(db, 'unnamed', name)
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.conversationIds).toEqual([])
    expect(understanding.conversationNames).toEqual([])
    expect(understanding.senderIds).toEqual([])
    expect(understanding.coreTopics).toEqual([query])
    expect(understanding.expandedTerms).toEqual([query])
    expect(understanding.searchTerms).toEqual([query])
    expect(understanding.isNaturalLanguage).toBe(false)
  })

  it.each([null, undefined])('查询读取边界出现 %s 名称时安全忽略', (name) => {
    // 正式会话表禁止空值；这里验证读取边界不会把异常值转成查询词。
    const db = {
      prepare: (sql: string) => ({ all: () => sql.includes('FROM conversations') ? [{ id: 'invalid', name }] : [] })
    } as unknown as DatabaseSync
    const query = `${String(name)} 资格认证`
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.conversationIds).toEqual([])
    expect(understanding.conversationNames).toEqual([])
    expect(understanding.coreTopics).toEqual([query])
    expect(understanding.expandedTerms).toEqual([query])
    expect(understandQuery(db, '物业群 停车', anchorDate).conversationIds).toEqual([])
  })

  it('问题含连续空格时空白会话名也不得命中或移除问题内容', () => {
    const db = database()
    addConversation(db, 'spaces', '   ')
    const understanding = understandQuery(db, '资格认证   领取社保待遇', anchorDate)
    expect(understanding.conversationIds).toEqual([])
    expect(understanding.conversationNames).toEqual([])
    expect(understanding.coreTopics).toEqual(['资格认证 领取社保待遇'])
  })

  it('合法会话名称仍识别并从内容查询中剥离', () => {
    const db = database()
    addConversation(db, 'building', "合成纸偶排练组")
    const understanding = understandQuery(db, "合成纸偶排练组 停车", anchorDate)
    expect(understanding.conversationIds).toEqual(['building'])
    expect(understanding.conversationNames).toEqual(["合成纸偶排练组"])
    expect(understanding.coreTopics).toEqual(['停车'])
    expect(understanding.searchTerms).toEqual(['停车'])
  })

  it('空名与合法名称并存时只匹配合法会话', () => {
    const db = database()
    addConversation(db, 'empty', '')
    addConversation(db, 'spaces', '   ')
    addConversation(db, 'building', "合成纸偶排练组")
    const understanding = understandQuery(db, "合成纸偶排练组 停车", anchorDate)
    expect(understanding.conversationIds).toEqual(['building'])
    expect(understanding.conversationNames).toEqual(["合成纸偶排练组"])
    expect(understanding.expandedTerms).toEqual(['停车'])
    expect(understanding.searchTerms).toEqual(['停车'])
  })

  it('群提示匹配也忽略空白会话名并保留合法匹配', () => {
    const db = database()
    addConversation(db, 'empty', '')
    addConversation(db, 'spaces', '   ')
    addConversation(db, 'building', '物业通知交流群')
    const understanding = understandQuery(db, '物业群 停车', anchorDate)
    expect(understanding.conversationIds).toEqual(['building'])
    expect(understanding.conversationNames).toEqual(['物业通知交流群'])
  })

  it('纯空格发送人名称不命中或改写问题', () => {
    const db = database()
    addConversation(db, 'unnamed', '')
    addMessage(db, 'unknown', 'unnamed', null)
    db.prepare("UPDATE messages SET sender_name = '   ', sender_name_source = 'source_native'").run()
    const understanding = understandQuery(db, '资格认证   领取社保待遇', anchorDate)
    expect(understanding.senderIds).toEqual([])
    expect(understanding.senderNames).toEqual([])
    expect(understanding.conversationIds).toEqual([])
    expect(understanding.coreTopics).toEqual(['资格认证 领取社保待遇'])
  })
})

describe('空名称消息的检索与时间语义', () => {
  it.each([null, ''])('群名为 %j 的未知时间消息仍可普通检索且不标记已确认', async (name) => {
    const db = database()
    addConversation(db, 'unnamed', '')
    addMessage(db, 'unknown', 'unnamed', name)
    const response = await askChat(db, '资格认证', searchOptions)
    expect(response.insufficientEvidence).toBe(false)
    expect(response.understanding.conversationIds).toEqual([])
    expect(response.results).toContainEqual(expect.objectContaining({
      messageId: 'unknown', content: '资格认证', timestamp: '', timeVerification: 'unknown'
    }))
    expect(response.unverifiedTimeResults).toEqual([])
    expect(db.prepare("SELECT timestamp, timestamp_source FROM messages WHERE id = 'unknown'").get())
      .toMatchObject({ timestamp: null, timestamp_source: 'unknown' })
  })

  it('普通查询可找到同一未知消息，明确日期查询不返回该消息', async () => {
    const db = database()
    addConversation(db, 'unnamed', '')
    addMessage(db, 'unknown', 'unnamed', null)
    expect((await askChat(db, '资格认证', searchOptions)).sourceMessageIds).toContain('unknown')
    const response = await askChat(db, '2026-09-19 资格认证', searchOptions)
    expect(response.understanding.dateRange).toMatchObject({ start: anchorDate, end: anchorDate })
    expect(response.understanding.timeIntent).toBe('strict')
    expect(response.results).toEqual([])
    expect(response.unverifiedTimeResults).toEqual([])
    expect(response.sourceMessageIds).not.toContain('unknown')
  })

  it('独立核验日期筛选：相同正文与导入日下只保留可靠发生时间', async () => {
    const db = database()
    addConversation(db, 'unnamed', '')
    addMessage(db, 'unknown', 'unnamed', null)
    addMessage(db, 'known', 'unnamed', '', '2026-09-19T09:00:00+08:00')
    const understanding = understandQuery(db, '资格认证', anchorDate)
    const dated = understandQuery(db, '2026-09-19 资格认证', anchorDate)
    // 保留普通查询内容词，独立验证真实日期筛选，避免日期字面量影响召回。
    const response = await hybridSearch(db, '资格认证', {
      ...understanding, dateRange: dated.dateRange, timeIntent: dated.timeIntent
    }, null)
    expect(response.results.map((item) => item.messageId)).toEqual(['known'])
    expect(response.results[0].timeVerification).toBe('verified')
    expect(response.unverifiedTimeResults).toEqual([])
  })
})

function namedDatabase(): DatabaseSync {
  const db = database()
  addConversation(db, 'names-group', '名称测试群')
  return db
}

function addNamedSender(db: DatabaseSync, id: string, name: string): void {
  addMessage(db, id, 'names-group', '名称测试群')
  db.prepare("UPDATE messages SET sender_id = ?, sender_name = ?, sender_name_source = 'source_native' WHERE id = ?")
    .run(id, name, id)
}

describe('纯符号名称不参与查询理解', () => {
  it.each(['-', '/', '.', '_', '·', '---', '...', '🚀'])('发送人 %s 不生成过滤或改写查询', (name) => {
    const db = namedDatabase()
    addNamedSender(db, 'symbol-sender', name)
    const query = `${name} 资格认证`
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.senderIds).toEqual([])
    expect(understanding.senderNames).toEqual([])
    expect(understanding.conversationIds).toEqual([])
    expect(understanding.coreTopics).toEqual([query])
    expect(db.prepare("SELECT sender_name FROM messages WHERE id = 'symbol-sender'").get())
      .toMatchObject({ sender_name: name })
  })

  it.each(['-', '/', '·'])('会话 %s 不生成过滤或改写查询', (name) => {
    const db = database()
    addConversation(db, 'symbol-group', name)
    const query = `${name} 资格认证`
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.conversationIds).toEqual([])
    expect(understanding.conversationNames).toEqual([])
    expect(understanding.coreTopics).toEqual([query])
    expect(db.prepare("SELECT name FROM conversations WHERE id = 'symbol-group'").get()).toMatchObject({ name })
  })

  it.each(['A', '李', '虚构用户4', '·虚构用户4', 'Claude', 'user_01', '5', 'Ж'])('合法发送人 %s 仍生成过滤', (name) => {
    const db = namedDatabase()
    addNamedSender(db, 'valid-sender', name)
    const understanding = understandQuery(db, `${name} 资格认证`, anchorDate)
    expect(understanding.senderIds).toEqual(['valid-sender'])
    expect(understanding.senderNames).toEqual([name])
    expect(understanding.coreTopics).toEqual(['资格认证'])
  })

  it('连字符产品查询保持完整并召回另一发送人的正文', async () => {
    const db = namedDatabase()
    addNamedSender(db, 'hyphen-sender', '-')
    addMessage(db, 'product', 'names-group', '名称测试群', '2026-09-20T04:00:00.000Z')
    db.prepare("UPDATE messages SET content = '文字模型换成了 Claude-Sonnet-5，生成的效果会更好一些。' WHERE id = 'product'").run()
    const response = await askChat(db, 'Claude-Sonnet-5', searchOptions)
    expect(response.understanding.senderIds).toEqual([])
    expect(response.understanding.senderNames).toEqual([])
    expect(response.understanding.coreTopics).toEqual(['Claude-Sonnet-5'])
    expect(response.understanding.searchTerms).toContain('Claude-Sonnet-5')
    expect(response.understanding.expandedTerms).not.toContain('Claude Sonnet 5')
    expect(response.results).toContainEqual(expect.objectContaining({ messageId: 'product', timeVerification: 'verified' }))
  })

  it('ISO 日期不触发连字符发送人过滤，可靠消息保留且未知时间仍排除', async () => {
    const db = namedDatabase()
    addNamedSender(db, 'hyphen-sender', '-')
    addMessage(db, 'github-known', 'names-group', '名称测试群', '2026-09-20T03:39:00.000Z')
    addMessage(db, 'github-unknown', 'names-group', '名称测试群')
    db.prepare("UPDATE messages SET content = '我已经把我这个工具传到GitHub上面去了' WHERE id IN ('github-known', 'github-unknown')").run()
    const query = '2026-09-20 GitHub'
    const response = await askChat(db, query, searchOptions)
    expect(response.understanding.senderIds).toEqual([])
    expect(response.understanding.senderNames).toEqual([])
    expect(response.understanding.coreTopics).toEqual([query])
    expect(response.understanding.dateRange).toMatchObject({ start: '2026-09-20', end: '2026-09-20' })
    expect(response.understanding.timeIntent).toBe('strict')
    expect(response.results.map((item) => item.messageId)).toEqual(['github-known'])
    expect(response.results[0].timeVerification).toBe('verified')
    expect(response.unverifiedTimeResults).toEqual([])
  })
})
