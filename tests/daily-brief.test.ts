import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAIProvider } from '../src/main/ai/mock-provider'
import { OpenAICompatibleProvider } from '../src/main/ai/openai-compatible-provider'
import { resolveAIProvider } from '../src/main/ai/config'
import type { StructuredAIRequest } from '../src/main/ai/provider'
import { seedDemoData } from '../src/main/demo'
import {
  buildAIInput,
  buildDailyBrief,
  parseAIResponse,
  type DailyAIInput
} from '../src/main/intelligence/daily/brief'
import { getCandidateEvidence, runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import { rankFinalDailyCandidates } from '../src/main/intelligence/daily/daily-value'
import { initializeDatabase } from '../src/main/schema'
import type { DailyCandidate } from '../src/shared/models'

const databases: DatabaseSync[] = []

afterEach(() => {
  vi.restoreAllMocks()
  while (databases.length) databases.pop()!.close()
})

function demo(): { db: DatabaseSync; date: string; candidates: DailyCandidate[] } {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  initializeDatabase(db)
  seedDemoData(db)
  const date = (db.prepare(`SELECT MAX(date(timestamp, 'localtime')) AS date FROM messages`).get() as { date: string }).date
  return { db, date, candidates: runDailyIntelligence(db, date).candidates }
}

function validResponse(request: StructuredAIRequest): string {
  const input = request.input as DailyAIInput
  return JSON.stringify({
    brief_date: input.brief_date,
    items: input.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      title: `整理：${candidate.title}`,
      summary: `群内共有 ${candidate.message_count} 条相关消息。`,
      why_it_matters: '这是可追溯且具有明确信息量的候选。',
      category: '产品 / 技术',
      importance_level: 'high',
      source_message_ids: ['伪造编号']
    }))
  })
}

describe('D2 今日情报增强', () => {
  it('Mock Provider 正常返回可阅读情报', async () => {
    const { db, date, candidates } = demo()
    const provider = new MockAIProvider(validResponse)
    const result = await buildDailyBrief(db, date, candidates, provider)
    expect(result.mode).toBe('ai')
    expect(result.items[0].title).toMatch(/^整理：/)
    expect(result.items[0].summary).toContain('相关消息')
    expect(provider.callCount).toBe(1)
  })

  it('合法 AI JSON 可以被严格解析', () => {
    const { db, date, candidates } = demo()
    const input = buildAIInput(db, date, candidates)
    const parsed = parseAIResponse(validResponse({ task: 'test', systemPrompt: '', input }), date, candidates)
    expect(parsed).toHaveLength(candidates.length)
    expect(parsed[0].candidateId).toBe(candidates[0].candidateId)
  })

  it('非法 JSON 重试后自动降级', async () => {
    const { db, date, candidates } = demo()
    const provider = new MockAIProvider(() => '{非法')
    const result = await buildDailyBrief(db, date, candidates, provider)
    expect(result.mode).toBe('rule')
    expect(result.notice).toContain('AI增强暂时不可用')
    expect(provider.callCount).toBe(2)
  })

  it('Provider 报错时页面数据降级为规则结果', async () => {
    const { db, date, candidates } = demo()
    const provider = new MockAIProvider(() => { throw new Error('网络不可用') })
    const result = await buildDailyBrief(db, date, candidates, provider)
    expect(result.mode).toBe('rule')
    expect(result.items.map((item) => item.candidateId)).toEqual(
      rankFinalDailyCandidates(candidates).slice(0, 10).map((item) => item.candidate.candidateId)
    )
  })

  it('AI 返回不存在的 candidate_id 时拒绝整次结果', async () => {
    const { db, date, candidates } = demo()
    const provider = new MockAIProvider((request) => {
      const value = JSON.parse(validResponse(request)) as { items: Array<{ candidate_id: string }> }
      value.items[0].candidate_id = '不存在的候选'
      return JSON.stringify(value)
    })
    const result = await buildDailyBrief(db, date, candidates, provider)
    expect(result.mode).toBe('rule')
  })

  it('source_message_ids 始终使用 D1 映射而不相信模型', async () => {
    const { db, date, candidates } = demo()
    const result = await buildDailyBrief(db, date, candidates, new MockAIProvider(validResponse))
    const original = candidates.find((candidate) => candidate.candidateId === result.items[0].candidateId)
    expect(result.items[0].sourceMessageIds).toEqual(original?.sourceMessageIds)
    expect(result.items[0].sourceMessageIds).not.toContain('伪造编号')
  })

  it('相同 candidate set 命中持久化缓存', async () => {
    const { db, date, candidates } = demo()
    const provider = new MockAIProvider(validResponse)
    const first = await buildDailyBrief(db, date, candidates, provider)
    const second = await buildDailyBrief(db, date, candidates, provider)
    expect(first.telemetry?.cacheHit).toBe(false)
    expect(second.telemetry?.cacheHit).toBe(true)
    expect(provider.callCount).toBe(1)
    const forced = await buildDailyBrief(db, date, candidates, provider, true)
    expect(forced.telemetry?.cacheHit).toBe(false)
    expect(provider.callCount).toBe(2)
  })

  it('candidate 集合变化后重新分析', async () => {
    const { db, date, candidates } = demo()
    const provider = new MockAIProvider(validResponse)
    await buildDailyBrief(db, date, candidates, provider)
    const retainedId = rankFinalDailyCandidates(candidates)[0]!.candidate.candidateId
    const changed = candidates.map((candidate) => candidate.candidateId === retainedId ? { ...candidate, title: `${candidate.title}（新增依据）` } : candidate)
    const result = await buildDailyBrief(db, date, changed, provider)
    expect(result.telemetry?.cacheHit).toBe(false)
    expect(provider.callCount).toBe(2)
  })

  it('没有 AI 配置时规则模式仍然正常运行', async () => {
    const { db, date, candidates } = demo()
    expect(resolveAIProvider({})).toBeNull()
    const result = await buildDailyBrief(db, date, candidates, null)
    expect(result.mode).toBe('rule')
    expect(result.items[0].candidateId).toBe(rankFinalDailyCandidates(candidates)[0]!.candidate.candidateId)
  })

  it('AI 卡片仍能打开 D1 原始依据', async () => {
    const { db, date, candidates } = demo()
    const result = await buildDailyBrief(db, date, candidates, new MockAIProvider(validResponse))
    const evidence = getCandidateEvidence(db, result.items[0].candidateId)
    const original = candidates.find((candidate) => candidate.candidateId === result.items[0].candidateId)
    expect(evidence?.groups.map((group) => group.sourceMessageId)).toEqual(original?.sourceMessageIds)
    expect(evidence?.groups.every((group) => group.messages.some((message) => message.isSource))).toBe(true)
  })

  it('API Key 不写入控制台日志或模型正文', async () => {
    const secret = '绝不能进入日志的密钥'
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    const provider = new OpenAICompatibleProvider({ baseUrl: 'https://ai.example.test/v1', apiKey: secret, model: 'test-model', fetchImpl })
    const output = await provider.generateStructured({ task: 'test', systemPrompt: '只返回 JSON', input: { safe: true } })
    expect(output).not.toContain(secret)
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain(secret)
  })

  it('AI 输出不能增加新的候选', async () => {
    const { db, date, candidates } = demo()
    const provider = new MockAIProvider((request) => {
      const value = JSON.parse(validResponse(request)) as { items: unknown[] }
      value.items.push({
        candidate_id: '模型创造的新候选', title: '虚构内容', summary: '虚构', why_it_matters: '虚构',
        category: '其他', importance_level: 'high', source_message_ids: []
      })
      return JSON.stringify(value)
    })
    const result = await buildDailyBrief(db, date, candidates, provider)
    expect(result.mode).toBe('rule')
    expect(result.items.every((item) => candidates.some((candidate) => candidate.candidateId === item.candidateId))).toBe(true)
  })
})
