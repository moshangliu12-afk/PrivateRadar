import type { DatabaseSync } from 'node:sqlite'
import type { DailyCandidate, EvidenceMessage, TopicEvidence, TopicRadarItem, TopicRadarSummary } from '../../../shared/models'
import { loadMessagesForDate, runDailyIntelligence } from '../daily/repository'
import { buildTopicRadar, TOPIC_ALGORITHM_VERSION } from './pipeline'

export function runTopicRadar(db: DatabaseSync, date: string, d1Candidates?: DailyCandidate[]): TopicRadarSummary {
  const candidates = d1Candidates ?? runDailyIntelligence(db, date).candidates
  const dates = dateRange(date, 7)
  const messages = dates.flatMap((item) => loadMessagesForDate(db, item))
  const availableHistoryDates = (db.prepare(`
    SELECT DISTINCT date(timestamp, 'localtime') AS date
    FROM messages
    WHERE date(timestamp, 'localtime') < ? AND date(timestamp, 'localtime') >= date(?, '-7 days')
    ORDER BY date
  `).all(date, date) as Array<{ date: string }>).map((row) => row.date)
  const result = buildTopicRadar({ messages, date, d1Candidates: candidates, availableHistoryDates })
  saveTopics(db, result.topics, date)
  return result
}

export function loadSavedTopicRadar(db: DatabaseSync, date: string): TopicRadarSummary | null {
  const rows = db.prepare(`
    SELECT m.topic_id, m.metric_date, t.canonical_name, t.aliases_json,
           m.message_count, m.conversation_count, m.sender_count,
           m.first_seen_at, m.last_seen_at, m.historical_avg_message_count,
           m.historical_avg_conversation_count, m.historical_avg_sender_count,
           m.growth_rate, m.novelty_score, m.signal_score,
           m.source_message_ids_json, m.reason_codes_json, m.trend_json
    FROM topic_daily_metrics m
    JOIN topics t ON t.id = m.topic_id
    WHERE m.metric_date = ? AND m.algorithm_version = ?
    ORDER BY m.signal_score DESC, m.first_seen_at, m.topic_id
  `).all(date, TOPIC_ALGORITHM_VERSION) as unknown as SavedTopicRow[]
  if (rows.length === 0) return null
  const historyDays = Number((db.prepare(`
    SELECT COUNT(DISTINCT date(timestamp, 'localtime')) AS count
    FROM messages
    WHERE date(timestamp, 'localtime') < ? AND date(timestamp, 'localtime') >= date(?, '-7 days')
  `).get(date, date) as { count: number }).count)
  return {
    date,
    historyDays,
    topics: rows.map((row) => ({
      topicId: row.topic_id,
      canonicalName: row.canonical_name,
      aliases: JSON.parse(row.aliases_json) as string[],
      date: row.metric_date,
      messageCount: row.message_count,
      conversationCount: row.conversation_count,
      senderCount: row.sender_count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      historicalAvgMessageCount: row.historical_avg_message_count,
      historicalAvgConversationCount: row.historical_avg_conversation_count,
      historicalAvgSenderCount: row.historical_avg_sender_count,
      growthRate: row.growth_rate,
      noveltyScore: row.novelty_score,
      signalScore: row.signal_score,
      sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
      reasonCodes: JSON.parse(row.reason_codes_json) as TopicRadarItem['reasonCodes'],
      trend: JSON.parse(row.trend_json) as TopicRadarItem['trend']
    }))
  }
}

export function getTopicEvidence(db: DatabaseSync, topicId: string, date: string): TopicEvidence | null {
  const rows = db.prepare(`
    SELECT m.id, m.conversation_id, COALESCE(m.conversation_name, '') AS conversation_name,
           m.sender_id, COALESCE(m.sender_name, '') AS sender_name,
           COALESCE(m.timestamp, '') AS timestamp, m.content
    FROM topic_daily_sources s
    JOIN messages m ON m.id = s.message_id
    WHERE s.topic_id = ? AND s.metric_date = ?
    ORDER BY s.source_order
  `).all(topicId, date) as unknown as EvidenceRow[]
  if (rows.length === 0) return null
  return {
    topicId,
    messages: rows.map((row): EvidenceMessage => ({
      messageId: row.id,
      conversationId: row.conversation_id,
      conversationName: row.conversation_name,
      senderId: row.sender_id,
      senderName: row.sender_name,
      timestamp: row.timestamp,
      content: row.content,
      isSource: true
    }))
  }
}

function saveTopics(db: DatabaseSync, topics: TopicRadarItem[], date: string): void {
  const now = new Date().toISOString()
  const upsertTopic = db.prepare(`
    INSERT INTO topics (id, canonical_name, aliases_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      canonical_name = excluded.canonical_name,
      aliases_json = excluded.aliases_json,
      first_seen_at = MIN(topics.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(topics.last_seen_at, excluded.last_seen_at)
  `)
  const insertMetric = db.prepare(`
    INSERT INTO topic_daily_metrics (
      topic_id, metric_date, message_count, conversation_count, sender_count,
      first_seen_at, last_seen_at, historical_avg_message_count,
      historical_avg_conversation_count, historical_avg_sender_count,
      growth_rate, novelty_score, signal_score, source_message_ids_json,
      reason_codes_json, trend_json, algorithm_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSource = db.prepare(`
    INSERT INTO topic_daily_sources (topic_id, metric_date, message_id, source_order)
    VALUES (?, ?, ?, ?)
  `)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM topic_daily_metrics WHERE metric_date = ?').run(date)
    for (const topic of topics) {
      upsertTopic.run(topic.topicId, topic.canonicalName, JSON.stringify(topic.aliases), topic.firstSeenAt, topic.lastSeenAt)
      insertMetric.run(
        topic.topicId, topic.date, topic.messageCount, topic.conversationCount, topic.senderCount,
        topic.firstSeenAt, topic.lastSeenAt, topic.historicalAvgMessageCount,
        topic.historicalAvgConversationCount, topic.historicalAvgSenderCount,
        topic.growthRate, topic.noveltyScore, topic.signalScore,
        JSON.stringify(topic.sourceMessageIds), JSON.stringify(topic.reasonCodes),
        JSON.stringify(topic.trend), TOPIC_ALGORITHM_VERSION, now
      )
      topic.sourceMessageIds.forEach((messageId, index) => insertSource.run(topic.topicId, topic.date, messageId, index))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function dateRange(date: string, historyDays: number): string[] {
  return Array.from({ length: historyDays + 1 }, (_, index) => {
    const value = new Date(`${date}T12:00:00.000Z`)
    value.setUTCDate(value.getUTCDate() + index - historyDays)
    return value.toISOString().slice(0, 10)
  })
}

interface EvidenceRow {
  id: string
  conversation_id: string
  conversation_name: string
  sender_id: string
  sender_name: string
  timestamp: string
  content: string
}

interface SavedTopicRow {
  topic_id: string
  metric_date: string
  canonical_name: string
  aliases_json: string
  message_count: number
  conversation_count: number
  sender_count: number
  first_seen_at: string
  last_seen_at: string
  historical_avg_message_count: number
  historical_avg_conversation_count: number
  historical_avg_sender_count: number
  growth_rate: number
  novelty_score: number
  signal_score: number
  source_message_ids_json: string
  reason_codes_json: string
  trend_json: string
}
