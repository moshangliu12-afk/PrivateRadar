import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAIProvider } from '../src/main/ai/mock-provider'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { buildAIInput } from '../src/main/intelligence/daily/brief'
import { DAILY_ALGORITHM_VERSION } from '../src/main/intelligence/daily/pipeline'
import { loadSavedDailyCandidates, runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import { loadSavedTopicRadar, runTopicRadar } from '../src/main/intelligence/topics/repository'
import { askChat } from '../src/main/retrieval/service'
import { understandQuery } from '../src/main/retrieval/query-understanding'
import { initializeDatabase } from '../src/main/schema'
import { senderCountLabel } from '../src/renderer/src/data-refresh'

const databases: DatabaseSync[] = []

afterEach(() => {
  vi.useRealTimers()
  while (databases.length > 0) databases.pop()!.close()
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  databases.push(db)
  return db
}

describe('Alpha.3 未知发送者语义', () => {
  it('43 条发送者缺失消息保留内部占位身份，但 Daily、Topic 和 AI 证据人数均为零', () => {
    const db = database()
    ingestWorkBuddyMessages(db, {
      source_batch_id: '43条未知发送者',
      batch_metadata: { conversation_name: 'WorkBuddy交流群' },
      messages: Array.from({ length: 43 }, (_, index) => ({
        content: `NovaFlow ${index + 1}.0 发布了本地工具更新。`,
        timestamp: `2026-09-14 ${String(9 + Math.floor(index / 30)).padStart(2, '0')}:${String(index % 30).padStart(2, '0')}`,
        source_position: index
      }))
    })
    const raw = db.prepare(`SELECT COUNT(DISTINCT sender_id) AS count FROM messages`).get() as { count: number }
    const daily = runDailyIntelligence(db, '2026-09-14')
    const radar = runTopicRadar(db, '2026-09-14', daily.candidates)
    const aiInput = buildAIInput(db, '2026-09-14', daily.candidates)

    expect(raw.count).toBe(1)
    expect(daily.candidates.every((candidate) => candidate.sourceSenderIds.length === 0)).toBe(true)
    expect(radar.topics.every((topic) => topic.senderCount === 0)).toBe(true)
    expect(aiInput.candidates.flatMap((candidate) => candidate.evidence).every((item) => item.sender_name === '')).toBe(true)
    expect(senderCountLabel(0)).toBe('发送者未知')
  })

  it('Mock AI 在全部发送者未知时不输出虚假的 1 人', async () => {
    const provider = new MockAIProvider()
    const raw = await provider.generateStructured({
      task: 'chat-question-answer',
      systemPrompt: '',
      input: {
        question: '最近怎么样？',
        evidence: [
          { message_id: '1', conversation_name: '测试群', sender_name: '', timestamp: '2026-09-14T01:00:00Z', content: '第一条证据' },
          { message_id: '2', conversation_name: '测试群', sender_name: '', timestamp: '2026-09-14T02:00:00Z', content: '第二条证据' }
        ]
      }
    })
    const answer = (JSON.parse(raw) as { answer: string }).answer
    expect(answer).toContain('发送者未知')
    expect(answer).not.toContain('1 人')
  })

  it('不同批次的未知发送者不污染搜索人数，也不会被识别成人物过滤条件', async () => {
    const db = database()
    for (const [index, batch] of ['未知批次一', '未知批次二'].entries()) {
      ingestWorkBuddyMessages(db, {
        source_batch_id: batch,
        batch_metadata: { conversation_name: `测试群${index + 1}` },
        messages: [{ content: `Embedding 工具测试消息 ${index + 1}`, timestamp: `2026-09-14 1${index}:00` }]
      })
    }
    const understanding = understandQuery(db, 'Embedding', '2026-09-14')
    const response = await askChat(db, 'Embedding', { anchorDate: '2026-09-14', aiProvider: null, embeddingProvider: null })
    expect(understanding.senderIds).toEqual([])
    expect(response.hitMessageCount).toBe(2)
    expect(response.senderCount).toBe(0)
  })

  it('source_native 与 user_supplied 发送者参与统计，inferred 不参与', () => {
    const db = database()
    ingestWorkBuddyMessages(db, {
      source_batch_id: '可信发送者',
      batch_metadata: { conversation_name: '可信群' },
      messages: [
        { content: 'DataNest 1.4 增量同步发布。', sender_name: '张三', sender_name_source: 'source_native', timestamp: '2026-09-14 09:00', source_position: 0 },
        { content: 'DataNest 1.4 增量同步值得升级。', sender_name: '李四', sender_name_source: 'user_supplied', timestamp: '2026-09-14 09:01', source_position: 1 },
        { content: 'DataNest 1.4 增量同步正在测试。', sender_name: '推测人物', sender_name_source: 'inferred', timestamp: '2026-09-14 09:02', source_position: 2 }
      ]
    })
    const daily = runDailyIntelligence(db, '2026-09-14')
    const radar = runTopicRadar(db, '2026-09-14', daily.candidates)
    expect(new Set(daily.candidates.flatMap((candidate) => candidate.sourceSenderIds)).size).toBe(2)
    expect(radar.topics.find((topic) => /DataNest/i.test(topic.canonicalName))?.senderCount).toBe(2)
    expect(senderCountLabel(2)).toBe(2)
  })

  it('旧 Daily algorithm version 的候选不会复用，正常重算会写入当前版本且不改原始消息', () => {
    const db = database()
    ingestWorkBuddyMessages(db, {
      source_batch_id: '旧Daily缓存',
      messages: [{ content: 'PrivateIndex 发布更新。', timestamp: '2026-09-14 09:00' }]
    })
    const beforeMessageCount = (db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count
    const first = runDailyIntelligence(db, '2026-09-14')
    expect(loadSavedDailyCandidates(db, '2026-09-14')).toEqual(first.candidates)

    db.prepare(`UPDATE daily_intelligence_candidates SET algorithm_version = 'daily-candidate-v1.2-daily-value'`).run()
    expect(loadSavedDailyCandidates(db, '2026-09-14')).toEqual([])

    const recomputed = runDailyIntelligence(db, '2026-09-14')
    expect(loadSavedDailyCandidates(db, '2026-09-14')).toEqual(recomputed.candidates)
    expect(db.prepare(`SELECT DISTINCT algorithm_version AS version FROM daily_intelligence_candidates`).all()).toEqual([{ version: DAILY_ALGORITHM_VERSION }])
    expect((db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }).count).toBe(beforeMessageCount)
  })

  it('不复用可能包含旧发送人数语义的 Topic 缓存', () => {
    const db = database()
    ingestWorkBuddyMessages(db, {
      source_batch_id: '旧Topic缓存',
      messages: [{ content: 'DataNest 1.4 发布更新。', timestamp: '2026-09-14 09:00' }]
    })
    const daily = runDailyIntelligence(db, '2026-09-14')
    runTopicRadar(db, '2026-09-14', daily.candidates)
    db.prepare(`UPDATE topic_daily_metrics SET algorithm_version = 'topic-radar-v1'`).run()
    expect(loadSavedTopicRadar(db, '2026-09-14')).toBeNull()
  })
})

describe('Alpha.3 索引与批次时间迁移', () => {
  it('source_batch_id 查询使用专用索引', () => {
    const db = database()
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM messages WHERE source_batch_id = ?`).all('测试批次') as Array<{ detail: string }>
    expect(plan.some((row) => row.detail.includes('idx_messages_source_batch'))).toBe(true)
    expect(plan.every((row) => !row.detail.startsWith('SCAN messages'))).toBe(true)
  })

  it('旧数据库迁移后消息和批次数据不丢失，并正确回填三个时间字段', () => {
    const db = database()
    ingestWorkBuddyMessages(db, {
      source_batch_id: '旧库迁移',
      batch_metadata: { conversation_name: '旧库群' },
      messages: [{ content: '旧库消息不能丢失。', timestamp: '2026-09-13 09:00' }]
    })
    const before = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }
    db.exec(`
      DROP INDEX IF EXISTS idx_messages_source_batch;
      ALTER TABLE message_import_batches DROP COLUMN first_attempt_at;
      ALTER TABLE message_import_batches DROP COLUMN last_attempt_at;
      ALTER TABLE message_import_batches DROP COLUMN last_success_at;
    `)

    initializeDatabase(db)
    const after = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }
    const batch = db.prepare(`
      SELECT imported_at, first_attempt_at, last_attempt_at, last_success_at
      FROM message_import_batches
    `).get() as Record<string, string>
    expect(after.count).toBe(before.count)
    expect(batch.first_attempt_at).toBe(batch.imported_at)
    expect(batch.last_attempt_at).toBeTruthy()
    expect(batch.last_success_at).toBeTruthy()
  })

  it('第一次失败、随后成功时分别记录首次尝试、最近尝试和最近成功时间', () => {
    vi.useFakeTimers()
    const db = database()
    vi.setSystemTime(new Date('2026-09-14T01:00:00.000Z'))
    const failed = ingestWorkBuddyMessages(db, {
      source_batch_id: '先失败后成功', messages: [{}]
    })
    let batch = db.prepare(`SELECT * FROM message_import_batches`).get() as Record<string, string | null>
    expect(failed.status).toBe('failed')
    expect(batch.imported_at).toBe('2026-09-14T01:00:00.000Z')
    expect(batch.first_attempt_at).toBe('2026-09-14T01:00:00.000Z')
    expect(batch.last_attempt_at).toBe('2026-09-14T01:00:00.000Z')
    expect(batch.last_success_at).toBeNull()

    vi.setSystemTime(new Date('2026-09-14T02:00:00.000Z'))
    const succeeded = ingestWorkBuddyMessages(db, {
      source_batch_id: '先失败后成功', messages: [{ content: '第二次导入成功。' }]
    })
    batch = db.prepare(`SELECT * FROM message_import_batches`).get() as Record<string, string | null>
    expect(succeeded.status).toBe('success')
    expect(batch.imported_at).toBe('2026-09-14T01:00:00.000Z')
    expect(batch.first_attempt_at).toBe('2026-09-14T01:00:00.000Z')
    expect(batch.last_attempt_at).toBe('2026-09-14T02:00:00.000Z')
    expect(batch.last_success_at).toBe('2026-09-14T02:00:00.000Z')
    const message = db.prepare(`SELECT timestamp, imported_at FROM messages`).get() as { timestamp: string | null; imported_at: string }
    expect(message.timestamp).toBeNull()
    expect(message.imported_at).toBe('2026-09-14T02:00:00.000Z')
  })
})
