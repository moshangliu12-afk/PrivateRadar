import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  commitmentReviewStatusSchema, createCommitmentCandidateSchema,
  type CommitmentCandidate, type CommitmentReviewStatus, type CreateCommitmentCandidateInput
} from './contracts'

export function createCommitmentCandidate(
  db: DatabaseSync, input: CreateCommitmentCandidateInput
): CommitmentCandidate {
  const value = createCommitmentCandidateSchema.parse(input)
  db.prepare(`INSERT INTO commitment_candidates
    (id,batch_item_id,source_position,reason_code,rule_id,rule_version,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(batch_item_id,source_position,rule_version) DO NOTHING`)
    .run(randomUUID(), value.batchItemId, value.sourcePosition, value.reasonCode, value.ruleId,
      value.ruleVersion, new Date().toISOString())
  const stored = db.prepare(`SELECT * FROM commitment_candidates
    WHERE batch_item_id=? AND source_position=? AND rule_version=?`)
    .get(value.batchItemId, value.sourcePosition, value.ruleVersion) as unknown as CommitmentCandidate
  if (stored.reason_code !== value.reasonCode || stored.rule_id !== value.ruleId) {
    throw new Error('已有承诺候选项与本次生成原因快照冲突')
  }
  return stored
}
export function getCommitmentCandidate(db: DatabaseSync, id: string): CommitmentCandidate | null {
  return db.prepare('SELECT * FROM commitment_candidates WHERE id=?').get(id) as unknown as CommitmentCandidate ?? null
}
export function listCandidatesForRun(
  db: DatabaseSync, batchItemId: string, ruleVersion: string
): CommitmentCandidate[] {
  return db.prepare(`SELECT * FROM commitment_candidates WHERE batch_item_id=? AND rule_version=?
    ORDER BY source_position,id`).all(batchItemId, ruleVersion) as unknown as CommitmentCandidate[]
}
/** 确认只表示用户认可原话表达了承诺，不表示履行、接受任务或需要提醒。 */
export function reviewCommitmentCandidate(
  db: DatabaseSync, id: string, status: CommitmentReviewStatus
): CommitmentCandidate {
  commitmentReviewStatusSchema.parse(status)
  db.prepare(`UPDATE commitment_candidates SET status=?,reviewed_at=? WHERE id=? AND status<>?`)
    .run(status, new Date().toISOString(), id, status)
  const stored = getCommitmentCandidate(db, id)
  if (!stored) throw new Error('承诺候选项不存在')
  return stored
}
