import { reliableTimestampSql } from './time-semantics'
import { DatabaseSync } from 'node:sqlite'
import { initializeDatabase } from './schema'
import { seedDemoData } from './demo'
import type { DashboardSummary, TopicRadarSummary } from '../shared/models'
import { loadDailyCandidateCache, runDailyIntelligence } from './intelligence/daily/repository'
import { buildDailyBrief } from './intelligence/daily/brief'
import { resolveAIProvider } from './ai/config'
import { loadSavedTopicRadar, runTopicRadar } from './intelligence/topics/repository'

export function openDatabase(path: string, seedDemo = false): DatabaseSync {
  const db = new DatabaseSync(path)
  initializeDatabase(db)
  if (seedDemo) seedDemoData(db)
  return db
}

export function getTopicRadarSummary(db: DatabaseSync, forceRecompute = false): TopicRadarSummary {
  const latest = db.prepare(`SELECT MAX(date(timestamp, 'localtime')) AS date FROM messages WHERE ${reliableTimestampSql()}`).get() as { date: string | null }
  const date = latest.date
  if (!date) {
    return withTopicDataQuality(db, {
      date: null, historyDays: 0, historySufficient: false,
      topics: [], newTopics: [], warmingTopics: []
    })
  }
  if (!forceRecompute) {
    const cached = loadSavedTopicRadar(db, date)
    if (cached) return withTopicDataQuality(db, cached)
  }
  const savedCandidates = loadDailyCandidateCache(db, date)
  const candidates = savedCandidates ?? runDailyIntelligence(db, date).candidates
  return withTopicDataQuality(db, runTopicRadar(db, date, candidates))
}

function withTopicDataQuality(db: DatabaseSync, summary: TopicRadarSummary): TopicRadarSummary {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM messages
    WHERE source = 'workbuddy' AND NOT ${reliableTimestampSql()}
  `).get() as { count: number }
  return {
    ...summary,
    dataQualityNotice: row.count > 0
      ? '部分聊天缺少原始时间，因此本次趋势仅基于时间完整的数据。'
      : null
  }
}

export async function getDashboardSummary(
  db: DatabaseSync,
  databasePath: string,
  forceRegenerate = false,
  refreshLocal = false,
  requestedDate?: string
): Promise<DashboardSummary> {
  const latest = db.prepare(`SELECT MAX(date(timestamp, 'localtime')) AS date FROM messages WHERE ${reliableTimestampSql()}`).get() as { date: string | null }
  const date = requestedDate ?? latest.date
  const total = db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }
  const demoSetting = db.prepare(`SELECT value_json FROM app_settings WHERE key = 'demo_mode'`).get() as { value_json: string } | undefined
  if (!date) {
    return {
      demoMode: demoSetting?.value_json === 'true',
      date: null,
      conversationCount: 0, messageCount: 0, candidateCount: 0,
      finalIntelligenceCount: 0, mode: 'rule', modeNotice: null,
      telemetry: null, totalMessageCount: total.count, databasePath, items: []
    }
  }
  const stats = db.prepare(`
    SELECT COUNT(*) AS message_count,
           COUNT(DISTINCT CASE WHEN conversation_name_source <> 'unknown' AND conversation_name IS NOT NULL AND conversation_name <> '' THEN conversation_id END) AS conversation_count
    FROM messages
    WHERE date(timestamp, 'localtime') = ?
      AND ${reliableTimestampSql()}
  `).get(date) as { message_count: number; conversation_count: number }

  const savedCandidates = refreshLocal ? null : loadDailyCandidateCache(db, date)
  const candidates = savedCandidates ?? runDailyIntelligence(db, date).candidates
  const brief = await buildDailyBrief(db, date, candidates, resolveAIProvider(), forceRegenerate)

  return {
    demoMode: demoSetting?.value_json === 'true',
    date,
    conversationCount: stats.conversation_count,
    messageCount: stats.message_count,
    candidateCount: candidates.length,
    finalIntelligenceCount: brief.items.length,
    mode: brief.mode,
    modeNotice: brief.notice,
    telemetry: brief.telemetry,
    totalMessageCount: total.count,
    databasePath,
    items: brief.items
  }
}

export function validateDashboardDateKey(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('日期必须为 YYYY-MM-DD')
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('日期必须为 YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, 12, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('日期无效')
  }
  return value
}
