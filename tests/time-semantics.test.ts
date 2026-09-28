import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDashboardSummary, getTopicRadarSummary } from '../src/main/database'
import { getFirstUseStatus } from '../src/main/first-use'
import { loadDailyCandidateCache, loadMessagesForDate, runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'
import { normalizeMessage } from '../src/main/import/normalize'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { loadSavedTopicRadar, runTopicRadar } from '../src/main/intelligence/topics/repository'
import { buildDailyBrief } from '../src/main/intelligence/daily/brief'
import { MockAIProvider } from '../src/main/ai/mock-provider'

const databases: DatabaseSync[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  while (databases.length > 0) databases.pop()!.close()
})

const releaseText = 'DataNest 1.4 发布增量同步功能，升级前请备份数据，官方说明 https://github.com/example/datanest/releases/1.4'

function cachedDatabase(): DatabaseSync {
  const db = database()
  addMessage(db, 'cached-source', knownTime, importOn27, releaseText)
  expect(runDailyIntelligence(db, '2026-09-20').candidates.length).toBeGreaterThan(0)
  return db
}

describe('可靠来源与派生缓存最小修正', () => {
  it.each(['unknown', 'inferred'])('Search 日期过滤排除 %s，普通检索仍可找到且不标记已确认', async (source) => {
    const db = database()
    addMessage(db, 'unreliable-search', knownTime, importOn27, 'Claude 更新了聊天整理功能。')
    db.prepare('UPDATE messages SET timestamp_source = ?').run(source)
    const options = { aiProvider: null, embeddingProvider: null }
    expect((await askChat(db, '2026-09-20 Claude', options)).results).toEqual([])
    const normal = await askChat(db, 'Claude', options)
    expect(normal.results).toContainEqual(expect.objectContaining({ messageId: 'unreliable-search', timeVerification: 'unknown', timestamp: '' }))
    const recent = await askChat(db, '最近7天 Claude', options)
    expect(recent.results).toEqual([])
    expect(recent.unverifiedTimeResults).toContainEqual(expect.objectContaining({ messageId: 'unreliable-search', timeVerification: 'unknown' }))
  })

  it.each(['source_native', 'user_supplied'])('Search 日期过滤保留 %s 并标记已确认', async (source) => {
    const db = database()
    addMessage(db, 'reliable-search', knownTime, importOn27, 'Claude 更新了聊天整理功能。')
    db.prepare('UPDATE messages SET timestamp_source = ?').run(source)
    const response = await askChat(db, '2026-09-20 Claude', { aiProvider: null, embeddingProvider: null })
    expect(response.results).toContainEqual(expect.objectContaining({ messageId: 'reliable-search', timeVerification: 'verified' }))
  })

  it.each(['unknown', 'inferred'])('Daily 历史输入不受 %s 时间消息影响', (source) => {
    const db = database()
    addMessage(db, 'today', knownTime, importOn27, releaseText)
    addMessage(db, 'history', '2026-09-19T04:00:00.000Z', importOn27, releaseText)
    db.prepare("UPDATE messages SET timestamp_source = ? WHERE id = 'history'").run(source)
    const unreliable = runDailyIntelligence(db, '2026-09-20').candidates
    db.prepare("UPDATE messages SET timestamp_source = 'source_native' WHERE id = 'history'").run()
    const reliable = runDailyIntelligence(db, '2026-09-20').candidates
    expect(unreliable[0].reasonCodes).not.toEqual(reliable[0].reasonCodes)
    const baseline = database()
    addMessage(baseline, 'today', knownTime, importOn27, releaseText)
    expect(unreliable).toEqual(runDailyIntelligence(baseline, '2026-09-20').candidates)
  })

  it('Topic 新计算和缓存读取的历史日期数都排除不可靠来源', () => {
    const db = database()
    addMessage(db, 'today', knownTime, importOn27, releaseText)
    addMessage(db, 'unknown-history', '2026-09-18T04:00:00.000Z', importOn27, releaseText)
    addMessage(db, 'inferred-history', '2026-09-19T04:00:00.000Z', importOn27, releaseText)
    db.prepare("UPDATE messages SET timestamp_source = 'unknown' WHERE id = 'unknown-history'").run()
    db.prepare("UPDATE messages SET timestamp_source = 'inferred' WHERE id = 'inferred-history'").run()
    const result = runTopicRadar(db, '2026-09-20')
    expect(result.topics.length).toBeGreaterThan(0)
    expect(result.historyDays).toBe(0)
    expect(loadSavedTopicRadar(db, '2026-09-20')?.historyDays).toBe(0)
  })

  it('推断时间不显示已确认，但原始保存值保持不变', () => {
    const db = database()
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: '推断时间报告', messages: [{ timestamp: knownTime, timestamp_source: 'inferred', content: releaseText }]
    })
    expect(result.timestampStatus).toBe('missing')
    expect(getFirstUseStatus(db, '内存测试库').latestImport?.timestampStatus).toBe('missing')
    expect(db.prepare('SELECT timestamp, timestamp_source FROM messages').get()).toMatchObject({ timestamp: knownTime, timestamp_source: 'inferred' })
  })

  it.each(['unknown', 'inferred', '错误日期', '无效时间', '消息缺失'])('来源为 %s 时整个候选缓存失效', (failure) => {
    const db = cachedDatabase()
    if (failure === '消息缺失') db.prepare("DELETE FROM messages WHERE id = 'cached-source'").run()
    else if (failure === '错误日期') db.prepare("UPDATE messages SET timestamp = '2026-09-19T04:00:00.000Z'").run()
    else if (failure === '无效时间') db.prepare("UPDATE messages SET timestamp = '无法解析'").run()
    else db.prepare('UPDATE messages SET timestamp_source = ?').run(failure)
    expect(loadDailyCandidateCache(db, '2026-09-20')).toBeNull()
  })

  it('有效缓存直接命中，不更新候选持久化时间', async () => {
    const db = cachedDatabase()
    db.prepare("UPDATE daily_intelligence_candidates SET created_at = '缓存标记'").run()
    expect(loadDailyCandidateCache(db, '2026-09-20')?.length).toBeGreaterThan(0)
    await getDashboardSummary(db, ':memory:', false, false, '2026-09-20')
    expect(db.prepare('SELECT DISTINCT created_at FROM daily_intelligence_candidates').all()).toEqual([{ created_at: '缓存标记' }])
  })

  it('旧缓存失效后整体重建，第二次打开命中新集合', async () => {
    const db = cachedDatabase()
    db.prepare("UPDATE messages SET timestamp_source = 'unknown' WHERE id = 'cached-source'").run()
    addMessage(db, 'new-source', knownTime, importOn27, '物业通知：明天上午9点停水，请提前储水，恢复时间另行通知。')
    const summary = await getDashboardSummary(db, ':memory:', false, false, '2026-09-20')
    expect(summary.messageCount).toBe(1)
    const saved = loadDailyCandidateCache(db, '2026-09-20')!
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.flatMap((item) => item.sourceMessageIds)).toEqual(['new-source'])
    db.prepare("UPDATE daily_intelligence_candidates SET created_at = '重建后缓存'").run()
    await getDashboardSummary(db, ':memory:', false, false, '2026-09-20')
    expect(db.prepare('SELECT DISTINCT created_at FROM daily_intelligence_candidates').all()).toEqual([{ created_at: '重建后缓存' }])
  })

  it('重建结果为空也可命中缓存，新增可靠输入后才失效', async () => {
    const db = cachedDatabase()
    db.prepare("UPDATE messages SET timestamp_source = 'unknown'").run()
    await getDashboardSummary(db, ':memory:', false, false, '2026-09-20')
    expect(loadDailyCandidateCache(db, '2026-09-20')).toEqual([])
    db.prepare("UPDATE app_settings SET updated_at = '空缓存标记' WHERE key LIKE 'daily-empty-cache:%'").run()
    await getDashboardSummary(db, ':memory:', false, false, '2026-09-20')
    expect(db.prepare("SELECT updated_at FROM app_settings WHERE key LIKE 'daily-empty-cache:%'").get()).toMatchObject({ updated_at: '空缓存标记' })
    addMessage(db, 'new-reliable', knownTime, importOn27, releaseText)
    expect(loadDailyCandidateCache(db, '2026-09-20')).toBeNull()
  })

  it('候选时间失效也失效该日期 AI 派生结果，重建后重新生成并可再次命中', async () => {
    const db = cachedDatabase()
    const provider = new MockAIProvider()
    await buildDailyBrief(db, '2026-09-20', loadDailyCandidateCache(db, '2026-09-20')!, provider)
    expect(provider.callCount).toBe(1)
    const old = db.prepare('SELECT * FROM daily_ai_briefs').get()!
    const columns = Object.keys(old)
    db.prepare(`INSERT INTO daily_ai_briefs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map((key) => key === 'id' ? '其他日期结果' : key === 'brief_date' ? '2026-09-18' : old[key]))
    db.prepare("UPDATE messages SET timestamp_source = 'unknown'").run()
    expect(loadDailyCandidateCache(db, '2026-09-20')).toBeNull()
    expect(db.prepare("SELECT COUNT(*) AS count FROM daily_ai_briefs WHERE brief_date = '2026-09-20'").get()).toMatchObject({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM daily_ai_briefs WHERE brief_date = '2026-09-18'").get()).toMatchObject({ count: 1 })
    db.prepare("UPDATE messages SET timestamp_source = 'source_native'").run()
    const candidates = runDailyIntelligence(db, '2026-09-20').candidates
    await buildDailyBrief(db, '2026-09-20', candidates, provider)
    expect(provider.callCount).toBe(2)
    const cached = await buildDailyBrief(db, '2026-09-20', loadDailyCandidateCache(db, '2026-09-20')!, provider)
    expect(cached.telemetry?.cacheHit).toBe(true)
    expect(provider.callCount).toBe(2)
  })
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  db.prepare(`
    INSERT INTO conversations (id, platform, name, conversation_type, created_at)
    VALUES ('test-group', 'wechat', '测试群', 'group', '2026-09-20T00:00:00.000Z')
  `).run()
  databases.push(db)
  return db
}

function addMessage(
  db: DatabaseSync,
  id: string,
  timestamp: string | null,
  importedAt: string,
  content: string
): void {
  db.prepare(`
    INSERT INTO messages (
      id, platform, conversation_id, conversation_name, sender_id, sender_name,
      timestamp, timestamp_source, content, message_type, source, fingerprint, imported_at
    ) VALUES (?, 'wechat', 'test-group', '测试群', 'sender', '发送人',
      ?, ?, ?, 'text', 'workbuddy', ?, ?)
  `).run(id, timestamp, timestamp ? 'source_native' : 'unknown', content, id, importedAt)
}

const knownTime = '2026-09-20T04:00:00.000Z'
const importOn20 = '2026-09-20T06:00:00.000Z'
const importOn27 = '2026-09-27T06:00:00.000Z'

describe('alpha.14 聊天日期与导入日期分离', () => {
  it('模型允许非空但来源未知的时间，日期入口仍须排除', async () => {
    const message = normalizeMessage({
      timestamp: knownTime, timestamp_source: 'unknown', content: '物业通知：请清理楼道杂物。'
    }, '时间来源测试', { allowMissingMetadata: true }).message
    expect(message.timestamp).toBe(knownTime)
    expect(message.timestampSource).toBe('unknown')
    const db = database()
    addMessage(db, 'unreliable', message.timestamp, importOn27, message.content)
    db.prepare("UPDATE messages SET timestamp_source = 'unknown' WHERE id = 'unreliable'").run()
    expect((await getDashboardSummary(db, ':memory:')).date).toBeNull()
    expect(loadMessagesForDate(db, '2026-09-20')).toEqual([])
    expect(getFirstUseStatus(db, '临时测试库').dataStatus.latestMessageDate).toBeNull()
    expect(getTopicRadarSummary(db).date).toBeNull()
  })

  it.each(['今天 Claude', '最近7天 Claude'])('全未知时间时 %s 只用本地日历解释日期，不给消息赋日期', async (question) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 1, 12))
    const db = database()
    addMessage(db, 'unknown-calendar', null, importOn27, 'Claude 更新了聊天整理功能。')
    const response = await askChat(db, question, { aiProvider: null, embeddingProvider: null })
    expect(response.understanding.dateRange.end).toBe('2026-10-01')
    expect(response.results).toEqual([])
    if (question.startsWith('今天')) {
      expect(response.understanding.dateRange.start).toBe('2026-10-01')
      expect(response.unverifiedTimeResults).toEqual([])
    } else {
      expect(response.unverifiedTimeResults).toContainEqual(expect.objectContaining({
        messageId: 'unknown-calendar', timestamp: '', timeVerification: 'unknown'
      }))
    }
    expect(db.prepare("SELECT timestamp, timestamp_source FROM messages WHERE id = 'unknown-calendar'").get())
      .toMatchObject({ timestamp: null, timestamp_source: 'unknown' })
  })

  it('Home 当日消息与群数只计入原始时间匹配的消息', async () => {
    const db = database()
    addMessage(db, 'known', knownTime, importOn20, '物业通知：请保持消防通道畅通。')
    addMessage(db, 'unknown', null, importOn20, '物业通知：请清理楼道杂物。')
    const summary = await getDashboardSummary(db, ':memory:', false, false, '2026-09-20')
    expect(summary).toMatchObject({ date: '2026-09-20', messageCount: 1, conversationCount: 1, totalMessageCount: 2 })
  })

  it('Home 最新日期不被较新的导入时间推进', async () => {
    const db = database()
    addMessage(db, 'known', knownTime, importOn20, '可靠聊天时间')
    addMessage(db, 'unknown', null, importOn27, '原始时间未知')
    expect((await getDashboardSummary(db, ':memory:')).date).toBe('2026-09-20')
  })

  it('全是未知时间时 Home 不返回导入日期', async () => {
    const db = database()
    addMessage(db, 'unknown', null, importOn27, '原始时间未知')
    const summary = await getDashboardSummary(db, ':memory:')
    expect(summary).toMatchObject({ date: null, messageCount: 0, totalMessageCount: 1, items: [] })
  })

  it('Settings 数据最新至只采用可靠聊天日期', () => {
    const db = database()
    addMessage(db, 'known', knownTime, importOn20, '可靠聊天时间')
    addMessage(db, 'unknown', null, importOn27, '原始时间未知')
    expect(getFirstUseStatus(db, '临时测试库').dataStatus.latestMessageDate).toBe('2026-09-20')
    const unknownOnly = database()
    addMessage(unknownOnly, 'unknown-only', null, importOn27, '仅有导入时间')
    expect(getFirstUseStatus(unknownOnly, '临时测试库').dataStatus.latestMessageDate).toBeNull()
  })

  it('Daily 不把导入日的未知时间消息纳入当日候选输入', () => {
    const db = database()
    addMessage(db, 'unknown', null, importOn20, '物业通知：请保持消防通道畅通。')
    expect(loadMessagesForDate(db, '2026-09-20')).toEqual([])
    expect(runDailyIntelligence(db, '2026-09-20').totalMessages).toBe(0)
  })

  it('Daily 仍纳入原始时间匹配的消息', () => {
    const db = database()
    addMessage(db, 'known', knownTime, importOn27, '物业通知：请保持消防通道畅通。')
    expect(loadMessagesForDate(db, '2026-09-20').map((item) => item.id)).toEqual(['known'])
    expect(runDailyIntelligence(db, '2026-09-20').totalMessages).toBe(1)
  })

  it('Topic 默认日期不被未知时间消息的导入日期推进', () => {
    const db = database()
    addMessage(db, 'known', knownTime, importOn20, '可靠聊天时间')
    addMessage(db, 'unknown', null, importOn27, '原始时间未知')
    expect(getTopicRadarSummary(db).date).toBe('2026-09-20')
    const unknownOnly = database()
    addMessage(unknownOnly, 'unknown-only', null, importOn27, '仅有导入时间')
    expect(getTopicRadarSummary(unknownOnly)).toMatchObject({ date: null, topics: [] })
  })

  it('Search 相对日期以最新可靠聊天日期为基准', async () => {
    const db = database()
    addMessage(db, 'known', knownTime, importOn20, '物业通知：请保持消防通道畅通。')
    addMessage(db, 'unknown', null, importOn27, '原始时间未知')
    const response = await askChat(db, '今天物业通知', { aiProvider: null, embeddingProvider: null })
    expect(response.understanding.dateRange).toMatchObject({ start: '2026-09-20', end: '2026-09-20' })
  })

  it('Search 明确日期过滤继续排除未知时间消息', async () => {
    const db = database()
    addMessage(db, 'known', knownTime, importOn20, 'Claude 更新了物业通知的整理功能。')
    addMessage(db, 'unknown', null, importOn20, 'Claude 更新了楼道杂物提醒功能。')
    const response = await askChat(db, '2026-09-20 Claude', { aiProvider: null, embeddingProvider: null })
    expect(response.results.map((item) => item.messageId)).toContain('known')
    expect(response.results.map((item) => item.messageId)).not.toContain('unknown')
    expect(response.unverifiedTimeResults).toEqual([])
  })

  it('Search 普通检索保留未知时间消息及未知标记', async () => {
    const db = database()
    addMessage(db, 'unknown', null, importOn27, '物业通知：楼道杂物及时清理。')
    const response = await askChat(db, '物业通知', { aiProvider: null, embeddingProvider: null })
    expect(response.results).toContainEqual(expect.objectContaining({
      messageId: 'unknown', timestamp: '', timeVerification: 'unknown'
    }))
  })
})
