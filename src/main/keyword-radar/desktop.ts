import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { KeywordGroupView, KeywordHitContext, KeywordHitSource, KeywordHitView, KeywordOccurrenceView,
  KeywordRadarResult, KeywordRadarStatus, KeywordRetryResult } from '../../shared/keyword-radar'
import { createKeywordGroup, renameKeywordGroup, setKeywordGroupEnabled, archiveKeywordGroup,
  addKeywordTerm, setKeywordTermEnabled } from './config'
import { normalizeKeywordTermV1 } from './normalization'
import { parseMatchedTermsSnapshot } from './contracts'
import { retryKeywordRadarRun, logKeywordRadarFailure } from './processor'
import { isReliableTimestampSource } from '../time-semantics'

const idSchema = z.string().uuid()
const nameSchema = z.string().trim().min(1).max(200)
const termSchema = z.string().trim().min(1).max(200)
const enabledSchema = z.boolean()
const limitSchema = z.number().int().min(1).max(100).default(100)
const messages = {
  INVALID_INPUT: '输入无效，请检查名称、关键词或编号。',
  CONFIG_UNAVAILABLE: '关键词组或关键词不存在，或已归档。',
  HIT_UNAVAILABLE: '这条命中或它的来源已不可用，请刷新。',
  EVIDENCE_UNAVAILABLE: '该附件的证据暂不可用，未打开其他来源。',
  OPERATION_FAILED: '关键词雷达操作未完成，请稍后重试。'
} as const
export class KeywordRadarDesktopError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]) }
}
export async function safeKeywordRadarAction<T>(action: () => T | Promise<T>): Promise<KeywordRadarResult<T>> {
  try { return { ok: true, value: await action() } } catch (reason) {
    const code = reason instanceof KeywordRadarDesktopError ? reason.code : reason instanceof z.ZodError ? 'INVALID_INPUT' :
      reason instanceof Error && reason.message.startsWith('KEYWORD_CONFIG_NOT_FOUND:') ? 'CONFIG_UNAVAILABLE' : 'OPERATION_FAILED'
    return { ok: false, error: { code, message: messages[code] } }
  }
}
export function listDesktopKeywordGroups(db: DatabaseSync): KeywordGroupView[] {
  const rows = db.prepare(`SELECT g.id,g.name,g.enabled,g.archived_at,
    t.id AS term_id,t.term,t.enabled AS term_enabled FROM keyword_groups g
    LEFT JOIN keyword_terms t ON t.group_id=g.id ORDER BY g.created_at,g.id,t.created_at,t.id`).all()
  const groups: KeywordGroupView[] = []
  for (const row of rows) {
    let group = groups.at(-1)
    if (group?.id !== row.id) {
      group = { id: String(row.id), name: String(row.name), enabled: Boolean(row.enabled),
        archivedAt: row.archived_at as string | null, terms: [] }
      groups.push(group)
    }
    if (row.term_id !== null) group.terms.push({ id: String(row.term_id), term: String(row.term), enabled: Boolean(row.term_enabled) })
  }
  return groups
}
export function addDesktopKeywordTerm(db: DatabaseSync, groupId: unknown, value: unknown) {
  const id = idSchema.parse(groupId), term = termSchema.parse(value), normalized = normalizeKeywordTermV1(term)
  if (db.isTransaction) throw new KeywordRadarDesktopError('OPERATION_FAILED')
  db.exec('BEGIN IMMEDIATE')
  try {
    const group = db.prepare('SELECT archived_at FROM keyword_groups WHERE id=?').get(id)
    if (!group || group.archived_at !== null) throw new KeywordRadarDesktopError('CONFIG_UNAVAILABLE')
    const old = db.prepare('SELECT id,enabled FROM keyword_terms WHERE group_id=? AND normalized_term=?').get(id, normalized)
    let result: { id: string; outcome: 'created' | 'exists' | 'reenabled' }
    if (old) {
      if (!old.enabled) setKeywordTermEnabled(db, String(old.id), true)
      result = { id: String(old.id), outcome: old.enabled ? 'exists' : 'reenabled' }
    } else result = { id: addKeywordTerm(db, id, term).id, outcome: 'created' }
    db.exec('COMMIT')
    return result
  } catch (reason) { db.exec('ROLLBACK'); throw reason }
}
interface OccurrenceRow {
  batch_item_id: string; source_position: number; message_id: string; content: string | null
  source_sender_name: string | null; source_timestamp: string | null; source_timestamp_source: string | null
  source_conversation_name: string | null
}
function chatTime(value: string | null, source: string | null): string | null {
  if (!value || !source || !isReliableTimestampSource(source)) return null
  // 只验证当前来源时间；无效日期和非可靠来源绝不回退到 canonical 或发现时间。
  const date = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(value)?.[1]
  const time = Date.parse(value)
  if (!date || !Number.isFinite(time)) return null
  const day = new Date(date + 'T00:00:00Z')
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) return null
  return new Date(time).toISOString()
}
function occurrence(row: OccurrenceRow): KeywordOccurrenceView {
  if (typeof row.content !== 'string') throw new KeywordRadarDesktopError('HIT_UNAVAILABLE')
  return { batchItemId: row.batch_item_id, sourcePosition: row.source_position, messageId: row.message_id, body: row.content,
    senderName: row.source_sender_name?.trim() ? row.source_sender_name : null,
    chatTimestamp: chatTime(row.source_timestamp, row.source_timestamp_source), timestampSource: row.source_timestamp_source,
    conversationName: row.source_conversation_name?.trim() ? row.source_conversation_name : null }
}
interface HitRow extends OccurrenceRow {
  id: string; group_id: string; group_name_snapshot: string; matched_terms_snapshot: string; matched_at: string
  attachment_name: string | null; ordinal: number; evidence_source_kind: 'zip' | 'directory'
  evidence_status: KeywordHitSource['evidenceStatus']; evidence_relative_path: string | null
}
const hitSelect = `SELECT h.id,h.group_id,h.group_name_snapshot,h.matched_terms_snapshot,h.matched_at,
  s.batch_item_id,s.source_position,s.message_id,s.source_sender_name,s.source_timestamp,
  s.source_timestamp_source,s.source_conversation_name,m.content,
  i.attachment_name,i.ordinal,i.evidence_source_kind,i.evidence_status,i.evidence_relative_path
  FROM keyword_hits h JOIN batch_item_message_sources s
    ON s.batch_item_id=h.batch_item_id AND s.source_position=h.source_position
  LEFT JOIN messages m ON m.id=s.message_id JOIN batch_import_items i ON i.id=h.batch_item_id`
function sourceView(row: HitRow): KeywordHitSource {
  return { batchItemId: row.batch_item_id, attachmentName: row.attachment_name, ordinal: row.ordinal,
    evidenceKind: row.evidence_source_kind, evidenceStatus: row.evidence_status, evidenceRecorded: row.evidence_relative_path !== null }
}
function getHit(db: DatabaseSync, id: unknown): HitRow {
  const row = db.prepare(hitSelect + ' WHERE h.id=?').get(idSchema.parse(id)) as unknown as HitRow | undefined
  if (!row) throw new KeywordRadarDesktopError('HIT_UNAVAILABLE')
  return row
}
export function listRecentKeywordHits(db: DatabaseSync, limit?: unknown): KeywordHitView[] {
  return (db.prepare(hitSelect + ' ORDER BY h.matched_at DESC,h.id DESC LIMIT ?').all(limitSchema.parse(limit)) as unknown as HitRow[])
    .map(row => ({ ...occurrence(row), id: row.id, groupId: row.group_id, groupName: row.group_name_snapshot,
      matchedTerms: parseMatchedTermsSnapshot(row.matched_terms_snapshot).terms.map(term => term.term),
      matchedAt: row.matched_at, source: sourceView(row) }))
}
export function getKeywordRadarStatus(db: DatabaseSync): KeywordRadarStatus {
  const result: KeywordRadarStatus = { pending: 0, failed: 0 }
  for (const row of db.prepare("SELECT status,count(*) AS n FROM keyword_radar_runs WHERE status IN ('pending','failed') GROUP BY status").all()) {
    result[row.status as keyof KeywordRadarStatus] = Number(row.n)
  }
  return result
}
export function getKeywordHitSource(db: DatabaseSync, hitId: unknown): KeywordHitSource { return sourceView(getHit(db, hitId)) }
export function getKeywordHitContext(db: DatabaseSync, hitId: unknown): KeywordHitContext {
  const hit = getHit(db, hitId)
  const rows = db.prepare(`SELECT s.*,m.content FROM batch_item_message_sources s
    LEFT JOIN messages m ON m.id=s.message_id WHERE s.batch_item_id=? ORDER BY s.source_position`)
    .all(hit.batch_item_id) as unknown as OccurrenceRow[]
  const index = rows.findIndex(row => row.source_position === hit.source_position)
  if (index < 0) throw new KeywordRadarDesktopError('HIT_UNAVAILABLE')
  return { hitId: hit.id, batchItemId: hit.batch_item_id, entries: rows.slice(Math.max(0, index - 2), index + 3)
    .map(row => ({ ...occurrence(row), isCurrent: row.source_position === hit.source_position })) }
}
export async function retryFailedDesktopKeywordRuns(db: DatabaseSync): Promise<KeywordRetryResult> {
  const ids = db.prepare("SELECT batch_item_id FROM keyword_radar_runs WHERE status='failed' ORDER BY created_at,batch_item_id").all()
  let completed = 0
  for (const row of ids) {
    await new Promise<void>(resolve => setImmediate(resolve))
    try {
      const result = retryKeywordRadarRun(db, String(row.batch_item_id))
      if (result.status === 'complete' || result.status === 'already_complete') completed++
    } catch { logKeywordRadarFailure('RECOVERY_FAILED') }
  }
  return { attempted: ids.length, completed, status: getKeywordRadarStatus(db) }
}
interface IpcRegistrar { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => unknown }
export function registerKeywordRadarIpc(
  ipc: IpcRegistrar, db: DatabaseSync, openEvidence: (hitId: unknown) => Promise<{ batchItemId: string; opened: true }>
): void {
  const handle = (name: string, action: (...args: unknown[]) => unknown) =>
    ipc.handle('keyword-radar:' + name, (_event, ...args) => safeKeywordRadarAction(() => action(...args)))
  handle('groups', () => listDesktopKeywordGroups(db))
  handle('create-group', name => createKeywordGroup(db, nameSchema.parse(name)).id)
  handle('rename-group', (id, name) => { renameKeywordGroup(db, idSchema.parse(id), nameSchema.parse(name)); return null })
  handle('group-enabled', (id, enabled) => { setKeywordGroupEnabled(db, idSchema.parse(id), enabledSchema.parse(enabled)); return null })
  handle('archive-group', id => { archiveKeywordGroup(db, idSchema.parse(id)); return null })
  handle('add-term', (id, term) => addDesktopKeywordTerm(db, id, term))
  handle('term-enabled', (id, enabled) => { setKeywordTermEnabled(db, idSchema.parse(id), enabledSchema.parse(enabled)); return null })
  handle('hits', limit => listRecentKeywordHits(db, limit))
  handle('status', () => getKeywordRadarStatus(db))
  handle('retry-failed', () => retryFailedDesktopKeywordRuns(db))
  handle('context', id => getKeywordHitContext(db, id))
  handle('source', id => getKeywordHitSource(db, id))
  handle('open-evidence', id => { idSchema.parse(id); return openEvidence(id) })
}
