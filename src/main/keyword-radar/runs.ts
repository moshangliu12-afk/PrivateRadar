import type { DatabaseSync } from 'node:sqlite'
import { freezeKeywordRules } from './config'
import { parseRulesSnapshot, parseSourcePositionsSnapshot, sourcePositionsSnapshotSchema } from './contracts'

export interface KeywordRadarRun {
  batch_item_id: string; core_import_job_id: string; status: 'pending' | 'complete' | 'failed'
  rules_snapshot_json: string; source_positions_snapshot_json: string; created_at: string
  processed_at: string | null; error_summary: string | null; attempt_count: number
}
/** 仅登记当前事务真实新增的来源；不执行匹配、不扫描正文、不自动完成。 */
export function registerKeywordRadarRun(
  db: DatabaseSync, batchItemId: string, jobId: string, positions: number[], createdAt: string
): void {
  if (!db.isTransaction) throw new Error('KEYWORD_RUN_TRANSACTION_REQUIRED')
  if (positions.length === 0) return
  const sourcePositions = sourcePositionsSnapshotSchema.parse([...positions].sort((a, b) => a - b))
  const rules = freezeKeywordRules(db)
  const rulesJson = JSON.stringify(rules), positionsJson = JSON.stringify(sourcePositions)
  // 序列化结果也验证，任何异常都由调用方的核心事务回滚。
  parseRulesSnapshot(rulesJson)
  parseSourcePositionsSnapshot(positionsJson)
  const job = db.prepare('SELECT batch_item_id FROM import_jobs WHERE id=?').get(jobId)
  if (job?.batch_item_id !== batchItemId) throw new Error('KEYWORD_RUN_JOB_CONFLICT')
  db.prepare(`INSERT INTO keyword_radar_runs
    (batch_item_id,core_import_job_id,status,rules_snapshot_json,source_positions_snapshot_json,created_at)
    VALUES (?,?,'pending',?,?,?)`).run(batchItemId, jobId, rulesJson, positionsJson, createdAt)
}
function validateRun(row: unknown): KeywordRadarRun {
  const run = row as KeywordRadarRun
  parseRulesSnapshot(run.rules_snapshot_json)
  parseSourcePositionsSnapshot(run.source_positions_snapshot_json)
  return run
}
export function getKeywordRadarRun(db: DatabaseSync, batchItemId: string): KeywordRadarRun | null {
  const row = db.prepare('SELECT * FROM keyword_radar_runs WHERE batch_item_id=?').get(batchItemId)
  return row ? validateRun(row) : null
}
function listRuns(db: DatabaseSync, status: 'pending' | 'failed'): KeywordRadarRun[] {
  return db.prepare('SELECT * FROM keyword_radar_runs WHERE status=? ORDER BY created_at,batch_item_id').all(status).map(validateRun)
}
export function listPendingKeywordRadarRuns(db: DatabaseSync): KeywordRadarRun[] { return listRuns(db, 'pending') }
export function listFailedKeywordRadarRuns(db: DatabaseSync): KeywordRadarRun[] { return listRuns(db, 'failed') }
/** 代次就是乐观并发屏障；重试仅改执行状态，不重冻规则或来源集合。 */
export function markKeywordRadarAttemptStarted(db: DatabaseSync, batchItemId: string): number | null {
  const row = db.prepare(`UPDATE keyword_radar_runs SET status='pending',attempt_count=attempt_count+1,
    processed_at=NULL,error_summary=NULL WHERE batch_item_id=? AND status IN ('pending','failed')
    RETURNING attempt_count`).get(batchItemId) as { attempt_count: number } | undefined
  return row?.attempt_count ?? null
}
export function markKeywordRadarComplete(db: DatabaseSync, batchItemId: string, attempt: number): boolean {
  return db.prepare(`UPDATE keyword_radar_runs SET status='complete',processed_at=?,error_summary=NULL
    WHERE batch_item_id=? AND status='pending' AND attempt_count=? AND attempt_count>0`)
    .run(new Date().toISOString(), batchItemId, attempt).changes === 1
}
const errorSummaries = {
  INVALID_SNAPSHOT: 'INVALID_SNAPSHOT: 冻结快照无效',
  PROCESSING_FAILED: 'PROCESSING_FAILED: 派生处理失败',
  UNKNOWN: 'UNKNOWN: 派生处理异常'
} as const
export function markKeywordRadarFailed(db: DatabaseSync, batchItemId: string, attempt: number, errorCode: unknown): boolean {
  // 不接受任意异常正文、路径或堆栈，只持久化受控短码与固定描述。
  const code = typeof errorCode === 'string' && Object.hasOwn(errorSummaries, errorCode)
    ? errorCode as keyof typeof errorSummaries : 'UNKNOWN'
  return db.prepare(`UPDATE keyword_radar_runs SET status='failed',processed_at=?,error_summary=?
    WHERE batch_item_id=? AND status='pending' AND attempt_count=? AND attempt_count>0`)
    .run(new Date().toISOString(), errorSummaries[code], batchItemId, attempt).changes === 1
}
