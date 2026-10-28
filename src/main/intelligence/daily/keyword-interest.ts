import type { DatabaseSync } from 'node:sqlite'
import type { TodayKeywordInterest, TodayKeywordInterestItem } from '../../../shared/today-keyword-interest'
import type { KeywordHitSource } from '../../../shared/keyword-radar'
import { occurrence, safeKeywordRadarAction, type OccurrenceRow } from '../../keyword-radar/desktop'
import { parseMatchedTermsSnapshot } from '../../keyword-radar/contracts'

interface ActiveHitRow extends OccurrenceRow {
  hit_id: string
  group_id: string
  matched_terms_snapshot: string
  active_term_id: string
  attachment_name: string | null
  ordinal: number
  evidence_source_kind: KeywordHitSource['evidenceKind']
  evidence_status: KeywordHitSource['evidenceStatus']
  evidence_relative_path: string | null
}
function localDate(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/** 只消费已有命中；配置和来源在同一次只读查询中取得，不启动任何派生处理。 */
export function getTodayKeywordInterest(db: DatabaseSync, now = new Date()): TodayKeywordInterest {
  if (!Number.isFinite(now.getTime())) throw new Error('当前系统日期无效')
  const todayDate = localDate(now)
  const rows = db.prepare(`SELECT h.id AS hit_id,h.group_id,h.matched_terms_snapshot,t.id AS active_term_id,
    s.batch_item_id,s.source_position,s.message_id,s.source_sender_name,s.source_timestamp,
    s.source_timestamp_source,s.source_conversation_name,m.content,
    m.conversation_id,conv.name AS current_conversation_name,conv.user_conversation_label,
    i.attachment_name,i.ordinal,i.evidence_source_kind,i.evidence_status,i.evidence_relative_path
    FROM keyword_hits h
    JOIN keyword_groups g ON g.id=h.group_id AND g.enabled=1 AND g.archived_at IS NULL
    JOIN batch_item_message_sources s ON s.batch_item_id=h.batch_item_id AND s.source_position=h.source_position
    LEFT JOIN messages m ON m.id=s.message_id
    LEFT JOIN conversations conv ON conv.id=m.conversation_id
    JOIN batch_import_items i ON i.id=h.batch_item_id
    JOIN json_each(h.matched_terms_snapshot,'$.terms') matched
    JOIN keyword_terms t ON t.id=json_extract(matched.value,'$.term_id') AND t.group_id=h.group_id AND t.enabled=1
    WHERE s.source_timestamp_source IN ('source_native','user_supplied') AND s.source_timestamp IS NOT NULL`)
    .all() as unknown as ActiveHitRow[]
  const snapshots = new Map<string, ReturnType<typeof parseMatchedTermsSnapshot>>()
  const items = new Map<string, TodayKeywordInterestItem>()
  for (const row of rows) {
    const entry = occurrence(row)
    if (!entry.chatTimestamp || localDate(new Date(entry.chatTimestamp)) !== todayDate) continue
    let snapshot = snapshots.get(row.hit_id)
    if (!snapshot) {
      snapshot = parseMatchedTermsSnapshot(row.matched_terms_snapshot)
      snapshots.set(row.hit_id, snapshot)
    }
    const term = snapshot.terms.find(term => term.term_id === row.active_term_id)
    if (!term) continue
    const key = JSON.stringify([entry.batchItemId, entry.sourcePosition])
    let item = items.get(key)
    if (!item) {
      item = { ...entry, chatTimestamp: entry.chatTimestamp, representativeHitId: row.hit_id,
        matchedTerms: [], matches: [], source: {
          batchItemId: row.batch_item_id, attachmentName: row.attachment_name, ordinal: row.ordinal,
          evidenceKind: row.evidence_source_kind, evidenceStatus: row.evidence_status,
          evidenceRecorded: row.evidence_relative_path !== null
        } }
      items.set(key, item)
    }
    item.matches.push({ hitId: row.hit_id, groupId: row.group_id, termId: term.term_id, term: term.term })
    if (compare(row.hit_id, item.representativeHitId) < 0) item.representativeHitId = row.hit_id
  }
  for (const item of items.values()) {
    item.matches.sort((a, b) => compare(a.term, b.term) || compare(a.groupId, b.groupId) ||
      compare(a.termId, b.termId) || compare(a.hitId, b.hitId))
    item.matchedTerms = [...new Set(item.matches.map(match => match.term))]
  }
  // 先按来源 occurrence 聚合，再对整个区块排序、取三条。
  return { todayDate, items: [...items.values()].sort((a, b) =>
    Date.parse(b.chatTimestamp) - Date.parse(a.chatTimestamp) ||
    compare(a.batchItemId, b.batchItemId) || a.sourcePosition - b.sourcePosition).slice(0, 3) }
}

interface IpcRegistrar { handle: (channel: string, listener: (event: unknown) => unknown) => unknown }
export function registerTodayKeywordInterestIpc(ipc: IpcRegistrar, db: DatabaseSync): void {
  ipc.handle('dashboard:keyword-interest', () => safeKeywordRadarAction(() => getTodayKeywordInterest(db)))
}
