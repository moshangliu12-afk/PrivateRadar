import type { DatabaseSync } from 'node:sqlite'
import {
  commitmentTextSchema, freezeCommitmentSourcePositions, parseCommitmentSourcePositions,
  type CommitmentExtractorRun
} from './contracts'

/** 仅登记明确传入的来源快照；可参与导入方事务，不执行匹配或派生处理。 */
export function registerCommitmentExtractorRun(
  db: DatabaseSync, batchItemId: string, jobId: string, ruleVersion: string,
  positions: number[], createdAt = new Date().toISOString()
): CommitmentExtractorRun {
  for (const value of [batchItemId, jobId, ruleVersion, createdAt]) commitmentTextSchema.parse(value)
  const positionsJson = JSON.stringify(freezeCommitmentSourcePositions(positions))
  db.prepare(`INSERT INTO commitment_extractor_runs
    (batch_item_id,core_import_job_id,rule_version,source_positions_snapshot_json,created_at)
    VALUES (?,?,?,?,?) ON CONFLICT(batch_item_id,rule_version) DO NOTHING`)
    .run(batchItemId, jobId, ruleVersion, positionsJson, createdAt)
  const stored = getCommitmentExtractorRun(db, batchItemId, ruleVersion)!
  if (stored.core_import_job_id !== jobId || stored.source_positions_snapshot_json !== positionsJson) {
    throw new Error('已有承诺提取运行记录与本次来源快照冲突')
  }
  return stored
}
function validateRun(row: unknown): CommitmentExtractorRun {
  const run = row as CommitmentExtractorRun
  parseCommitmentSourcePositions(run.source_positions_snapshot_json)
  return run
}
export function getCommitmentExtractorRun(
  db: DatabaseSync, batchItemId: string, ruleVersion: string
): CommitmentExtractorRun | null {
  const row = db.prepare('SELECT * FROM commitment_extractor_runs WHERE batch_item_id=? AND rule_version=?')
    .get(batchItemId, ruleVersion)
  return row ? validateRun(row) : null
}
export function listPendingCommitmentExtractorRuns(db: DatabaseSync): CommitmentExtractorRun[] {
  return db.prepare(`SELECT * FROM commitment_extractor_runs WHERE status='pending'
    ORDER BY created_at,batch_item_id,rule_version`).all().map(validateRun)
}

/** 尝试代次是乐观并发屏障；执行状态可以更新，冻结身份与来源集合保持不变。 */
export function markCommitmentAttemptStarted(
  db: DatabaseSync, batchItemId: string, ruleVersion: string, expectedStatus?: 'pending' | 'failed'
): number | null {
  const row = db.prepare(`UPDATE commitment_extractor_runs SET status='pending',attempt_count=attempt_count+1,
    processed_at=NULL,error_summary=NULL WHERE batch_item_id=? AND rule_version=? AND status IN ('pending','failed')
    AND (? IS NULL OR status=?) RETURNING attempt_count`)
    .get(batchItemId, ruleVersion, expectedStatus ?? null, expectedStatus ?? null) as { attempt_count: number } | undefined
  return row?.attempt_count ?? null
}
export function ownsCommitmentAttempt(
  db: DatabaseSync, batchItemId: string, ruleVersion: string, attempt: number
): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM commitment_extractor_runs
    WHERE batch_item_id=? AND rule_version=? AND status='pending' AND attempt_count=? AND attempt_count>0`)
    .get(batchItemId, ruleVersion, attempt))
}
export function markCommitmentComplete(
  db: DatabaseSync, batchItemId: string, ruleVersion: string, attempt: number
): boolean {
  return db.prepare(`UPDATE commitment_extractor_runs SET status='complete',processed_at=?,error_summary=NULL
    WHERE batch_item_id=? AND rule_version=? AND status='pending' AND attempt_count=? AND attempt_count>0`)
    .run(new Date().toISOString(), batchItemId, ruleVersion, attempt).changes === 1
}
const failureSummaries = {
  INVALID_SNAPSHOT: 'INVALID_SNAPSHOT: 冻结来源快照无效',
  UNSUPPORTED_RULE_VERSION: 'UNSUPPORTED_RULE_VERSION: 冻结规则版本不受支持',
  INVALID_FROZEN_SOURCE_POSITION: 'INVALID_FROZEN_SOURCE_POSITION: 冻结来源或正文不完整',
  CANDIDATE_CONFLICT: 'CANDIDATE_CONFLICT: 已有候选项与固定规则结果不一致',
  PROCESSING_FAILED: 'PROCESSING_FAILED: 承诺派生处理失败',
  UNKNOWN: 'UNKNOWN: 承诺派生处理异常'
} as const
export type CommitmentFailureCode = keyof typeof failureSummaries
export function markCommitmentFailed(
  db: DatabaseSync, batchItemId: string, ruleVersion: string, attempt: number, errorCode: unknown
): boolean {
  // 不保存任意异常正文、路径或堆栈，只接受固定诊断类别。
  const code = typeof errorCode === 'string' && Object.hasOwn(failureSummaries, errorCode)
    ? errorCode as CommitmentFailureCode : 'UNKNOWN'
  return db.prepare(`UPDATE commitment_extractor_runs SET status='failed',processed_at=?,error_summary=?
    WHERE batch_item_id=? AND rule_version=? AND status='pending' AND attempt_count=? AND attempt_count>0`)
    .run(new Date().toISOString(), failureSummaries[code], batchItemId, ruleVersion, attempt).changes === 1
}
