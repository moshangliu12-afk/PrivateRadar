import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { CommitmentCandidateContext, CommitmentCandidateReview, CommitmentCandidateSource,
  CommitmentCandidateView, CommitmentResult } from '../../shared/commitment'
import { occurrence, readItemOccurrenceContext, type OccurrenceRow } from '../keyword-radar/desktop'
import { getCommitmentCandidate, reviewCommitmentCandidate } from './candidates'
import type { CommitmentCandidate } from './contracts'

const idSchema = z.string().uuid()
const messages = {
  INVALID_INPUT: '候选项编号无效，请刷新后重试。',
  CANDIDATE_UNAVAILABLE: '这条承诺候选或它的来源暂不可用，请刷新。',
  EVIDENCE_UNAVAILABLE: '该附件的证据暂不可用，候选项已保留，未打开其他来源。',
  OPERATION_FAILED: '承诺候选操作未完成，请稍后重试。'
} as const
export class CommitmentDesktopError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]) }
}
export async function safeCommitmentAction<T>(action: () => T | Promise<T>): Promise<CommitmentResult<T>> {
  try { return { ok: true, value: await action() } } catch (reason) {
    const code = reason instanceof CommitmentDesktopError ? reason.code : reason instanceof z.ZodError ? 'INVALID_INPUT' : 'OPERATION_FAILED'
    return { ok: false, error: { code, message: messages[code] } }
  }
}
interface CandidateRow extends OccurrenceRow {
  id: string; status: CommitmentCandidate['status']; reviewed_at: string | null
  reason_code: string; rule_id: string; rule_version: string
  attachment_name: string | null; ordinal: number; evidence_source_kind: 'zip' | 'directory'
  evidence_status: CommitmentCandidateSource['evidenceStatus']; evidence_relative_path: string | null
}
const candidateSelect = `SELECT c.id,c.status,c.reviewed_at,c.reason_code,c.rule_id,c.rule_version,
  s.batch_item_id,s.source_position,s.message_id,s.source_sender_name,s.source_timestamp,
  s.source_timestamp_source,s.source_conversation_name,m.content,
  i.attachment_name,i.ordinal,i.evidence_source_kind,i.evidence_status,i.evidence_relative_path
  FROM commitment_candidates c JOIN batch_item_message_sources s
    ON s.batch_item_id=c.batch_item_id AND s.source_position=c.source_position
  LEFT JOIN messages m ON m.id=s.message_id JOIN batch_import_items i ON i.id=s.batch_item_id`
function getCandidateOccurrence(db: DatabaseSync, id: unknown): CandidateRow {
  const row = db.prepare(candidateSelect + ' WHERE c.id=?').get(idSchema.parse(id)) as unknown as CandidateRow | undefined
  if (!row) throw new CommitmentDesktopError('CANDIDATE_UNAVAILABLE')
  return row
}
function sourceView(row: CandidateRow): CommitmentCandidateSource {
  return { batchItemId: row.batch_item_id, attachmentName: row.attachment_name, ordinal: row.ordinal,
    evidenceKind: row.evidence_source_kind, evidenceStatus: row.evidence_status, evidenceRecorded: row.evidence_relative_path !== null }
}
function candidateView(row: CandidateRow): CommitmentCandidateView {
  if (typeof row.content !== 'string') throw new CommitmentDesktopError('CANDIDATE_UNAVAILABLE')
  return { ...occurrence(row), id: row.id, status: row.status, reviewedAt: row.reviewed_at,
    reasonCode: row.reason_code, ruleId: row.rule_id, ruleVersion: row.rule_version, source: sourceView(row) }
}
/** 只查询真实已有候选项；不登记任务、不匹配、不补建历史结果。 */
export function listCommitmentCandidates(db: DatabaseSync): CommitmentCandidateView[] {
  return (db.prepare(candidateSelect + ' ORDER BY c.created_at DESC,c.id DESC').all() as unknown as CandidateRow[]).map(candidateView)
}
function review(db: DatabaseSync, id: unknown, status: 'confirmed' | 'ignored'): CommitmentCandidateReview {
  const candidateId = idSchema.parse(id)
  if (db.isTransaction) throw new CommitmentDesktopError('OPERATION_FAILED')
  if (!getCommitmentCandidate(db, candidateId)) throw new CommitmentDesktopError('CANDIDATE_UNAVAILABLE')
  const candidate = reviewCommitmentCandidate(db, candidateId, status)
  return { id: candidate.id, status: candidate.status, reviewedAt: candidate.reviewed_at }
}
export function confirmCommitmentCandidate(db: DatabaseSync, id: unknown): CommitmentCandidateReview { return review(db, id, 'confirmed') }
export function ignoreCommitmentCandidate(db: DatabaseSync, id: unknown): CommitmentCandidateReview { return review(db, id, 'ignored') }
export function getCommitmentCandidateContext(db: DatabaseSync, id: unknown): CommitmentCandidateContext {
  const row = getCandidateOccurrence(db, id)
  try {
    return { candidateId: row.id, batchItemId: row.batch_item_id,
      entries: readItemOccurrenceContext(db, row.batch_item_id, row.source_position, row.source_conversation_name) }
  } catch { throw new CommitmentDesktopError('CANDIDATE_UNAVAILABLE') }
}
/** 证据适配器只接收候选身份，并从该候选的复合来源关系确定当前附件。 */
export function getCommitmentCandidateSource(db: DatabaseSync, id: unknown): CommitmentCandidateSource {
  return sourceView(getCandidateOccurrence(db, id))
}
interface IpcRegistrar { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => unknown }
export function registerCommitmentCandidateIpc(
  ipc: IpcRegistrar, db: DatabaseSync, openEvidence: (id: unknown) => Promise<{ batchItemId: string; opened: true }>
): void {
  const handle = (name: string, action: (...args: unknown[]) => unknown) =>
    ipc.handle('commitment-candidates:' + name, (_event, ...args) => safeCommitmentAction(() => action(...args)))
  handle('list', () => listCommitmentCandidates(db))
  handle('confirm', id => confirmCommitmentCandidate(db, id))
  handle('ignore', id => ignoreCommitmentCandidate(db, id))
  handle('context', id => getCommitmentCandidateContext(db, id))
  handle('open-evidence', id => { idSchema.parse(id); return openEvidence(id) })
}
