import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { ChatQueryResponse, DailyBriefItem, FeedbackState, FeedbackVote } from '../../shared/models'
import { DAILY_VALUE_VERSION } from '../intelligence/daily/daily-value'
import { DAILY_ALGORITHM_VERSION } from '../intelligence/daily/pipeline'

export const SEARCH_FEEDBACK_ALGORITHM_VERSION = 'ask-my-chats-v2'
const EXPORT_FORMAT_VERSION = 'privateradar-feedback-v1'

export interface DailyFeedbackInput {
  item: DailyBriefItem
  vote: Extract<FeedbackVote, 'USEFUL' | 'SHOULD_NOT_SHOW'>
  reasonCode?: string | null
  note?: string | null
  appVersion: string
}

export interface MissingImportantFeedbackInput {
  dateKey: string
  note?: string | null
  appVersion: string
}

export interface SearchFeedbackInput {
  question: string
  response: ChatQueryResponse
  vote: Extract<FeedbackVote, 'CORRECT' | 'INCORRECT'>
  reasonCode?: string | null
  note?: string | null
  appVersion: string
}

interface MessageSnapshot {
  message_id: string
  conversation_id: string
  conversation_name: string | null
  sender_name: string | null
  timestamp: string | null
  content_excerpt: string
}

interface FeedbackRow {
  id: string
  feedback_key: string
  surface: string
  feedback_type: string
  vote: FeedbackVote
  reason_code: string | null
  note: string | null
  target_key: string | null
  date_key: string | null
  query_text: string | null
  source_message_ids_json: string
  context_json: string
  algorithm_version: string
  app_version: string
  created_at: string
  updated_at: string
}

/** 保存或替换同一目标的最新反馈；不会触碰消息、排序或算法配置。 */
export function saveDailyFeedback(db: DatabaseSync, input: DailyFeedbackInput): FeedbackState {
  const item = input.item
  return upsertFeedback(db, {
    feedbackKey: `daily:item:${item.candidateId}`,
    surface: 'daily',
    feedbackType: 'daily_item',
    vote: input.vote,
    reasonCode: input.reasonCode,
    note: input.note,
    targetKey: item.candidateId,
    dateKey: item.date,
    queryText: null,
    sourceMessageIds: item.sourceMessageIds,
    context: {
      candidate_id: item.candidateId,
      title: item.title,
      representative_text: item.representativeText,
      daily_value: item.dailyValue,
      daily_priority: item.dailyPriority,
      d1_importance_score: item.importanceScore,
      d1_reason_codes: item.reasonCodes,
      daily_value_reason_codes: item.valueReasonCodes,
      conversation_ids: item.sourceConversationIds,
      source_messages: messageSnapshots(db, item.sourceMessageIds)
    },
    algorithmVersion: `${DAILY_ALGORITHM_VERSION}|${DAILY_VALUE_VERSION}`,
    appVersion: input.appVersion
  })
}

export function saveMissingImportantFeedback(db: DatabaseSync, input: MissingImportantFeedbackInput): FeedbackState {
  return upsertFeedback(db, {
    feedbackKey: `daily:missing:${input.dateKey}`,
    surface: 'daily',
    feedbackType: 'missing_important',
    vote: 'MISSING_IMPORTANT',
    reasonCode: null,
    note: input.note,
    targetKey: null,
    dateKey: input.dateKey,
    queryText: null,
    sourceMessageIds: [],
    context: { reported_without_message_match: true },
    algorithmVersion: `${DAILY_ALGORITHM_VERSION}|${DAILY_VALUE_VERSION}`,
    appVersion: input.appVersion
  })
}

export function saveSearchFeedback(db: DatabaseSync, input: SearchFeedbackInput): FeedbackState {
  const question = normalizeText(input.question)
  const sourceMessageIds = unique(input.response.sourceMessageIds)
  return upsertFeedback(db, {
    feedbackKey: searchFeedbackKey(question, sourceMessageIds),
    surface: 'search',
    feedbackType: 'search_answer',
    vote: input.vote,
    reasonCode: input.reasonCode,
    note: input.note,
    targetKey: question,
    dateKey: null,
    queryText: question,
    sourceMessageIds,
    context: {
      answer_text: input.response.answer,
      insufficient_evidence: input.response.insufficientEvidence,
      query_intent: input.response.understanding.intent,
      query_expansion: {
        core_topics: input.response.understanding.coreTopics,
        entities: input.response.understanding.entityKeys,
        event_terms: input.response.understanding.eventTerms,
        expanded_terms: input.response.understanding.expandedTerms,
        time_intent: input.response.understanding.timeIntent,
        person_intent: input.response.understanding.personIntent
      },
      result_count: input.response.hitMessageCount,
      top_evidence_ids: sourceMessageIds.slice(0, 8),
      top_evidence_excerpts: messageSnapshots(db, sourceMessageIds.slice(0, 8))
    },
    algorithmVersion: SEARCH_FEEDBACK_ALGORITHM_VERSION,
    appVersion: input.appVersion
  })
}

export function getDailyFeedbackStates(db: DatabaseSync, candidateIds: string[]): Record<string, FeedbackState> {
  if (candidateIds.length === 0) return {}
  const keys = candidateIds.map((id) => `daily:item:${id}`)
  const rows = db.prepare(`
    SELECT id, feedback_key, vote, reason_code, note, updated_at
    FROM user_feedback
    WHERE feedback_key IN (${keys.map(() => '?').join(', ')})
  `).all(...keys) as unknown as Array<Pick<FeedbackRow, 'id' | 'feedback_key' | 'vote' | 'reason_code' | 'note' | 'updated_at'>>
  return Object.fromEntries(rows.map((row) => [row.feedback_key.slice('daily:item:'.length), toState(row)]))
}

export function getSearchFeedbackState(db: DatabaseSync, question: string, sourceMessageIds: string[]): FeedbackState | null {
  const row = db.prepare(`
    SELECT id, feedback_key, vote, reason_code, note, updated_at
    FROM user_feedback WHERE feedback_key = ?
  `).get(searchFeedbackKey(normalizeText(question), unique(sourceMessageIds))) as Pick<FeedbackRow, 'id' | 'feedback_key' | 'vote' | 'reason_code' | 'note' | 'updated_at'> | undefined
  return row ? toState(row) : null
}

/** 仅导出用户主动反馈过的记录及其已有最小上下文，不读取整个聊天库。 */
export function exportFeedback(db: DatabaseSync, destinationPath: string): number {
  const rows = db.prepare(`SELECT * FROM user_feedback ORDER BY created_at, id`).all() as unknown as FeedbackRow[]
  const payload = {
    format: EXPORT_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    feedback: rows.map((row) => ({
      feedback_id: row.id,
      surface: row.surface,
      feedback_type: row.feedback_type,
      vote: row.vote,
      reason_code: row.reason_code,
      optional_note: row.note,
      target_key: row.target_key,
      date_key: row.date_key,
      original_query: row.query_text,
      source_message_ids: parseArray(row.source_message_ids_json),
      context: parseObject(row.context_json),
      algorithm_version: row.algorithm_version,
      app_version: row.app_version,
      created_at: row.created_at,
      updated_at: row.updated_at
    }))
  }
  writeFileSync(destinationPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return rows.length
}

function upsertFeedback(db: DatabaseSync, input: {
  feedbackKey: string
  surface: 'daily' | 'search'
  feedbackType: 'daily_item' | 'missing_important' | 'search_answer'
  vote: FeedbackVote
  reasonCode?: string | null
  note?: string | null
  targetKey: string | null
  dateKey: string | null
  queryText: string | null
  sourceMessageIds: string[]
  context: Record<string, unknown>
  algorithmVersion: string
  appVersion: string
}): FeedbackState {
  const now = new Date().toISOString()
  const note = optionalText(input.note)
  const reasonCode = optionalText(input.reasonCode)
  db.prepare(`
    INSERT INTO user_feedback (
      id, feedback_key, surface, feedback_type, vote, reason_code, note,
      target_key, date_key, query_text, source_message_ids_json, context_json,
      algorithm_version, app_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(feedback_key) DO UPDATE SET
      vote = excluded.vote,
      reason_code = excluded.reason_code,
      note = excluded.note,
      source_message_ids_json = excluded.source_message_ids_json,
      context_json = excluded.context_json,
      algorithm_version = excluded.algorithm_version,
      app_version = excluded.app_version,
      updated_at = excluded.updated_at
  `).run(
    randomUUID(), input.feedbackKey, input.surface, input.feedbackType, input.vote, reasonCode, note,
    input.targetKey, input.dateKey, input.queryText, JSON.stringify(unique(input.sourceMessageIds)), JSON.stringify(input.context),
    input.algorithmVersion, input.appVersion, now, now
  )
  const row = db.prepare(`
    SELECT id, feedback_key, vote, reason_code, note, updated_at
    FROM user_feedback WHERE feedback_key = ?
  `).get(input.feedbackKey) as Pick<FeedbackRow, 'id' | 'feedback_key' | 'vote' | 'reason_code' | 'note' | 'updated_at'>
  return toState(row)
}

function messageSnapshots(db: DatabaseSync, ids: string[]): MessageSnapshot[] {
  const uniqueIds = unique(ids)
  if (uniqueIds.length === 0) return []
  const rows = db.prepare(`
    SELECT id, conversation_id, conversation_name, sender_name, timestamp, content
    FROM messages WHERE id IN (${uniqueIds.map(() => '?').join(', ')})
  `).all(...uniqueIds) as unknown as Array<{
    id: string
    conversation_id: string
    conversation_name: string | null
    sender_name: string | null
    timestamp: string | null
    content: string
  }>
  const byId = new Map(rows.map((row) => [row.id, row]))
  return uniqueIds.flatMap((id) => {
    const row = byId.get(id)
    if (!row) return []
    return [{
      message_id: row.id,
      conversation_id: row.conversation_id,
      conversation_name: row.conversation_name,
      sender_name: row.sender_name,
      timestamp: row.timestamp,
      content_excerpt: row.content.slice(0, 500)
    }]
  })
}

function searchFeedbackKey(question: string, sourceMessageIds: string[]): string {
  const hash = createHash('sha256').update([question, ...sourceMessageIds.slice().sort()].join('\u001f')).digest('hex').slice(0, 24)
  return `search:answer:${hash}`
}

function toState(row: Pick<FeedbackRow, 'id' | 'vote' | 'reason_code' | 'note' | 'updated_at'>): FeedbackState {
  return { feedbackId: row.id, vote: row.vote, reasonCode: row.reason_code, note: row.note, updatedAt: row.updated_at }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim()
  return normalized ? normalized.slice(0, 1000) : null
}

function parseArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
