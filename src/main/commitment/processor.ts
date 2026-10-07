import type { DatabaseSync } from 'node:sqlite'
import { parseCommitmentSourcePositions, type CommitmentExtractorRun } from './contracts'
import { createCommitmentCandidate } from './candidates'
import { COMMITMENT_RULE_VERSION, matchCommitmentBody } from './matcher'
import { markCommitmentAttemptStarted, markCommitmentComplete, markCommitmentFailed,
  ownsCommitmentAttempt, type CommitmentFailureCode } from './runs'

export interface CommitmentProcessingResult {
  batchItemId: string
  ruleVersion: string
  status: 'complete' | 'already_complete' | 'failed' | 'pending' | 'retry_required' | 'not_failed' | 'not_found' | 'stale_attempt'
  attempt?: number
  candidateCount?: number
}
export function logCommitmentFailure(code: 'PROCESSING_UNAVAILABLE' | 'FAILURE_PERSISTENCE_FAILED' | 'RECOVERY_FAILED'): void {
  console.warn(`[承诺提取] ${code}`)
}
function processRun(db: DatabaseSync, batchItemId: string, ruleVersion: string, retry: boolean): CommitmentProcessingResult {
  const result = (status: CommitmentProcessingResult['status'], extra: Pick<CommitmentProcessingResult, 'attempt' | 'candidateCount'> = {}): CommitmentProcessingResult =>
    ({ batchItemId, ruleVersion, status, ...extra })
  // 核心导入事务内绝不处理，也不占用调用方的事务或退出中的连接。
  if (!db.isOpen || db.isTransaction) return result('pending')
  let attempt: number | null = null
  let transaction = false
  let code: CommitmentFailureCode = 'INVALID_SNAPSHOT'
  try {
    const run = db.prepare('SELECT * FROM commitment_extractor_runs WHERE batch_item_id=? AND rule_version=?')
      .get(batchItemId, ruleVersion) as unknown as CommitmentExtractorRun | undefined
    if (!run) return result('not_found')
    if (run.status === 'complete') return result('already_complete')
    if (run.status === 'failed' && !retry) return result('retry_required')
    if (run.status !== 'failed' && retry) return result('not_failed')
    attempt = markCommitmentAttemptStarted(db, batchItemId, ruleVersion, retry ? 'failed' : 'pending')
    if (attempt === null) return result('stale_attempt')
    const positions = parseCommitmentSourcePositions(run.source_positions_snapshot_json)
    code = 'UNSUPPORTED_RULE_VERSION'
    if (run.rule_version !== COMMITMENT_RULE_VERSION) throw new Error('冻结规则版本不受支持')
    code = 'PROCESSING_FAILED'
    db.exec('BEGIN IMMEDIATE')
    transaction = true
    if (!ownsCommitmentAttempt(db, batchItemId, ruleVersion, attempt)) {
      db.exec('ROLLBACK'); transaction = false
      return result('stale_attempt', { attempt })
    }
    const source = db.prepare(`SELECT m.content FROM batch_item_message_sources s
      LEFT JOIN messages m ON m.id=s.message_id WHERE s.batch_item_id=? AND s.source_position=?`)
    const existing = db.prepare(`SELECT rule_id,reason_code FROM commitment_candidates
      WHERE batch_item_id=? AND source_position=? AND rule_version=?`)
    let candidateCount = 0
    for (const position of positions) {
      code = 'INVALID_FROZEN_SOURCE_POSITION'
      const occurrence = source.get(batchItemId, position)
      if (!occurrence || typeof occurrence.content !== 'string') throw new Error('冻结来源正文缺失')
      code = 'PROCESSING_FAILED'
      const match = matchCommitmentBody(occurrence.content)
      const stored = existing.get(batchItemId, position, ruleVersion)
      if (stored && (!match || stored.rule_id !== match.rule_id || stored.reason_code !== match.reason_code)) {
        code = 'CANDIDATE_CONFLICT'
        throw new Error('已有候选项与固定规则结果不一致')
      }
      if (match) {
        // 已有候选项经过兼容性校验后保持全部原字段，包括用户审核状态和时间。
        if (!stored) createCommitmentCandidate(db, { batchItemId, sourcePosition: position,
          ruleVersion: run.rule_version, ruleId: match.rule_id, reasonCode: match.reason_code })
        candidateCount++
      }
    }
    if (!markCommitmentComplete(db, batchItemId, ruleVersion, attempt)) {
      db.exec('ROLLBACK'); transaction = false
      return result('stale_attempt', { attempt })
    }
    db.exec('COMMIT'); transaction = false
    return result('complete', { attempt, candidateCount })
  } catch {
    if (transaction) {
      try { db.exec('ROLLBACK'); transaction = false } catch {
        logCommitmentFailure('FAILURE_PERSISTENCE_FAILED')
        return result('pending', { attempt: attempt ?? undefined })
      }
    }
    if (attempt === null) {
      logCommitmentFailure('PROCESSING_UNAVAILABLE')
      return result('pending')
    }
    // 失败登记使用独立短事务；旧代次无权完成或覆盖较新代次的结果。
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true
      const failed = markCommitmentFailed(db, batchItemId, ruleVersion, attempt, code)
      db.exec('COMMIT'); transaction = false
      return result(failed ? 'failed' : 'stale_attempt', { attempt })
    } catch {
      if (transaction) { try { db.exec('ROLLBACK') } catch { /* 保留安全状态，不尝试完成。 */ } }
      logCommitmentFailure('FAILURE_PERSISTENCE_FAILED')
      return result('pending', { attempt })
    }
  }
}
export function processCommitmentExtractorRun(
  db: DatabaseSync, batchItemId: string, ruleVersion: string = COMMITMENT_RULE_VERSION
): CommitmentProcessingResult { return processRun(db, batchItemId, ruleVersion, false) }
/** 仅显式处理失败运行记录；沿用原版本和来源快照，不重新登记或读取当前来源集合。 */
export function retryCommitmentExtractorRun(
  db: DatabaseSync, batchItemId: string, ruleVersion: string = COMMITMENT_RULE_VERSION
): CommitmentProcessingResult { return processRun(db, batchItemId, ruleVersion, true) }
