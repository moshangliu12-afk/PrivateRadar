import type { DailyCandidate, TopicRadarItem, TopicReasonCode, TopicTrendPoint } from '../../../shared/models'
import type { DailyMessage } from '../daily/types'

export interface TopicRadarConfig {
  historyDays: number
  topLimit: number
  minimumSignalScore: number
  similarityThreshold: number
}

export interface TopicCluster {
  identity: string
  canonicalName: string
  aliases: Set<string>
  messages: DailyMessage[]
  representative: DailyMessage
}

export interface SignalScoreInput {
  todayMessageCount: number
  todayConversationCount: number
  todaySenderCount: number
  historicalAvgMessageCount: number
  historicalAvgConversationCount: number
  historicalAvgSenderCount: number
  appearedInHistory: boolean
  d1ImportanceScore: number
  dailyMessageCounts: number[]
}

export interface SignalScoreResult {
  signalScore: number
  growthRate: number
  conversationGrowthRate: number
  noveltyScore: number
  reasonCodes: TopicReasonCode[]
}

export interface TopicPipelineInput {
  messages: DailyMessage[]
  date: string
  d1Candidates?: DailyCandidate[]
  availableHistoryDates?: string[]
  config?: TopicRadarConfig
}

export interface TopicPipelineResult {
  date: string
  historyDays: number
  topics: TopicRadarItem[]
}

export interface TopicMetricDraft {
  trend: TopicTrendPoint[]
}

