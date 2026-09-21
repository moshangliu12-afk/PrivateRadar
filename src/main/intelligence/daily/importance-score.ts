import type { DailyReasonCode } from '../../../shared/models'
import type { ImportanceInput, MessageFeatures } from './types'

export interface ImportanceResult {
  score: number
  reasonCodes: DailyReasonCode[]
}

export function messageInformationScore(features: MessageFeatures): number {
  let score = 0.5
  if (features.hasLink) score += 1.4
  if (features.hasTrustedLink) score += 0.8
  if (features.hasGithub) score += 1.2
  if (features.hasProductOrVersion) score += 1
  if (features.hasNumberOrDate) score += 0.5
  if (features.hasEventOrRelease) score += 1.2
  if (features.hasFileOrResource) score += 0.7
  if (features.informationDense) score += 1.2
  // 单个词不加分；只有行动/变化/失败/风险与明确影响组成强组合时才允许单条消息进入 D1。
  if (features.actionRequired && (features.deadlineOrTimeSensitive || features.consequence)) score += 1.8
  if (features.verifiableChange && features.hasExplicitObject) score += 1.8
  if (features.failureOrLoss) score += 1.8
  if (features.riskOrLimitation && (features.consequence || features.alternativeCost)) score += 1.8

  if (features.meaningfulLength >= 12 && features.meaningfulLength <= 180) score += 1
  else if (features.meaningfulLength > 180 && features.meaningfulLength <= 400) score += 0.6
  else if (features.meaningfulLength > 400) score += 0.2
  else if (features.meaningfulLength >= 7) score += 0.3
  return score
}

export function importanceScore(input: ImportanceInput): ImportanceResult {
  let score = messageInformationScore(input.features)
  const reasons: DailyReasonCode[] = []
  if (input.features.hasLink) reasons.push('HAS_LINK')
  if (input.features.hasTrustedLink) reasons.push('TRUSTED_LINK')
  if (input.features.hasGithub) reasons.push('GITHUB_REFERENCE')
  if (input.features.hasProductOrVersion) reasons.push('PRODUCT_OR_VERSION')
  if (input.features.hasNumberOrDate) reasons.push('SPECIFIC_NUMBER_OR_DATE')
  if (input.features.hasEventOrRelease) reasons.push('EVENT_OR_RELEASE')
  if (input.features.hasFileOrResource) reasons.push('FILE_OR_RESOURCE')
  if (input.features.informationDense) reasons.push('INFORMATION_DENSE')

  if (input.senderCount >= 2) {
    score += Math.min(2.4, 0.9 + Math.log2(input.senderCount) * 0.65)
    reasons.push('MULTI_SENDER')
  }
  if (input.conversationCount >= 2) {
    score += Math.min(3.2, 1.1 + Math.log2(input.conversationCount) * 0.9)
    reasons.push('MULTI_CONVERSATION')
  }
  if (input.hasHighDiscussion) {
    score += 1.5
    reasons.push('HIGH_DISCUSSION')
  }
  if (input.messageCount >= 2) score += Math.min(1.2, Math.log2(input.messageCount) * 0.45)
  if (input.isNewTopic) {
    score += 0.8
    reasons.push('NEW_TOPIC')
  }

  return { score: Number(score.toFixed(2)), reasonCodes: reasons }
}
