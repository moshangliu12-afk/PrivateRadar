import { DatabaseSync } from 'node:sqlite'
import { initializeDatabase } from './schema'
import { seedDemoData } from './demo'
import type { DashboardSummary, TopicRadarSummary } from '../shared/models'
import { loadSavedDailyCandidates, runDailyIntelligence } from './intelligence/daily/repository'
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
  const latest = db.prepare(`SELECT MAX(COALESCE(date(NULLIF(timestamp, ''), 'localtime'), date(imported_at, 'localtime'))) AS date FROM messages`).get() as { date: string | null }
  const date = latest.date ?? new Date().toISOString().slice(0, 10)
  if (!forceRecompute) {
    const cached = loadSavedTopicRadar(db, date)
    if (cached) return withTopicDataQuality(db, cached)
  }
  const savedCandidates = loadSavedDailyCandidates(db, date)
  const candidates = savedCandidates.length > 0 ? savedCandidates : runDailyIntelligence(db, date).candidates
  return withTopicDataQuality(db, runTopicRadar(db, date, candidates))
}

function withTopicDataQuality(db: DatabaseSync, summary: TopicRadarSummary): TopicRadarSummary {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM messages
    WHERE source = 'workbuddy' AND (timestamp IS NULL OR timestamp_source = 'unknown')
  `).get() as { count: number }
  return {
    ...summary,
    dataQualityNotice: row.count > 0
      ? '部分聊天缺少原始时间，因此本次趋势仅基于时间完整的数据。'
      : null
  }
}

export async function getDashboardSummary(db: DatabaseSync, databasePath: string, forceRegenerate = false, refreshLocal = false): Promise<DashboardSummary> {
  const latest = db.prepare(`SELECT MAX(COALESCE(date(NULLIF(timestamp, ''), 'localtime'), date(imported_at, 'localtime'))) AS date FROM messages`).get() as { date: string | null }
  const date = latest.date ?? new Date().toISOString().slice(0, 10)
  const stats = db.prepare(`
    SELECT COUNT(*) AS message_count,
           COUNT(DISTINCT CASE WHEN conversation_name_source <> 'unknown' AND conversation_name IS NOT NULL AND conversation_name <> '' THEN conversation_id END) AS conversation_count
    FROM messages
    WHERE date(timestamp, 'localtime') = ?
       OR ((timestamp IS NULL OR timestamp = '') AND date(imported_at, 'localtime') = ?)
  `).get(date, date) as { message_count: number; conversation_count: number }
  const total = db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number }
  const demoSetting = db.prepare(`SELECT value_json FROM app_settings WHERE key = 'demo_mode'`).get() as { value_json: string } | undefined

  const savedCandidates = refreshLocal ? [] : loadSavedDailyCandidates(db, date)
  const candidates = savedCandidates.length > 0 ? savedCandidates : runDailyIntelligence(db, date).candidates
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
