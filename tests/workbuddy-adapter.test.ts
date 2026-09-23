import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { buildTopicRadar } from '../src/main/intelligence/topics/pipeline'
import { loadMessagesForDate, runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'

const databases: DatabaseSync[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  databases.push(db)
  return db
}

function storedMessage(db: DatabaseSync): StoredMessage {
  return db.prepare(`
    SELECT id, conversation_name, sender_name, timestamp, content,
           conversation_name_source, sender_name_source, timestamp_source,
           content_source, stable_identity, fingerprint
    FROM messages
  `).get() as unknown as StoredMessage
}

describe('正式 WorkBuddyAdapter 与消息身份治理', () => {
  it('完整消息进入现有数据库并记录字段来源', () => {
    const db = database()
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: '完整分享-1',
      messages: [{
        platform: 'wechat', conversation_name: 'AI 开发群', sender_name: '张三',
        timestamp: '2026-09-13 11:19', content: 'Claude Code 发布了新功能。', source_position: 0
      }]
    })
    const row = storedMessage(db)
    expect(result).toMatchObject({ importedCount: 1, updatedCount: 0, invalidCount: 0 })
    expect(row).toMatchObject({
      conversation_name_source: 'user_supplied', sender_name_source: 'user_supplied',
      timestamp_source: 'user_supplied', content_source: 'source_native'
    })
  })

  it('只有正文也能导入，缺失群名、发送人和时间保持空值与 unknown', () => {
    const db = database()
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: '仅正文-1', messages: [{ content: '公众号文章美化工具值得试用。' }]
    })
    expect(result.importedCount).toBe(1)
    expect(storedMessage(db)).toMatchObject({
      conversation_name: null, sender_name: null, timestamp: null,
      conversation_name_source: 'unknown', sender_name_source: 'unknown', timestamp_source: 'unknown'
    })
  })

  it.each([
    ['群名', { sender_name: '张三', timestamp: '2026-09-13 11:19' }, 'conversation_name_source'],
    ['发送人', { conversation_name: '测试群', timestamp: '2026-09-13 11:19' }, 'sender_name_source'],
    ['时间', { conversation_name: '测试群', sender_name: '张三' }, 'timestamp_source']
  ] as const)('单独缺少%s时该条仍可写入且来源为 unknown', (_label, metadata, sourceColumn) => {
    const db = database()
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: `缺字段-${sourceColumn}`,
      messages: [{ content: 'DataNest 1.4 增量同步已发布。', ...metadata }]
    })
    expect(result.importedCount).toBe(1)
    expect(storedMessage(db)[sourceColumn]).toBe('unknown')
  })

  it('先导入正文再补齐群名、发送人和时间，只更新同一条消息', () => {
    const db = database()
    const initial = ingestWorkBuddyMessages(db, {
      source_batch_id: '补全批次-1', messages: [{ content: 'PrivateIndex 支持本地聊天索引。', source_position: 0 }]
    })
    const before = storedMessage(db)
    const enriched = ingestWorkBuddyMessages(db, {
      source_batch_id: '补全批次-1',
      messages: [{
        content: 'PrivateIndex 支持本地聊天索引。', source_position: 0,
        conversation_name: '独立开发群', sender_name: '云舒', timestamp: '2026-09-13 11:20'
      }]
    })
    const after = storedMessage(db)
    expect(initial.importedCount).toBe(1)
    expect(enriched).toMatchObject({ importedCount: 0, updatedCount: 1, duplicateCount: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    expect(after.id).toBe(before.id)
    expect(after.stable_identity).toBe(before.stable_identity)
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after).toMatchObject({ conversation_name: '独立开发群', sender_name: '云舒', timestamp_source: 'user_supplied' })
    expect(after.timestamp).not.toBe('')
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'PrivateIndex'").get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE name = '独立开发群'").get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM participants WHERE display_name = '云舒'").get()).toEqual({ count: 1 })
  })

  it('source_native 字段不被后续 user_supplied 覆盖', () => {
    const db = database()
    ingestWorkBuddyMessages(db, {
      source_batch_id: '原生优先-1', messages: [{
        content: '原始正文', conversation_name: '原生群', sender_name: '原生发送人', timestamp: '2026-09-13 10:00',
        conversation_name_source: 'source_native', sender_name_source: 'source_native', timestamp_source: 'source_native'
      }]
    })
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: '原生优先-1', messages: [{
        content: '原始正文', conversation_name: '人工群', sender_name: '人工发送人', timestamp: '2026-09-13 12:00'
      }]
    })
    expect(result).toMatchObject({ updatedCount: 0, duplicateCount: 1 })
    expect(storedMessage(db)).toMatchObject({ conversation_name: '原生群', sender_name: '原生发送人' })
  })

  it('user_supplied 字段不被 inferred 覆盖', () => {
    const db = database()
    ingestWorkBuddyMessages(db, {
      source_batch_id: '人工优先-1', messages: [{ content: '同一正文', sender_name: '用户确认的张三' }]
    })
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: '人工优先-1', messages: [{ content: '同一正文', sender_name: '系统猜测的李四', sender_name_source: 'inferred' }]
    })
    expect(result).toMatchObject({ updatedCount: 0, duplicateCount: 1 })
    expect(storedMessage(db).sender_name).toBe('用户确认的张三')
  })

  it('同一分享重复调用保持幂等且身份与指纹不随元数据补全改变', () => {
    const db = database()
    const input = { source_batch_id: '幂等批次-1', messages: [{ content: 'GitHub 项目：https://github.com/example/repo' }] }
    ingestWorkBuddyMessages(db, input)
    const before = storedMessage(db)
    const repeated = ingestWorkBuddyMessages(db, input)
    const after = storedMessage(db)
    expect(repeated).toMatchObject({ importedCount: 0, updatedCount: 0, duplicateCount: 1 })
    expect(after.stable_identity).toBe(before.stable_identity)
    expect(after.fingerprint).toBe(before.fingerprint)
  })

  it('缺元数据时今日情报、话题雷达和正文搜索均不会崩溃', async () => {
    const db = database()
    ingestWorkBuddyMessages(db, {
      source_batch_id: '降级批次-1', messages: [{ content: 'PrivateIndex 本地索引项目：https://github.com/example/private-index' }]
    })
    const date = new Date().toISOString().slice(0, 10)
    expect(() => runDailyIntelligence(db, date)).not.toThrow()
    expect(() => buildTopicRadar({ messages: loadMessagesForDate(db, date), date })).not.toThrow()
    const response = await askChat(db, 'PrivateIndex', { anchorDate: date, aiProvider: null, embeddingProvider: null })
    expect(response.insufficientEvidence).toBe(false)
    expect(response.results[0]?.content).toContain('PrivateIndex')
  })

  it('缺群名的消息不会被计算成跨群传播', () => {
    const db = database()
    const date = '2026-09-13'
    ingestWorkBuddyMessages(db, {
      source_batch_id: '无群名话题-1',
      messages: Array.from({ length: 5 }, (_, index) => ({
        content: `NovaFlow 2.0 发布工作流引擎，新功能反馈 ${index + 1}。`,
        sender_name: `发送人${index + 1}`, timestamp: `${date} 11:${String(index).padStart(2, '0')}`, source_position: index
      }))
    })
    const result = buildTopicRadar({
      messages: loadMessagesForDate(db, date), date, availableHistoryDates: [],
      config: { historyDays: 7, topLimit: 20, minimumSignalScore: 0, similarityThreshold: 0.46 }
    })
    expect(result.topics.length).toBeGreaterThan(0)
    expect(result.topics.every((topic) => topic.conversationCount === 0)).toBe(true)
    expect(result.topics.every((topic) => !topic.reasonCodes.includes('MULTI_CONVERSATION') && !topic.reasonCodes.includes('CROSS_GROUP_SPREAD'))).toBe(true)
  })
})

interface StoredMessage {
  id: string
  conversation_name: string | null
  sender_name: string | null
  timestamp: string | null
  content: string
  conversation_name_source: string
  sender_name_source: string
  timestamp_source: string
  content_source: string
  stable_identity: string
  fingerprint: string
  [key: string]: string | null
}
