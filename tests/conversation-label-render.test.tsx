import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ConversationLabelProvider, ConversationName } from '../src/renderer/src/conversation-labels'
import { SearchPage, RadarPage } from '../src/renderer/src/App'
import { CommitmentCandidateCard, CommitmentContext } from '../src/renderer/src/commitment-candidates-page'
import { ConfirmedCommitmentCard } from '../src/renderer/src/confirmed-commitments-page'
import { KeywordHitCard, KeywordContext } from '../src/renderer/src/keyword-radar-page'
import { TodayKeywordInterestCard } from '../src/renderer/src/today-keyword-interest-section'
import type { ConversationLabelApi } from '../src/shared/conversation-labels'
import type { CommitmentCandidateView, CommitmentDesktopApi } from '../src/shared/commitment'
import type { KeywordHitView, KeywordRadarDesktopApi } from '../src/shared/keyword-radar'
import type { TodayKeywordInterestItem } from '../src/shared/today-keyword-interest'
import type { ChatQueryResponse, TopicEvidence, TopicRadarSummary } from '../src/shared/models'
import { initializeDatabase } from '../src/main/schema'
import { seedDemoData } from '../src/main/demo'
import { listConversations, setConversationLabel } from '../src/main/conversation-labels'
import { askChat, getMessageContext } from '../src/main/retrieval/service'
import { runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import { getTopicEvidence, runTopicRadar } from '../src/main/intelligence/topics/repository'

const label = 'PrivateRadar 显示组'
const names = { conversationId: '渲染会话', sourceConversationName: '来源事实群', userConversationLabel: label, displayConversationName: '过期派生缓存', conversationName: '原始记录群' }
const source = { batchItemId: '渲染附件', attachmentName: '来源附件.zip', ordinal: 0, evidenceKind: 'zip' as const, evidenceStatus: 'available' as const, evidenceRecorded: true }
const occurrence = { ...names, batchItemId: source.batchItemId, sourcePosition: 0, messageId: '渲染消息', body: '我会处理 Codex 接口', senderName: '来源发言人', chatTimestamp: '2026-10-08T09:00:00+08:00', timestampSource: 'source_native' as const }
const hit: KeywordHitView = { ...occurrence, id: '渲染命中', groupId: '关注组', groupName: '工具关注', matchedTerms: ['Codex'], matchedAt: '2026-10-08T10:00:00+08:00', source }
const candidate: CommitmentCandidateView = { ...occurrence, id: '渲染承诺', status: 'pending', reviewedAt: null, ruleId: 'self_take_action', reasonCode: 'explicit_self_take_action', ruleVersion: 'commitment-v1', source }
const keywordApi = {} as KeywordRadarDesktopApi, commitmentApi = {} as CommitmentDesktopApi
const api: ConversationLabelApi = { listConversations: vi.fn(), setConversationLabel: vi.fn() }
const render = (children: ReactNode) => renderToStaticMarkup(createElement(ConversationLabelProvider, { api, children }))
function displayedNames(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*class="conversation-name"[^>]*>([^<]*)<svg/g)].map(match => match[1])
}
function expectNames(html: string, expected = label) {
  const values = displayedNames(html)
  expect(values.length).toBeGreaterThan(0)
  expect(values.every(value => value === expected)).toBe(true)
  expect(html).not.toContain('过期派生缓存')
}
let response: ChatQueryResponse, context: ReturnType<typeof getMessageContext>, radar: TopicRadarSummary, topicEvidence: TopicEvidence
beforeAll(async () => {
  const db = new DatabaseSync(':memory:')
  try {
    initializeDatabase(db); seedDemoData(db)
    const date = String(db.prepare("SELECT MAX(date(timestamp,'localtime')) AS date FROM messages").get()!.date)
    const daily = runDailyIntelligence(db, date)
    radar = runTopicRadar(db, date, daily.candidates)
    for (const conversation of listConversations(db)) setConversationLabel(db, conversation.conversationId, label)
    response = await askChat(db, 'Claude Code', { aiProvider: null, embeddingProvider: null, anchorDate: date })
    expect(response.results.length).toBeGreaterThan(0)
    context = getMessageContext(db, response.results[0].messageId)
    topicEvidence = getTopicEvidence(db, radar.topics[0].topicId, date)!
  } finally { db.close() }
})

describe('现有会话来源展示点', () => {
  it.each([
    [label, '来源事实群', label], [null, '来源事实群', '来源事实群'], [null, null, '未知会话']
  ])('用户名称 %s、来源 %s 使用统一派生结果 %s', (user, sourceName, expected) => {
    expectNames(render(createElement(ConversationName, { value: { ...names, userConversationLabel: user, sourceConversationName: sourceName } })), expected!)
  })
  it('Search 已验证与时间未验证来源、展开上下文均显示用户名称', () => {
    const html = render(createElement(SearchPage, { status: null, question: 'Claude Code', querying: false,
      response: { ...response, unverifiedTimeResults: [{ ...response.results[0], messageId: '时间未验证消息', timeVerification: 'unknown', timestamp: '' }] },
      openMessageId: response.results[0].messageId, context, onQuestionChange: vi.fn(), onSubmit: vi.fn(), onToggleContext: vi.fn() }))
    expectNames(html)
    expect(html).toContain('原始消息与前后文')
    expect(displayedNames(html).length).toBeGreaterThan(response.results.length + 1)
  })
  it('Topic 只在展开原始依据时显示会话名，聚合卡片不新增会话名称', () => {
    const props = { radar, evidence: topicEvidence, onToggleEvidence: vi.fn() }
    const closed = render(createElement(RadarPage, { ...props, openTopicId: '' }))
    expect(displayedNames(closed)).toEqual([])
    const opened = render(createElement(RadarPage, { ...props, openTopicId: topicEvidence.topicId }))
    expectNames(opened); expect(opened).toContain('今日话题原始依据')
  })
  it('承诺候选、已确认承诺及其来源上下文均使用显示名称', () => {
    expectNames(render(createElement(CommitmentCandidateCard, { candidate, api: commitmentApi, onReviewed: vi.fn() })))
    expectNames(render(createElement(ConfirmedCommitmentCard, { candidate: { ...candidate, status: 'confirmed', reviewedAt: '2026-10-08T11:00:00Z' }, api: commitmentApi })))
    expectNames(render(createElement(CommitmentContext, { context: { candidateId: candidate.id, batchItemId: source.batchItemId, entries: [{ ...occurrence, isCurrent: true }] } })))
  })
  it('Keyword 具体命中及上下文、Today 具体关注词消息均使用显示名称', () => {
    expectNames(render(createElement(KeywordHitCard, { hit, api: keywordApi })))
    expectNames(render(createElement(KeywordContext, { context: { hitId: hit.id, batchItemId: source.batchItemId, entries: [{ ...occurrence, isCurrent: true }] } })))
    const item: TodayKeywordInterestItem = { ...occurrence, representativeHitId: hit.id, matchedTerms: hit.matchedTerms, matches: [], source }
    expectNames(render(createElement(TodayKeywordInterestCard, { item, api: keywordApi })))
  })
  it('编辑入口的悬停和键盘焦点样式具有背景反馈与焦点轮廓', () => {
    const css = readFileSync(new URL('../src/renderer/src/conversation-labels.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.conversation-name:hover,\s*\.conversation-name:focus-visible\s*\{[^}]*background:/)
    expect(css).toMatch(/\.conversation-name:focus-visible\s*\{[^}]*outline:\s*2px solid/)
  })
})
