// 手工消息为从零构造的合成场景，日期为人工测试锚点；不代表真实聊天或事件。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatQueryResponse, DailyBriefItem, QueryUnderstanding } from '../src/shared/models'
import {
  exportFeedback,
  getDailyFeedbackStates,
  getSearchFeedbackState,
  saveDailyFeedback,
  saveMissingImportantFeedback,
  saveSearchFeedback
} from '../src/main/feedback/repository'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  databases.push(db)
  ingestWorkBuddyMessages(db, {
    source_batch_id: '反馈测试批次',
    batch_metadata: { conversation_name: '反馈测试群' },
    messages: [
      { content: '虚构折页工具现已支持星纹索引功能。', timestamp: '2004-02-03T09:00:00.000Z', sender_name: '合成成员甲', source_position: 0 },
      { content: '合成隔离哨兵：银色棋子留在未关联的沙盘格。', timestamp: '2004-02-03T09:01:00.000Z', sender_name: '合成成员乙', source_position: 1 }
    ]
  })
  return db
}

function item(db: DatabaseSync): DailyBriefItem {
  const sourceId = (db.prepare(`SELECT id FROM messages WHERE content LIKE '虚构折页工具%'`).get() as { id: string }).id
  return {
    candidateId: 'daily-feedback-candidate',
    date: '2004-02-03',
    title: '折页工具 功能更新',
    representativeText: '虚构折页工具现已支持星纹索引功能。',
    importanceScore: 6.2,
    sourceMessageIds: [sourceId],
    sourceConversationIds: ['conversation:反馈测试群'],
    sourceSenderIds: ['合成成员甲'],
    messageCount: 1,
    conversationCount: 1,
    firstSeenAt: '2004-02-03T09:00:00.000Z',
    lastSeenAt: '2004-02-03T09:00:00.000Z',
    reasonCodes: ['PRODUCT_OR_VERSION', 'EVENT_OR_RELEASE'],
    summary: '虚构折页工具现已支持星纹索引功能。',
    whyItMatters: '产品出现明确功能更新。',
    category: '产品 / 技术',
    importanceLevel: 'medium',
    dailyValue: 'must_show',
    dailyPriority: 'medium',
    valueReasonCodes: ['VERIFIABLE_UPDATE']
  }
}

function understanding(): QueryUnderstanding {
  return {
    intent: 'find', sort: 'relevance', dateRange: { label: '不限时间', start: null, end: null }, timeIntent: 'none', personIntent: 'none', isNaturalLanguage: true,
    conversationIds: [], conversationNames: [], senderIds: [], senderNames: [], entityKeys: ['折页工具'], coreTopics: ['折页工具'], eventTerms: ['更新'], expandedTerms: ['更新', '新功能'], searchTerms: ['折页工具']
  }
}

function response(sourceId: string): ChatQueryResponse {
  return {
    queryType: 'find', answer: '找到 1 条与“折页工具”相关的聊天。', insufficientEvidence: false, understanding: understanding(),
    results: [], unverifiedTimeResults: [], sourceMessageIds: [sourceId], hitMessageCount: 1, conversationCount: 1, senderCount: 1,
    telemetry: { retrievalMode: '全文搜索', aiMode: '规则模式', evidenceSentCount: 0, embeddingCandidateCount: 0 }
  }
}

describe('本地用户反馈', () => {
  it('可保存 Daily 有用和不该出现反馈，并保存原因与判断快照', () => {
    const db = database()
    const dailyItem = item(db)
    const useful = saveDailyFeedback(db, { item: dailyItem, vote: 'USEFUL', appVersion: '0.2.0-alpha.8' })
    const negative = saveDailyFeedback(db, { item: dailyItem, vote: 'SHOULD_NOT_SHOW', reasonCode: '普通闲聊', note: '不够重要', appVersion: '0.2.0-alpha.8' })
    expect(useful.vote).toBe('USEFUL')
    expect(negative.vote).toBe('SHOULD_NOT_SHOW')
    expect(negative.reasonCode).toBe('普通闲聊')
    const row = db.prepare(`SELECT context_json FROM user_feedback WHERE id = ?`).get(negative.feedbackId) as { context_json: string }
    expect(JSON.parse(row.context_json)).toMatchObject({ daily_value: 'must_show', daily_priority: 'medium', d1_importance_score: 6.2 })
  })

  it('同一 Daily 条目改选反馈只保留一个有效状态，刷新后仍可读取', () => {
    const db = database()
    const dailyItem = item(db)
    saveDailyFeedback(db, { item: dailyItem, vote: 'USEFUL', appVersion: '0.2.0-alpha.8' })
    saveDailyFeedback(db, { item: dailyItem, vote: 'SHOULD_NOT_SHOW', reasonCode: '判断错了', appVersion: '0.2.0-alpha.8' })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM user_feedback WHERE feedback_type = 'daily_item'`).get()).toEqual({ count: 1 })
    expect(getDailyFeedbackStates(db, [dailyItem.candidateId])[dailyItem.candidateId]).toMatchObject({ vote: 'SHOULD_NOT_SHOW', reasonCode: '判断错了' })
  })

  it('可保存遗漏重要内容，不要求消息 ID 或备注', () => {
    const db = database()
    const state = saveMissingImportantFeedback(db, { dateKey: '2004-02-03', note: '', appVersion: '0.2.0-alpha.8' })
    expect(state.vote).toBe('MISSING_IMPORTANT')
    expect(db.prepare(`SELECT source_message_ids_json FROM user_feedback WHERE id = ?`).get(state.feedbackId)).toEqual({ source_message_ids_json: '[]' })
  })

  it('可保存 Search 找对与没找对反馈，包含查询和证据 ID', () => {
    const db = database()
    const sourceId = item(db).sourceMessageIds[0]
    saveSearchFeedback(db, { question: '折页工具 更新了吗？', response: response(sourceId), vote: 'CORRECT', appVersion: '0.2.0-alpha.8' })
    const incorrect = saveSearchFeedback(db, { question: '折页工具 更新了吗？', response: response(sourceId), vote: 'INCORRECT', reasonCode: '回答不完整', appVersion: '0.2.0-alpha.8' })
    expect(incorrect).toMatchObject({ vote: 'INCORRECT', reasonCode: '回答不完整' })
    expect(getSearchFeedbackState(db, '折页工具 更新了吗？', [sourceId])).toMatchObject({ vote: 'INCORRECT' })
    const row = db.prepare(`SELECT query_text, source_message_ids_json, context_json FROM user_feedback WHERE id = ?`).get(incorrect.feedbackId) as { query_text: string; source_message_ids_json: string; context_json: string }
    expect(row.query_text).toBe('折页工具 更新了吗?')
    expect(JSON.parse(row.source_message_ids_json)).toEqual([sourceId])
    expect(JSON.parse(row.context_json).top_evidence_ids).toEqual([sourceId])
  })

  it('反馈不会修改原始消息、Daily 候选或 Search 排序', async () => {
    const db = database()
    const dailyBefore = runDailyIntelligence(db, '2004-02-03').candidates.map((candidate) => candidate.candidateId)
    const searchBefore = await askChat(db, '折页工具', { anchorDate: '2004-02-03', aiProvider: null, embeddingProvider: null })
    const dailyItem = item(db)
    saveDailyFeedback(db, { item: dailyItem, vote: 'SHOULD_NOT_SHOW', reasonCode: '不重要', appVersion: '0.2.0-alpha.8' })
    saveSearchFeedback(db, { question: '折页工具', response: response(dailyItem.sourceMessageIds[0]), vote: 'INCORRECT', reasonCode: '找到了错误内容', appVersion: '0.2.0-alpha.8' })
    expect(runDailyIntelligence(db, '2004-02-03').candidates.map((candidate) => candidate.candidateId)).toEqual(dailyBefore)
    expect((await askChat(db, '折页工具', { anchorDate: '2004-02-03', aiProvider: null, embeddingProvider: null })).sourceMessageIds).toEqual(searchBefore.sourceMessageIds)
    expect(db.prepare(`SELECT content FROM messages WHERE id = ?`).get(dailyItem.sourceMessageIds[0])).toEqual({ content: '虚构折页工具现已支持星纹索引功能。' })
  })

  it('初始化旧数据库后保留原消息并安全创建反馈表', () => {
    const db = database()
    const count = db.prepare(`SELECT COUNT(*) AS count FROM messages`).get()
    initializeDatabase(db)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM messages`).get()).toEqual(count)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_feedback'`).get()).toEqual({ name: 'user_feedback' })
  })

  it('导出仅含反馈及关联最小消息片段，不导出整库且空库可导出', () => {
    const db = database()
    const directory = mkdtempSync(join(tmpdir(), 'private-radar-feedback-'))
    directories.push(directory)
    const emptyPath = join(directory, 'empty.json')
    expect(exportFeedback(db, emptyPath)).toBe(0)
    expect(JSON.parse(readFileSync(emptyPath, 'utf8')).feedback).toEqual([])

    const dailyItem = item(db)
    saveDailyFeedback(db, { item: dailyItem, vote: 'USEFUL', appVersion: '0.2.0-alpha.8' })
    const exportPath = join(directory, 'feedback.json')
    expect(exportFeedback(db, exportPath)).toBe(1)
    const payload = readFileSync(exportPath, 'utf8')
    expect(payload).toContain('虚构折页工具现已支持星纹索引功能。')
    expect(payload).not.toContain('银色棋子留在未关联的沙盘格')
  })

  it('关键词检索没有回答文案时，Search 反馈入口仍随已完成的 response 显示', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
    expect(source).toContain('<SearchFeedbackControls question={question} response={response} />')
    expect(source).not.toContain('{response.answer && <SearchFeedbackControls')
    expect(source).toContain('这个结果找对了吗？')
    const styles = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'), 'utf8')
    expect(styles).toContain('.search-feedback .feedback-button.secondary')
  })
})
