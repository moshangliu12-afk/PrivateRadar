import { createHash } from 'node:crypto'
import { isReliableTimestampSource, reliableTimestampSql } from '../../time-semantics'
import type { DatabaseSync } from 'node:sqlite'
import { conversationNameProjector } from '../../conversation-labels'
import type { CandidateEvidence, DailyCandidate, EvidenceMessage } from '../../../shared/models'
import { assessDailyValue } from './daily-value'
import { buildDailyCandidates, DAILY_ALGORITHM_VERSION } from './pipeline'
import type { DailyMessage, DailyPipelineResult } from './types'

const HISTORY_LOOKBACK_DAYS = 7
const HISTORY_LIMIT = 20_000

export function runDailyIntelligence(db: DatabaseSync, date: string): DailyPipelineResult {
  // 显式刷新也必须先失效依赖旧时间语义的 AI 缓存。
  loadDailyCandidateCache(db, date)
  const today = loadMessagesForDate(db, date)
  const history = loadHistoricalMessages(db, date)
  const result = buildDailyCandidates(today, date, history)
  saveCandidates(db, result.candidates, date)
  return result
}

export function loadSavedDailyCandidates(db: DatabaseSync, date: string): DailyCandidate[] {
  return loadDailyCandidateCache(db, date) ?? []
}

/** null 表示未命中，空数组表示已计算且无候选。 */
export function loadDailyCandidateCache(db: DatabaseSync, date: string): DailyCandidate[] | null {
  const rows = db.prepare(`
    SELECT id, candidate_date, title, representative_text, importance_score,
           source_message_ids_json, source_conversation_ids_json, source_sender_ids_json,
           message_count, conversation_count, first_seen_at, last_seen_at, reason_codes_json
    FROM daily_intelligence_candidates
    WHERE candidate_date = ? AND algorithm_version = ?
    ORDER BY importance_score DESC, first_seen_at, id
  `).all(date, DAILY_ALGORITHM_VERSION) as unknown as SavedCandidateRow[]
  if (rows.length === 0) {
    const marker = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(emptyCacheKey(date)) as { value_json: string } | undefined
    return marker?.value_json === emptyInputSignature(db, date) ? [] : null
  }
  let candidates: DailyCandidate[]
  try {
    candidates = rows.map(toDailyCandidate)
  } catch {
    invalidateDailyDerivedCache(db, date)
    return null
  }
  for (const candidate of candidates) {
    if (!Array.isArray(candidate.sourceMessageIds) || candidate.sourceMessageIds.some((id) => typeof id !== 'string')) {
      invalidateDailyDerivedCache(db, date)
      return null
    }
    const linked = db.prepare('SELECT message_id FROM daily_candidate_sources WHERE candidate_id = ?')
      .all(candidate.candidateId) as Array<{ message_id: string }>
    const ids = [...new Set([...candidate.sourceMessageIds, ...linked.map((row) => row.message_id)])]
    if (candidate.sourceMessageIds.length === 0 || ids.length === 0 ||
        !sourcesBelongToDate(db, ids, date)) {
      // 只失效该日派生结果；候选由现有重建事务整体替换。
      invalidateDailyDerivedCache(db, date)
      return null
    }
  }
  return candidates
}

function invalidateDailyDerivedCache(db: DatabaseSync, date: string): void {
  db.prepare('DELETE FROM daily_ai_briefs WHERE brief_date = ?').run(date)
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(emptyCacheKey(date))
}

function sourcesBelongToDate(db: DatabaseSync, ids: string[], date: string): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM messages
    WHERE id IN (SELECT value FROM json_each(?))
      AND ${reliableTimestampSql()} AND date(timestamp, 'localtime') = ?
  `).get(JSON.stringify(ids), date) as { count: number }
  return row.count === ids.length
}

function emptyCacheKey(date: string): string {
  return `daily-empty-cache:${DAILY_ALGORITHM_VERSION}:${date}`
}

function emptyInputSignature(db: DatabaseSync, date: string): string {
  const rows = db.prepare(`
    SELECT id, timestamp, timestamp_source, content FROM messages
    WHERE ${reliableTimestampSql()} AND date(timestamp, 'localtime') = ? ORDER BY id
  `).all(date)
  return JSON.stringify(createHash('sha256').update(JSON.stringify(rows)).digest('hex'))
}

function toDailyCandidate(row: SavedCandidateRow): DailyCandidate {
  return {
    candidateId: row.id,
    date: row.candidate_date,
    title: row.title,
    representativeText: row.representative_text,
    importanceScore: row.importance_score,
    sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
    sourceConversationIds: JSON.parse(row.source_conversation_ids_json) as string[],
    sourceSenderIds: JSON.parse(row.source_sender_ids_json) as string[],
    messageCount: row.message_count,
    conversationCount: row.conversation_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    reasonCodes: JSON.parse(row.reason_codes_json) as DailyCandidate['reasonCodes']
  }
}

export function loadMessagesForDate(db: DatabaseSync, date: string): DailyMessage[] {
  const rows = db.prepare(`
    SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
           sender_id, COALESCE(sender_name, '') AS sender_name,
           COALESCE(timestamp, '') AS timestamp, content, message_type, links_json, reply_to,
           conversation_name_source, sender_name_source, timestamp_source
    FROM messages
    WHERE date(timestamp, 'localtime') = ?
      AND ${reliableTimestampSql()}
    ORDER BY timestamp, id
  `).all(date) as unknown as MessageRow[]
  return rows.map(toDailyMessage)
}

export function getCandidateEvidence(db: DatabaseSync, candidateId: string, radius = 2): CandidateEvidence | null {
  const row = db.prepare(`
    SELECT id, candidate_date, title, representative_text, importance_score,
           source_message_ids_json, source_conversation_ids_json, source_sender_ids_json,
           message_count, conversation_count, first_seen_at, last_seen_at, reason_codes_json
    FROM daily_intelligence_candidates WHERE id = ?
  `).get(candidateId) as SavedCandidateRow | undefined
  if (!row) return null
  const candidate = toDailyCandidate(row)
  const assessment = assessDailyValue(candidate)
  const sourceRows = db.prepare(`
    SELECT message_id FROM daily_candidate_sources
    WHERE candidate_id = ? ORDER BY source_order
  `).all(candidateId) as Array<{ message_id: string }>
  const sourceIds = new Set(sourceRows.map((row) => row.message_id))
  const groups: CandidateEvidence['groups'] = []
  const projectName = conversationNameProjector(db)

  for (const sourceRow of sourceRows) {
    const source = loadMessageById(db, sourceRow.message_id)
    if (!source) continue
    const before = db.prepare(`
      SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
             sender_id, COALESCE(sender_name, '') AS sender_name, COALESCE(timestamp, '') AS timestamp, content
      FROM messages
      WHERE conversation_id = ? AND (timestamp < ? OR (timestamp = ? AND id < ?))
      ORDER BY timestamp DESC, id DESC LIMIT ?
    `).all(source.conversation_id, source.timestamp, source.timestamp, source.id, radius) as unknown as EvidenceRow[]
    const after = db.prepare(`
      SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
             sender_id, COALESCE(sender_name, '') AS sender_name, COALESCE(timestamp, '') AS timestamp, content
      FROM messages
      WHERE conversation_id = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))
      ORDER BY timestamp, id LIMIT ?
    `).all(source.conversation_id, source.timestamp, source.timestamp, source.id, radius) as unknown as EvidenceRow[]
    const messages = [
      ...before.reverse().map((row) => evidenceMessage(row, sourceIds)),
      evidenceMessage(source, sourceIds),
      ...after.map((row) => evidenceMessage(row, sourceIds))
    ]
    groups.push({ sourceMessageId: source.id, messages })
  }
  return {
    candidateId,
    judgment: {
      dailyValue: assessment.dailyValue,
      dailyPriority: assessment.dailyPriority,
      valueReasonCodes: assessment.valueReasonCodes,
      whyItMatters: assessment.whyItMatters,
      informationSignalScore: candidate.importanceScore,
      informationSignals: candidate.reasonCodes
    },
    groups: groups.map(group => ({ ...group, messages: group.messages.map(projectName) }))
  }
}

function loadHistoricalMessages(db: DatabaseSync, date: string): DailyMessage[] {
  const rows = db.prepare(`
    SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
           sender_id, COALESCE(sender_name, '') AS sender_name,
           COALESCE(timestamp, '') AS timestamp, content, message_type, links_json, reply_to,
           conversation_name_source, sender_name_source, timestamp_source
    FROM messages
    WHERE ${reliableTimestampSql()} AND date(timestamp, 'localtime') < ?
      AND date(timestamp, 'localtime') >= date(?, ?)
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(date, date, `-${HISTORY_LOOKBACK_DAYS} days`, HISTORY_LIMIT) as unknown as MessageRow[]
  return rows.map(toDailyMessage)
}

function saveCandidates(db: DatabaseSync, candidates: DailyCandidate[], date: string): void {
  const insertCandidate = db.prepare(`
    INSERT INTO daily_intelligence_candidates (
      id, candidate_date, title, representative_text, importance_score,
      source_message_ids_json, source_conversation_ids_json, source_sender_ids_json,
      message_count, conversation_count, first_seen_at, last_seen_at,
      reason_codes_json, algorithm_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSource = db.prepare(`
    INSERT INTO daily_candidate_sources (candidate_id, message_id, source_order)
    VALUES (?, ?, ?)
  `)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM daily_intelligence_candidates WHERE candidate_date = ? AND algorithm_version = ?').run(date, DAILY_ALGORITHM_VERSION)
    const createdAt = new Date().toISOString()
    for (const candidate of candidates) {
      insertCandidate.run(
        candidate.candidateId,
        candidate.date,
        candidate.title,
        candidate.representativeText,
        candidate.importanceScore,
        JSON.stringify(candidate.sourceMessageIds),
        JSON.stringify(candidate.sourceConversationIds),
        JSON.stringify(candidate.sourceSenderIds),
        candidate.messageCount,
        candidate.conversationCount,
        candidate.firstSeenAt,
        candidate.lastSeenAt,
        JSON.stringify(candidate.reasonCodes),
        DAILY_ALGORITHM_VERSION,
        createdAt
      )
      candidate.sourceMessageIds.forEach((messageId, index) => insertSource.run(candidate.candidateId, messageId, index))
    }
    if (candidates.length === 0) {
      db.prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(emptyCacheKey(date), emptyInputSignature(db, date), createdAt)
    } else {
      db.prepare('DELETE FROM app_settings WHERE key = ?').run(emptyCacheKey(date))
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

interface MessageRow {
  id: string
  conversation_id: string
  conversation_name: string
  sender_id: string
  sender_name: string
  timestamp: string
  content: string
  message_type: string
  links_json: string
  reply_to: string | null
  conversation_name_source: string
  sender_name_source: string
  timestamp_source: string
}

interface SavedCandidateRow {
  id: string
  candidate_date: string
  title: string
  representative_text: string
  importance_score: number
  source_message_ids_json: string
  source_conversation_ids_json: string
  source_sender_ids_json: string
  message_count: number
  conversation_count: number
  first_seen_at: string
  last_seen_at: string
  reason_codes_json: string
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

function toDailyMessage(row: MessageRow): DailyMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    conversationName: row.conversation_name,
    conversationKnown: row.conversation_name_source !== 'unknown' && Boolean(row.conversation_name),
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderKnown: ['source_native', 'user_supplied'].includes(row.sender_name_source) && Boolean(row.sender_name),
    timestamp: row.timestamp,
    timestampKnown: isReliableTimestampSource(row.timestamp_source) && Boolean(row.timestamp),
    content: row.content,
    messageType: row.message_type,
    links: safeStringArray(row.links_json),
    replyTo: row.reply_to
  }
}

function loadMessageById(db: DatabaseSync, id: string): EvidenceRow | null {
  return (db.prepare(`
    SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
           sender_id, COALESCE(sender_name, '') AS sender_name, COALESCE(timestamp, '') AS timestamp, content
    FROM messages WHERE id = ?
  `).get(id) as EvidenceRow | undefined) ?? null
}

function evidenceMessage(row: EvidenceRow, sourceIds: Set<string>): EvidenceMessage {
  return {
    messageId: row.id,
    conversationId: row.conversation_id,
    conversationName: row.conversation_name,
    senderId: row.sender_id,
    senderName: row.sender_name,
    timestamp: row.timestamp,
    content: row.content,
    isSource: sourceIds.has(row.id)
  }
}

function safeStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
