import { describe, expect, it } from 'vitest'
import { buildDailyBrief } from '../src/main/intelligence/daily/brief'
import { assessDailyValue, rankFinalDailyCandidates } from '../src/main/intelligence/daily/daily-value'
import type { DailyCandidate } from '../src/shared/models'
import { DAILY_VALUE_LABEL_FIXTURES } from './fixtures/daily-value-labeling-alpha6'

function candidate(id: string, representativeText: string, importanceScore = 4): DailyCandidate {
  return {
    candidateId: id,
    date: '2004-02-03',
    title: representativeText.slice(0, 32),
    representativeText,
    importanceScore,
    sourceMessageIds: [id],
    sourceConversationIds: ['group-1'],
    sourceSenderIds: [],
    messageCount: 1,
    conversationCount: 1,
    firstSeenAt: '2004-02-03T10:00:00.000Z',
    lastSeenAt: '2004-02-03T10:00:00.000Z',
    reasonCodes: ['NEW_TOPIC']
  }
}

function assessment(sampleId: string) {
  const fixture = DAILY_VALUE_LABEL_FIXTURES.find((item) => item.sampleId === sampleId)
  if (!fixture) throw new Error(`缺少夹具：${sampleId}`)
  return assessDailyValue(candidate(sampleId, fixture.text))
}

describe('Daily Value 今日价值层', () => {
  it('从零合成夹具保持 3 / 14 / 23 和 2 / 5 / 33 的基线', () => {
    expect(DAILY_VALUE_LABEL_FIXTURES).toHaveLength(40)
    expect(DAILY_VALUE_LABEL_FIXTURES.filter((item) => item.humanLabel === 'must_show')).toHaveLength(3)
    expect(DAILY_VALUE_LABEL_FIXTURES.filter((item) => item.humanLabel === 'may_show')).toHaveLength(14)
    expect(DAILY_VALUE_LABEL_FIXTURES.filter((item) => item.humanLabel === 'drop')).toHaveLength(23)
    expect(DAILY_VALUE_LABEL_FIXTURES.filter((item) => item.desiredPriority === 'high')).toHaveLength(2)
    expect(DAILY_VALUE_LABEL_FIXTURES.filter((item) => item.desiredPriority === 'medium')).toHaveLength(5)
    expect(DAILY_VALUE_LABEL_FIXTURES.filter((item) => item.desiredPriority === 'low')).toHaveLength(33)
  })

  it('12 条固定 D1 回归子集与合成期望的 MUST / MAY / DROP 全部一致', () => {
    const selected = DAILY_VALUE_LABEL_FIXTURES.filter((item) => item.selectedByD1)
    expect(selected).toHaveLength(12)
    for (const fixture of selected) {
      const result = assessDailyValue(candidate(fixture.sampleId, fixture.text))
      expect(result.dailyValue, fixture.sampleId).toBe(fixture.humanLabel)
      expect(result.dailyPriority, fixture.sampleId).toBe(fixture.desiredPriority)
    }
  })

  it('三个 MUST_SHOW 合成样本均保留为明确期望的优先级', () => {
    expect(assessment('DV-014')).toMatchObject({ dailyValue: 'must_show', dailyPriority: 'high' })
    expect(assessment('DV-028')).toMatchObject({ dailyValue: 'must_show', dailyPriority: 'medium' })
    expect(assessment('DV-030')).toMatchObject({ dailyValue: 'must_show', dailyPriority: 'high' })
  })

  it('已被 D1 选中的五个 DROP 反例不会进入 Final Daily', () => {
    for (const sampleId of ['DV-001', 'DV-020', 'DV-031', 'DV-035', 'DV-036']) {
      expect(assessment(sampleId).dailyValue).toBe('drop')
    }
  })

  it('D1 已选中的 MAY_SHOW 不会错误升级为 MUST_SHOW', () => {
    for (const sampleId of ['DV-008', 'DV-027', 'DV-029', 'DV-037']) {
      expect(assessment(sampleId).dailyValue).toBe('may_show')
    }
    expect(assessment('DV-008').dailyPriority).toBe('low')
    expect(assessment('DV-029').dailyPriority).toBe('medium')
  })

  it('单人未经验证的故障最多为 MAY_SHOW + LOW', () => {
    expect(assessment('DV-034')).toMatchObject({
      dailyValue: 'may_show',
      dailyPriority: 'low',
      valueReasonCodes: expect.arrayContaining(['RISK_OR_LIMITATION', 'UNVERIFIED_SINGLE_REPORT'])
    })
  })

  it('排序先比较 Daily Value，再比较独立 Priority，最后才比较 D1 分数', () => {
    const ranked = rankFinalDailyCandidates([
      candidate('opportunity', '求购虚构拼图用的月牙卡片。', 9.9),
      candidate('notice', '虚构拼装站公告：公共积木轨道存在脱落风险，请及时处理松动接头，保持通道畅通。', 3.2),
      candidate('resource', '虚构纹样知识库适合查找几何拼片的练习步骤。', 8.8),
      candidate('link', 'https://synthetic.invalid/value-link', 9.8)
    ])
    expect(ranked.map((item) => item.candidate.candidateId)).toEqual(['notice', 'resource', 'opportunity'])
    expect(ranked.map((item) => item.assessment.dailyValue)).toEqual(['must_show', 'may_show', 'may_show'])
  })

  it('没有 MUST_SHOW 或 MAY_SHOW 时允许 Final Daily 为空，不强制凑数量', () => {
    const ranked = rankFinalDailyCandidates([
      candidate('link', 'https://synthetic.invalid/value-link', 9.8),
      candidate('opaque', 'qyx+zpt v8.6 demo', 8.6),
      candidate('question', '虚构星图的纸舟应该朝哪个方向？', 6.2)
    ])
    expect(ranked).toEqual([])
  })

  it('规则模式使用 Daily Value 的优先级和解释，而不是 D1 分数分档', async () => {
    const safety = candidate('safety', '虚构拼装站公告：公共积木轨道存在脱落风险，请及时处理松动接头，保持通道畅通。', 3.2)
    const opportunity = candidate('opportunity', '求购虚构拼图用的月牙卡片。', 9.8)
    const result = await buildDailyBrief({} as never, '2004-02-03', [opportunity, safety], null)
    expect(result.items.map((item) => item.candidateId)).toEqual(['safety', 'opportunity'])
    expect(result.items[0]).toMatchObject({ importanceLevel: 'high', dailyValue: 'must_show' })
    expect(result.items[0].whyItMatters).toContain('风险')
    expect(result.items[1]).toMatchObject({ importanceLevel: 'low', dailyValue: 'may_show' })
  })
})
