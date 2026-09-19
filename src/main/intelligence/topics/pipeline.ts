import { createHash } from 'node:crypto'
import type { DailyCandidate, TopicRadarItem, TopicTrendPoint } from '../../../shared/models'
import { DEFAULT_TOPIC_RADAR_CONFIG } from './config'
import { recognizeTopicClusters } from './recognition'
import { calculateSignalScore } from './signal-score'
import type { TopicPipelineInput } from './types'

// Topic 的 D1 importance 输入随 Daily v1.1 更新，故仅升级缓存版本以触发重算。
export const TOPIC_ALGORITHM_VERSION = 'topic-radar-v1.1-daily-semantic-content'

export function buildTopicRadar(input: TopicPipelineInput): { date: string; historyDays: number; topics: TopicRadarItem[] } {
  const config = input.config ?? DEFAULT_TOPIC_RADAR_CONFIG
  const windowDates = dateRange(input.date, config.historyDays)
  const historyDates = windowDates.slice(0, -1)
  const availableHistoryDates = input.availableHistoryDates
    ? historyDates.filter((date) => input.availableHistoryDates!.includes(date))
    : historyDates.filter((date) => input.messages.some((message) => messageDate(message.timestamp) === date))
  const clusters = recognizeTopicClusters(input.messages, config)
  const topics: TopicRadarItem[] = []

  for (const cluster of clusters) {
    const todayMessages = cluster.messages.filter((message) => messageDate(message.timestamp) === input.date)
    if (todayMessages.length === 0) continue
    const trend = windowDates.map((date): TopicTrendPoint => {
      const messages = cluster.messages.filter((message) => messageDate(message.timestamp) === date)
      return {
        date,
        messageCount: messages.length,
        conversationCount: knownConversationCount(messages),
        senderCount: knownSenderCount(messages)
      }
    })
    const historical = trend.slice(0, -1)
    const denominator = availableHistoryDates.length
    const historicalAvgMessageCount = averageForAvailable(historical, availableHistoryDates, 'messageCount', denominator)
    const historicalAvgConversationCount = averageForAvailable(historical, availableHistoryDates, 'conversationCount', denominator)
    const historicalAvgSenderCount = averageForAvailable(historical, availableHistoryDates, 'senderCount', denominator)
    const sourceMessageIds = todayMessages.map((message) => message.id)
    const d1Importance = maxD1Importance(sourceMessageIds, input.d1Candidates ?? [])
    const score = calculateSignalScore({
      todayMessageCount: todayMessages.length,
      todayConversationCount: knownConversationCount(todayMessages),
      todaySenderCount: knownSenderCount(todayMessages),
      historicalAvgMessageCount,
      historicalAvgConversationCount,
      historicalAvgSenderCount,
      appearedInHistory: historical.some((point) => point.messageCount > 0),
      d1ImportanceScore: d1Importance,
      dailyMessageCounts: trend.map((point) => point.messageCount)
    })
    const allTimes = cluster.messages.map((message) => message.timestamp).sort()
    topics.push({
      topicId: topicId(cluster.identity),
      canonicalName: cluster.canonicalName,
      aliases: [...cluster.aliases].sort(),
      date: input.date,
      messageCount: todayMessages.length,
      conversationCount: knownConversationCount(todayMessages),
      senderCount: knownSenderCount(todayMessages),
      firstSeenAt: allTimes[0],
      lastSeenAt: allTimes.at(-1)!,
      historicalAvgMessageCount,
      historicalAvgConversationCount,
      historicalAvgSenderCount,
      growthRate: score.growthRate,
      noveltyScore: score.noveltyScore,
      signalScore: score.signalScore,
      sourceMessageIds,
      reasonCodes: score.reasonCodes,
      trend
    })
  }

  return {
    date: input.date,
    historyDays: availableHistoryDates.length,
    topics: topics
      .filter((topic) => topic.signalScore >= config.minimumSignalScore)
      .sort((left, right) => right.signalScore - left.signalScore || left.firstSeenAt.localeCompare(right.firstSeenAt) || left.topicId.localeCompare(right.topicId))
      .slice(0, config.topLimit)
  }
}

function maxD1Importance(sourceIds: string[], candidates: DailyCandidate[]): number {
  const sources = new Set(sourceIds)
  return candidates.reduce((max, candidate) =>
    candidate.sourceMessageIds.some((id) => sources.has(id)) ? Math.max(max, candidate.importanceScore) : max, 0)
}

function averageForAvailable(
  points: TopicTrendPoint[],
  availableDates: string[],
  field: 'messageCount' | 'conversationCount' | 'senderCount',
  denominator: number
): number {
  if (denominator === 0) return 0
  const available = new Set(availableDates)
  const total = points.filter((point) => available.has(point.date)).reduce((sum, point) => sum + point[field], 0)
  return Number((total / denominator).toFixed(3))
}

function topicId(identity: string): string {
  return `topic:${createHash('sha256').update(`${TOPIC_ALGORITHM_VERSION}\u001f${identity}`).digest('hex').slice(0, 32)}`
}

function dateRange(date: string, historyDays: number): string[] {
  return Array.from({ length: historyDays + 1 }, (_, index) => shiftDate(date, index - historyDays))
}

function shiftDate(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function messageDate(timestamp: string): string {
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return timestamp.slice(0, 10)
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function uniqueCount(values: string[]): number {
  return new Set(values).size
}

function knownConversationCount(messages: TopicPipelineInput['messages']): number {
  return uniqueCount(messages.filter((message) => message.conversationKnown !== false).map((message) => message.conversationId))
}

function knownSenderCount(messages: TopicPipelineInput['messages']): number {
  return uniqueCount(messages.filter((message) => message.senderKnown !== false).map((message) => message.senderId))
}
