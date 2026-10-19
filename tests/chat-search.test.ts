// 手工消息与媒体名为从零构造的合成内容；演示消息由 seedDemoData 生成。
// 日期为人工固定的测试锚点；密钥字面量为人工虚构哨兵，仅验证敏感字段不会泄漏。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockAIProvider } from '../src/main/ai/mock-provider'
import { MockEmbeddingProvider } from '../src/main/embedding/mock-provider'
import { OpenAICompatibleEmbeddingProvider } from '../src/main/embedding/openai-compatible-provider'
import { seedDemoData } from '../src/main/demo'
import { openDatabase } from '../src/main/database'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { hybridSearch } from '../src/main/retrieval/hybrid-search'
import { parseDateRange, understandQuery } from '../src/main/retrieval/query-understanding'
import { askChat, getMessageContext } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'

describe('问我的聊天', () => {
  let db: DatabaseSync
  const fixedDate = '2004-02-12'
  let date = fixedDate

  beforeAll(() => {
    // 固定演示数据与相对日期锚点，避免跨月改变“上个月没有消息”的测试前提。
    vi.stubEnv('TZ', 'Asia/Shanghai')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2004-02-23T12:00:00+08:00'))
    db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    seedDemoData(db)
    date = (db.prepare(`SELECT MAX(date(timestamp, 'localtime')) AS date FROM messages`).get() as { date: string }).date
    expect(date).toBe('2004-02-23')
  })

  afterAll(() => {
    try {
      db?.close()
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
    }
  })

  it('FTS5 可以正常搜索产品名和正文', () => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'Claude'`).get() as { count: number }
    expect(row.count).toBeGreaterThan(0)
  })

  it('媒体占位符即使不参与 D1，原文仍保留在全文搜索索引', () => {
    const mediaDb = new DatabaseSync(':memory:')
    initializeDatabase(mediaDb)
    try {
      ingestWorkBuddyMessages(mediaDb, {
        source_batch_id: '媒体搜索保留',
        messages: [{ content: '[图片] synthetic_search_media_003.jpg', source_position: 0 }]
      })
      const rows = mediaDb.prepare(`
        SELECT m.content FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE messages_fts MATCH 'jpg'
      `).all() as Array<{ content: string }>
      expect(rows.map((row) => row.content)).toContain('[图片] synthetic_search_media_003.jpg')
    } finally {
      mediaDb.close()
    }
  })

  it('日期表达可以解析为严格范围', () => {
    expect(parseDateRange('上个月有哪些消息', fixedDate)).toEqual({ label: '上个月', start: '2004-01-01', end: '2004-01-31' })
    expect(parseDateRange('最近7天', fixedDate)).toEqual({ label: '最近7天', start: '2004-02-06', end: '2004-02-12' })
    expect(parseDateRange('2004-02-07 至 2004-02-09', fixedDate)).toEqual({ label: '2004-02-07 至 2004-02-09', start: '2004-02-07', end: '2004-02-09' })
  })

  it('已知群名成为结构化过滤条件', async () => {
    const understanding = understandQuery(db, 'AI 产品观察站里谁讨论过 Claude Code？', date)
    const result = await hybridSearch(db, 'AI 产品观察站里谁讨论过 Claude Code？', understanding, null)
    expect(understanding.conversationNames).toContain('AI 产品观察站')
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results.every((item) => item.conversationName === 'AI 产品观察站')).toBe(true)
  })

  it('已知人物成为结构化过滤条件', async () => {
    const understanding = understandQuery(db, '林舟提到过哪些 Claude Code 信息？', date)
    const result = await hybridSearch(db, '林舟提到过哪些 Claude Code 信息？', understanding, null)
    expect(understanding.senderNames).toContain('林舟')
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results.every((item) => item.senderName === '林舟')).toBe(true)
  })

  it('Mock Embedding 可以召回不同表达的语义消息', async () => {
    const response = await askChat(db, '公众号文章美化工具', { anchorDate: date, aiProvider: null, embeddingProvider: new MockEmbeddingProvider() })
    expect(response.telemetry.retrievalMode).toBe('全文 + 语义')
    expect(response.results.some((item) => item.messageId.includes('semantic-layout'))).toBe(true)
    expect(response.results.some((item) => item.matchReasons.includes('语义相似'))).toBe(true)
  })

  it('没有 Embedding 时退化为 FTS 和结构化检索', async () => {
    const response = await askChat(db, '谁推荐过公众号排版工具？', { anchorDate: date, aiProvider: null, embeddingProvider: null })
    expect(response.insufficientEvidence).toBe(false)
    expect(response.telemetry.retrievalMode).toBe('全文搜索')
    expect(response.results.some((item) => item.content.includes('公众号排版工具'))).toBe(true)
  })

  it('混合检索排序稳定', async () => {
    const provider = new MockEmbeddingProvider()
    const understanding = understandQuery(db, '公众号文章美化工具', date)
    const first = await hybridSearch(db, '公众号文章美化工具', understanding, provider)
    const second = await hybridSearch(db, '公众号文章美化工具', understanding, provider)
    expect(second.results.map((item) => [item.messageId, item.relevanceScore])).toEqual(first.results.map((item) => [item.messageId, item.relevanceScore]))
  })

  it('不存在的内容明确拒绝编造', async () => {
    const response = await askChat(db, '上个月谁推荐过一个不存在的工具？', { anchorDate: date, aiProvider: new MockAIProvider(), embeddingProvider: new MockEmbeddingProvider() })
    expect(response.understanding.dateRange).toEqual({ label: '上个月', start: '2004-01-01', end: '2004-01-31' })
    expect(response.insufficientEvidence).toBe(true)
    expect(response.results).toEqual([])
    expect(response.answer).toBe('没有找到足够相关的聊天记录。')
    expect(response.sourceMessageIds).toEqual([])
  })

  it('AI Provider 失败时退回规则模式', async () => {
    const provider = new MockAIProvider(() => { throw new Error('服务不可用') })
    const response = await askChat(db, '最近 Claude Code 怎么样？', { anchorDate: date, aiProvider: provider, embeddingProvider: null })
    expect(response.insufficientEvidence).toBe(false)
    expect(response.telemetry.aiMode).toBe('规则模式')
    expect(response.answer).toContain('AI增强暂时不可用')
  })

  it('source_message_ids 不接受模型篡改', async () => {
    const provider = new MockAIProvider(() => JSON.stringify({ answer: '仅根据检索证据整理。', source_message_ids: ['伪造来源'] }))
    const response = await askChat(db, '最近 Claude Code 怎么样？', { anchorDate: date, aiProvider: provider, embeddingProvider: null })
    expect(response.telemetry.aiMode).toBe('AI增强模式')
    expect(response.sourceMessageIds).not.toContain('伪造来源')
    expect(response.sourceMessageIds.every((id) => response.results.some((item) => item.messageId === id))).toBe(true)
  })

  it('查询结果可以查看原文前后文', async () => {
    const response = await askChat(db, '之前谁分享过微信小程序 GitHub 项目？', { anchorDate: date, aiProvider: null, embeddingProvider: null })
    const context = getMessageContext(db, response.results[0].messageId)
    expect(context?.messages.some((item) => item.isSource && item.messageId === response.results[0].messageId)).toBe(true)
    expect(context!.messages.length).toBeGreaterThan(1)
  })

  it('时间范围对最终结果严格生效', async () => {
    const response = await askChat(db, '今天谁提到 Claude Code？', { anchorDate: date, aiProvider: null, embeddingProvider: null })
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.results.every((item) => item.timestamp.startsWith(date))).toBe(true)
  })

  it('用户原始问题不进入长期数据库记录', async () => {
    const secretQuestion = '不要保存这句秘密问题，最近 Claude Code 怎么样？'
    const echoProvider = new MockAIProvider(() => JSON.stringify({ answer: secretQuestion, source_message_ids: [] }))
    await askChat(db, secretQuestion, { anchorDate: date, aiProvider: echoProvider, embeddingProvider: null })
    const stored = db.prepare('SELECT query_hash, result_json, source_message_ids_json FROM query_answer_runs').all()
    expect(JSON.stringify(stored)).not.toContain(secretQuestion)
  })

  it('最早提及查询按时间升序返回', async () => {
    const demoDate = (db.prepare(`SELECT MAX(date(timestamp, 'localtime')) AS date FROM messages`).get() as { date: string }).date
    const response = await askChat(db, 'DataNest 1.4 是谁最早提到的？', { anchorDate: demoDate, aiProvider: null, embeddingProvider: null })
    expect(response.understanding.sort).toBe('oldest')
    expect(response.results[0].timestamp).toBe([...response.results].sort((left, right) => left.timestamp.localeCompare(right.timestamp))[0].timestamp)
  })

  it('Embedding API Key 不进入日志', async () => {
    const secret = '不得记录的-embedding-key'
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200 })) as unknown as typeof fetch
    const provider = new OpenAICompatibleEmbeddingProvider({ baseUrl: 'https://embedding.example.test/v1', apiKey: secret, model: 'test', dimensions: 3, fetchImpl })
    await provider.embed(['安全文本'])
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain(secret)
    vi.restoreAllMocks()
  })

  it('同一查询重复执行结果一致', async () => {
    const options = { anchorDate: date, aiProvider: null, embeddingProvider: null }
    const first = await askChat(db, '谁推荐过公众号排版工具？', options)
    const second = await askChat(db, '谁推荐过公众号排版工具？', options)
    expect(second.results).toEqual(first.results)
    expect(second.sourceMessageIds).toEqual(first.sourceMessageIds)
  })

  it('应用运行中 WorkBuddy 外部导入后立即搜索新消息原文，Top1 命中', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'privateradar-live-search-'))
    const path = join(directory, 'private-radar.db')
    const liveDb = openDatabase(path)
    const connectorDb = openDatabase(path)
    try {
      const question = '虚构纸鲸停在圆点的旁边。'
      const before = await askChat(liveDb, question, { anchorDate: '2004-02-03', aiProvider: null, embeddingProvider: null })
      expect(before.insufficientEvidence).toBe(true)

      ingestWorkBuddyMessages(connectorDb, {
        source_batch_id: '即时搜索回归',
        batch_metadata: { conversation_name: 'PrivateRadar测试群' },
        messages: [
          { content: '合成拼片留在空白格。', source_position: 0 },
          { content: question, source_position: 1 }
        ]
      })

      const after = await askChat(liveDb, question, { anchorDate: '2004-02-03', aiProvider: null, embeddingProvider: null })
      expect(after.insufficientEvidence).toBe(false)
      expect(after.results[0].content).toBe(question)
      expect(after.results[0].timestamp).toBe('')
      expect(after.results[0].matchReasons).toContain('关键词匹配')
    } finally {
      connectorDb.close()
      liveDb.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
