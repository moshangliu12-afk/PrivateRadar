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
