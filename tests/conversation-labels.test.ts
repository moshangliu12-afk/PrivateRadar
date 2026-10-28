import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { openDatabase } from '../src/main/database'
import { seedDemoData } from '../src/main/demo'
import { listConversations, setConversationLabel, registerConversationLabelIpc } from '../src/main/conversation-labels'
import { resolveDisplayConversationName } from '../src/shared/conversation-labels'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { askChat, getMessageContext } from '../src/main/retrieval/service'
import { understandQuery } from '../src/main/retrieval/query-understanding'
import { getCandidateEvidence, runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import { getTopicEvidence, runTopicRadar } from '../src/main/intelligence/topics/repository'
import { getTodayKeywordInterest } from '../src/main/intelligence/daily/keyword-interest'
import { listRecentKeywordHits, getKeywordHitContext } from '../src/main/keyword-radar/desktop'
import { listCommitmentCandidates, getCommitmentCandidateContext, confirmCommitmentCandidate } from '../src/main/commitment/desktop'
import { sharedCoreFixture } from './shared-core-fixture'
import { cleanupRadarFixtures } from './keyword-radar-fixture'
import { reviewFixture } from './commitment-review-fixture'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) if (db.isOpen) db.close(); cleanupRadarFixtures() })
function database() { const db = new DatabaseSync(':memory:'); initializeDatabase(db); databases.push(db); return db }
function ingest(db: DatabaseSync, name?: string) {
  return ingestWorkBuddyMessages(db, { source_batch_id: '标签回归固定来源', messages: [{ platform: 'wechat',
    source_message_id: '标签回归消息', source_position: 0, content: 'Codex 发布新版本，今晚我会处理接口。',
    sender_name: '来源发言人', timestamp: '2026-10-08T09:00:00+08:00',
    ...(name === undefined ? {} : { conversation_name: name, conversation_name_source: 'source_native' as const }) }] })
}
function relations(db: DatabaseSync) {
  return Object.fromEntries(['messages', 'batch_item_message_sources', 'daily_candidate_sources', 'topic_daily_sources', 'messages_fts_data']
    .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
}

describe('Conversation Label 三层语义', () => {
  it.each([
    ['工作群', null, '工作群'], ['工作群', 'PrivateRadar 项目', 'PrivateRadar 项目'],
    [null, '项目组', '项目组'], [null, null, '未知会话'], ['', '   ', '未知会话']
  ])('来源 %s，用户 %s，显示 %s', (source, user, display) => {
    expect(resolveDisplayConversationName({ sourceConversationName: source, userConversationLabel: user })).toBe(display)
  })
  it('明确 null 来源不回退到旧展示值，不将展示占位写成来源事实', () => {
    expect(resolveDisplayConversationName({ sourceConversationName: null, conversationName: '旧缓存', userConversationLabel: null })).toBe('未知会话')
    const db = database(); ingest(db)
    expect(listConversations(db)[0]).toMatchObject({ sourceConversationName: null, userConversationLabel: null, displayConversationName: '未知会话' })
    expect(db.prepare('SELECT name FROM conversations').get()!.name).toBe('')
  })
  it('设置、修改、空白清空及 null 清空只改变标签，不写入来源和全文索引', () => {
    const db = database(); ingest(db, '工作群'); const id = listConversations(db)[0].conversationId, before = relations(db)
    expect(setConversationLabel(db, id, '  PrivateRadar 项目  ')).toMatchObject({ sourceConversationName: '工作群', userConversationLabel: 'PrivateRadar 项目', displayConversationName: 'PrivateRadar 项目' })
    expect(setConversationLabel(db, id, '项目组').displayConversationName).toBe('项目组')
    expect(setConversationLabel(db, id, '   ')).toMatchObject({ userConversationLabel: null, displayConversationName: '工作群' })
    setConversationLabel(db, id, '再设名称'); expect(setConversationLabel(db, id, null).displayConversationName).toBe('工作群')
    expect(relations(db)).toEqual(before); expect(db.prepare('SELECT name FROM conversations').get()!.name).toBe('工作群')
  })
  it('未知来源清空后回落未知会话', () => {
    const db = database(); ingest(db); const id = listConversations(db)[0].conversationId
    expect(setConversationLabel(db, id, '项目组').displayConversationName).toBe('项目组')
    expect(setConversationLabel(db, id, null)).toMatchObject({ sourceConversationName: null, userConversationLabel: null, displayConversationName: '未知会话' })
  })
  it('alpha.24 旧结构增量升级，不换数据库、ID、消息及 Evidence 关系或 FTS', () => {
    const f = sharedCoreFixture(); ingest(f.db, '旧来源群')
    f.db.exec('ALTER TABLE conversations DROP COLUMN user_conversation_label')
    const before = relations(f.db), ids = f.db.prepare('SELECT id,name FROM conversations').all()
    const roots = f.db.prepare("SELECT name,rootpage FROM sqlite_master WHERE name LIKE 'messages_fts%' ORDER BY name").all()
    expect(f.db.prepare('PRAGMA user_version').get()!.user_version).toBe(8); f.db.close()
    const upgraded = openDatabase(f.path)
    try {
      expect(upgraded.location()).toBe(f.path)
      expect(upgraded.prepare('SELECT id,name FROM conversations').all()).toEqual(ids)
      expect(listConversations(upgraded).every(row => row.userConversationLabel === null)).toBe(true)
      expect(relations(upgraded)).toEqual(before)
      expect(upgraded.prepare("SELECT name,rootpage FROM sqlite_master WHERE name LIKE 'messages_fts%' ORDER BY name").all()).toEqual(roots)
      initializeDatabase(upgraded); expect(relations(upgraded)).toEqual(before)
      const view = setConversationLabel(upgraded, String(ids[0].id), '持久标签'); expect(view.userConversationLabel).toBe('持久标签')
    } finally { upgraded.close() }
    const restarted = openDatabase(f.path)
    try { expect(listConversations(restarted)[0].userConversationLabel).toBe('持久标签') } finally { restarted.close() }
    expect(readdirSync(f.directory).filter(name => /\.(db|sqlite|sqlite3)$/.test(name))).toEqual(['private-radar.db'])
  })
  it('WorkBuddy 同一来源重导入和来源改名保留用户标签、会话 ID、消息事实', () => {
    const db = database(); ingest(db, '产品讨论群'); const first = listConversations(db)[0], messages = db.prepare('SELECT * FROM messages').all()
    setConversationLabel(db, first.conversationId, 'PrivateRadar 核心组')
    ingest(db, '产品讨论群'); ingest(db, '产品讨论群2')
    expect(listConversations(db)).toEqual([{ ...first, sourceConversationName: '产品讨论群2', userConversationLabel: 'PrivateRadar 核心组', displayConversationName: 'PrivateRadar 核心组' }])
    expect(db.prepare('SELECT * FROM messages').all()).toEqual(messages)
    expect(setConversationLabel(db, first.conversationId, null).displayConversationName).toBe('产品讨论群2')
  })
  it('WorkBuddy 从无名称补全来源名称不更换已有会话身份或丢失标签', () => {
    const db = database(); ingest(db); const first = listConversations(db)[0]
    const messageId = db.prepare('SELECT id FROM messages').get()!.id
    setConversationLabel(db, first.conversationId, '用户项目'); ingest(db, '上游补全群')
    expect(listConversations(db)).toHaveLength(1)
    expect(listConversations(db)[0]).toMatchObject({ conversationId: first.conversationId, sourceConversationName: '上游补全群', userConversationLabel: '用户项目' })
    expect(db.prepare('SELECT id,conversation_id FROM messages').get()).toEqual({ id: messageId, conversation_id: first.conversationId })
  })
  it('同一数据库上的 IPC 设置、清空、非法输入和不存在会话均有确定结果', () => {
    const db = database(); ingest(db, 'IPC 来源'); const id = listConversations(db)[0].conversationId
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerConversationLabelIpc({ handle: (name, listener) => handlers.set(name, listener) }, db)
    expect(handlers.get('conversation-labels:set')!(null, id, 'IPC 标签')).toMatchObject({ ok: true, value: { displayConversationName: 'IPC 标签' } })
    expect(handlers.get('conversation-labels:list')!(null)).toMatchObject({ ok: true, value: [{ conversationId: id, userConversationLabel: 'IPC 标签' }] })
    for (const label of [undefined, 1, {}, '长'.repeat(121), '名称\n换行']) expect(handlers.get('conversation-labels:set')!(null, id, label)).toMatchObject({ ok: false })
    expect(handlers.get('conversation-labels:set')!(null, '不存在', '标签')).toMatchObject({ ok: false })
    expect(handlers.get('conversation-labels:set')!(null, id, null)).toMatchObject({ ok: true, value: { displayConversationName: 'IPC 来源' } })
  })
  it('旧未知会话对应多个冲突来源身份时不猜选一个名称覆盖全局来源', () => {
    const db = database()
    const input = { source_batch_id: '混合来源回归', messages: [0, 1].map(n => ({ platform: 'wechat', source_position: n, source_message_id: `混合原文${n}`, content: `明确正文${n}` })) }
    ingestWorkBuddyMessages(db, input); const first = listConversations(db)[0]
    setConversationLabel(db, first.conversationId, '用户分组名称')
    ingestWorkBuddyMessages(db, { ...input, messages: input.messages.map((m, n) => ({ ...m, conversation_name: `真实来源群${n}`, conversation_name_source: 'source_native' as const })) })
    expect(listConversations(db)).toHaveLength(1)
    expect(listConversations(db)[0]).toMatchObject({ conversationId: first.conversationId, sourceConversationName: null, userConversationLabel: '用户分组名称' })
    expect(db.prepare('SELECT conversation_name FROM messages ORDER BY source_position').all()).toEqual([{ conversation_name: '真实来源群0' }, { conversation_name: '真实来源群1' }])
  })
  it('Search、Today、Topic 和 Evidence 派生显示标签，原消息名称仍是来源事实', async () => {
    const db = database(); seedDemoData(db)
    const date = String(db.prepare("SELECT MAX(date(timestamp,'localtime')) AS date FROM messages").get()!.date)
    const daily = runDailyIntelligence(db, date), topics = runTopicRadar(db, date, daily.candidates)
    expect(daily.candidates.length).toBeGreaterThan(0); expect(topics.topics.length).toBeGreaterThan(0)
    for (const row of listConversations(db)) setConversationLabel(db, row.conversationId, 'PrivateRadar 显示组')
    const state = relations(db), context = getCandidateEvidence(db, daily.candidates[0].candidateId)!
    for (const message of context.groups.flatMap(group => group.messages)) {
      expect(message.displayConversationName).toBe('PrivateRadar 显示组'); expect(message.sourceConversationName).not.toBe('PrivateRadar 显示组')
    }
    const topicEvidence = getTopicEvidence(db, topics.topics[0].topicId, date)!
    expect(topicEvidence.messages.every(row => row.displayConversationName === 'PrivateRadar 显示组')).toBe(true)
    const search = await askChat(db, 'Claude Code', { aiProvider: null, embeddingProvider: null, anchorDate: date })
    expect(search.results.length + search.unverifiedTimeResults.length).toBeGreaterThan(0)
    for (const message of [...search.results, ...search.unverifiedTimeResults]) {
      expect(message.displayConversationName).toBe('PrivateRadar 显示组'); expect(message.conversationName).not.toBe('PrivateRadar 显示组')
      expect(getMessageContext(db, message.messageId)!.messages.every(row => row.displayConversationName === 'PrivateRadar 显示组')).toBe(true)
    }
    expect(relations(db).messages).toEqual(state.messages)
    const understood = understandQuery(db, 'PrivateRadar 显示组里 Claude Code', date)
    expect(understood.conversationIds.length).toBeGreaterThan(0)
  })
  it('Today 关注词、Keyword、承诺候选与已确认承诺统一读取当前标签，来源快照和 Evidence 关系不变', () => {
    const f = reviewFixture(['我会处理 Codex 接口']), before = relations(f.db)
    const first = listCommitmentCandidates(f.db)[0]; expect(first.conversationId).toBeTruthy()
    setConversationLabel(f.db, first.conversationId!, '承诺显示组')
    const candidates = listCommitmentCandidates(f.db); expect(candidates[0].displayConversationName).toBe('承诺显示组')
    expect(getCommitmentCandidateContext(f.db, first.id).entries[0].displayConversationName).toBe('承诺显示组')
    const hits = listRecentKeywordHits(f.db); expect(hits[0].displayConversationName).toBe('承诺显示组')
    expect(getKeywordHitContext(f.db, hits[0].id).entries[0].displayConversationName).toBe('承诺显示组')
    expect(getTodayKeywordInterest(f.db, new Date(first.chatTimestamp!)).items[0].displayConversationName).toBe('承诺显示组')
    confirmCommitmentCandidate(f.db, first.id)
    expect(listCommitmentCandidates(f.db)[0]).toMatchObject({ status: 'confirmed', displayConversationName: '承诺显示组' })
    expect(relations(f.db)).toEqual(before)
  })
})
