import type { SignalScoreInput, SignalScoreResult } from './types'

const MAX_GROWTH_RATE = 8

export function calculateSignalScore(input: SignalScoreInput): SignalScoreResult {
  const growthRate = smoothedGrowthRate(input.todayMessageCount, input.historicalAvgMessageCount)
  const conversationGrowthRate = smoothedGrowthRate(input.todayConversationCount, input.historicalAvgConversationCount)
  const noveltyScore = input.appearedInHistory
    ? Number((1 / (1 + input.historicalAvgMessageCount / 3)).toFixed(3))
    : 1

  const messageGrowth = Math.min(25, Math.log2(1 + Math.max(0, growthRate)) * 8)
  const conversationGrowth = Math.min(18, Math.log2(1 + Math.max(0, conversationGrowthRate)) * 6)
  const conversationBreadth = Math.min(15, Math.log2(1 + input.todayConversationCount) * 6)
  const senderBreadth = Math.min(12, Math.log2(1 + input.todaySenderCount) * 4)
  const novelty = noveltyScore * 15
  const crossGroup = input.todayConversationCount >= 2
    ? Math.min(14, 4 + Math.log2(input.todayConversationCount) * 4)
    : 0
  const d1Signal = Math.min(12, Math.max(0, input.d1ImportanceScore) * 0.8)
  const activity = Math.min(6, Math.log2(1 + input.todayMessageCount) * 1.5)

  let score = messageGrowth + conversationGrowth + conversationBreadth + senderBreadth + novelty + crossGroup + d1Signal + activity
  if (input.todayConversationCount === 1) score = Math.min(score, 58)
  if (input.todayMessageCount === 1) score = Math.min(score, 24)

  const reasonCodes: SignalScoreResult['reasonCodes'] = []
  if (growthRate >= 1) reasonCodes.push('RAPID_MESSAGE_GROWTH')
  if (conversationGrowthRate >= 0.75 && input.todayConversationCount >= 2) reasonCodes.push('RAPID_CONVERSATION_GROWTH')
  if (input.todayConversationCount >= 2) reasonCodes.push('MULTI_CONVERSATION')
  if (input.todaySenderCount >= 2) reasonCodes.push('MULTI_SENDER')
  if (!input.appearedInHistory) reasonCodes.push('NEW_TOPIC')
  if (input.todayConversationCount >= 3) reasonCodes.push('CROSS_GROUP_SPREAD')
  if (input.d1ImportanceScore >= 8) reasonCodes.push('HIGH_D1_IMPORTANCE')
  if (isSustainedGrowth(input.dailyMessageCounts)) reasonCodes.push('SUSTAINED_GROWTH')

  return {
    signalScore: Number(score.toFixed(2)),
    growthRate,
    conversationGrowthRate,
    noveltyScore,
    reasonCodes
  }
}

export function smoothedGrowthRate(today: number, historicalAverage: number): number {
  const baseline = Math.max(1, historicalAverage)
  const rate = (today + 1) / (baseline + 1) - 1
  return Number(Math.max(-1, Math.min(MAX_GROWTH_RATE, rate)).toFixed(3))
}

function isSustainedGrowth(counts: number[]): boolean {
  const recent = counts.slice(-4)
  if (recent.length < 4 || recent.at(-1)! < 3) return false
  return recent[0] < recent[1] && recent[1] < recent[2] && recent[2] < recent[3]
}

