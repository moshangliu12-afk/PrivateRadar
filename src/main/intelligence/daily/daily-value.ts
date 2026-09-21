import type {
  DailyCandidate,
  DailyValueAssessment,
  DailyValueReasonCode,
  ImportanceLevel
} from '../../../shared/models'
import { analyzeDailyValueSignals } from './signals'

/** Daily Value 规则版本会进入 Daily Brief 缓存键。 */
export const DAILY_VALUE_VERSION = 'daily-value-v2'

export interface ValuedDailyCandidate {
  candidate: DailyCandidate
  assessment: DailyValueAssessment
}

/**
 * 只根据 D1 已产生的候选及其代表文本做确定性价值判断。
 * 不改变 D1 分数、候选生成、原始消息或 Topic 输入。
 */
export function assessDailyValue(candidate: DailyCandidate): DailyValueAssessment {
  const text = normalize(candidate.representativeText)
  const analysis = analyzeDailyValueSignals(text)

  if (analysis.mediaPlaceholder) return drop(['MEDIA_PLACEHOLDER'], '这是一条没有独立正文的媒体占位信息。')
  if (analysis.bareLink) return drop(['BARE_LINK', 'CONTEXTLESS'], '只有链接，缺少资源用途、变化说明或行动上下文。')

  if (analysis.actionRequired && analysis.deadlineOrTimeSensitive && analysis.consequence) {
    return mustShow(
      'high',
      ['ACTION_REQUIRED'],
      '包含明确行动、时间约束和不执行的具体后果。'
    )
  }

  if (analysis.formalNotice && analysis.riskOrLimitation && analysis.actionRequired && analysis.broadImpact) {
    return mustShow(
      'high',
      ['RISK_OR_LIMITATION', 'ACTION_REQUIRED', 'BROAD_IMPACT'],
      '涉及明确风险，并包含面向相关人群的行动要求。'
    )
  }

  if (analysis.timelyMultiEvent) {
    return mustShow(
      'high',
      ['TIMELY_MULTI_EVENT', 'BROAD_IMPACT', 'VERIFIABLE_UPDATE'],
      '包含多个具有时效性的明确事件与产品变化。'
    )
  }

  if (analysis.verifiableChange && analysis.hasExplicitObject) {
    return mayShow('medium', ['VERIFIABLE_UPDATE'], '产品或项目出现了明确、可核对的更新。')
  }

  if (analysis.failureOrLoss) {
    return mayShow(
      'low',
      ['RISK_OR_LIMITATION', ...(analysis.unverifiedSingleReport ? ['UNVERIFIED_SINGLE_REPORT'] as const : [])],
      '反映了明确失败，并伴随积分、费用、权益或其他实际损失。'
    )
  }

  if (analysis.opportunity) {
    const priority: ImportanceLevel = analysis.structuredOpportunity ? 'medium' : 'low'
    return mayShow(priority, ['OPPORTUNITY_SIGNAL'], '包含明确的采购、供给、合作或工作机会线索。')
  }

  if (analysis.relevantResource) {
    return mayShow('medium', ['RELEVANT_RESOURCE'], '提供了具体资源或工具，并说明了用途或适用场景。')
  }

  if (analysis.riskOrLimitation && (analysis.consequence || analysis.alternativeCost || analysis.hasExplicitObject)) {
    const priority: ImportanceLevel = analysis.broadImpact ? 'medium' : 'low'
    const reasons: DailyValueReasonCode[] = ['RISK_OR_LIMITATION']
    if (analysis.unverifiedSingleReport) reasons.push('UNVERIFIED_SINGLE_REPORT')
    return mayShow(priority, reasons, analysis.unverifiedSingleReport
      ? '反映了可能影响使用的故障或限制，但目前只有单条、未验证的观察。'
      : '反映了可能影响使用、决策或安全的限制信息。')
  }

  if (analysis.questionOnly) return drop(['QUESTION_ONLY', 'CONTEXTLESS'], '只有提问，没有足够的事实、变化或可执行结论。')
  if (analysis.opaqueTokenOnly) return drop(['OPAQUE_TOKEN_ONLY', 'CONTEXTLESS'], '只有产品或版本碎片，未说明发生了什么变化。')
  if (analysis.chatter) return drop(['CHATTER', 'CONTEXTLESS'], '属于普通闲聊、猜测或缺少独立上下文的短句。')
  return drop(['CONTEXTLESS'], '缺少明确事件、风险、行动要求或可复用的资源上下文。')
}

/** Final Daily 的确定性排序；D1 分数只在同层级时作为第三排序键。 */
export function rankFinalDailyCandidates(candidates: DailyCandidate[]): ValuedDailyCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, assessment: assessDailyValue(candidate) }))
    .filter((item) => item.assessment.dailyValue !== 'drop')
    .sort((left, right) =>
      valueRank(right.assessment.dailyValue) - valueRank(left.assessment.dailyValue) ||
      priorityRank(right.assessment.dailyPriority) - priorityRank(left.assessment.dailyPriority) ||
      right.candidate.importanceScore - left.candidate.importanceScore ||
      left.candidate.firstSeenAt.localeCompare(right.candidate.firstSeenAt) ||
      left.candidate.candidateId.localeCompare(right.candidate.candidateId)
    )
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function mustShow(priority: ImportanceLevel, reasons: DailyValueReasonCode[], whyItMatters: string): DailyValueAssessment {
  return { dailyValue: 'must_show', dailyPriority: priority, valueReasonCodes: reasons, whyItMatters }
}

function mayShow(priority: ImportanceLevel, reasons: DailyValueReasonCode[], whyItMatters: string): DailyValueAssessment {
  return { dailyValue: 'may_show', dailyPriority: priority, valueReasonCodes: reasons, whyItMatters }
}

function drop(reasons: DailyValueReasonCode[], whyItMatters: string): DailyValueAssessment {
  return { dailyValue: 'drop', dailyPriority: 'low', valueReasonCodes: reasons, whyItMatters }
}

function valueRank(value: DailyValueAssessment['dailyValue']): number {
  return value === 'must_show' ? 2 : value === 'may_show' ? 1 : 0
}

function priorityRank(priority: ImportanceLevel): number {
  return priority === 'high' ? 3 : priority === 'medium' ? 2 : 1
}
