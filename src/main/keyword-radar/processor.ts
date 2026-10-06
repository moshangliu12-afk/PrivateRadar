import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parseMatchedTermsSnapshot, parseRulesSnapshot, parseSourcePositionsSnapshot } from './contracts'
import { matchKeywordSnapshot } from './matcher'
import { markKeywordRadarAttemptStarted, markKeywordRadarComplete, markKeywordRadarFailed, type KeywordRadarRun } from './runs'

type FailureCode = 'INVALID_SNAPSHOT' | 'PROCESSING_FAILED' | 'OCCURRENCE_INTEGRITY_FAILED' | 'HIT_CONFLICT'
export interface KeywordRadarProcessingResult {
  batchItemId: string
  status: 'complete' | 'already_complete' | 'failed' | 'pending' | 'retry_required' | 'not_pending' | 'not_found' | 'stale_attempt'
  attempt?: number
  hitCount?: number
}
/** 日志只含固定诊断码，不包含异常正文、聊天内容或路径。 */
export function logKeywordRadarFailure(code: 'PROCESSING_UNAVAILABLE' | 'FAILURE_PERSISTENCE_FAILED' | 'RECOVERY_FAILED'): void {
  console.warn(`[关键词雷达] ${code}`)
}
function ownsAttempt(db: DatabaseSync, batchItemId: string, attempt: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM keyword_radar_runs
    WHERE batch_item_id=? AND status='pending' AND attempt_count=?`).get(batchItemId, attempt))
}
function processRun(db: DatabaseSync, batchItemId: string, retry: boolean): KeywordRadarProcessingResult {
  const result = (
    status: KeywordRadarProcessingResult['status'], extra: Pick<KeywordRadarProcessingResult, 'attempt' | 'hitCount'> = {}
  ): KeywordRadarProcessingResult =>
    ({ batchItemId, status, ...extra })
  // 不能借用核心导入事务；启动或退出期间无法处理时保留持久 pending。
  if (!db.isOpen || db.isTransaction) return result('pending')
  let attempt: number | null = null
  let transaction = false
  let code: FailureCode = 'INVALID_SNAPSHOT'
  try {
    // 原始读取用于损坏快照的失败落库；不通过会提前验证并抛错的查询接口。
    const run = db.prepare('SELECT * FROM keyword_radar_runs WHERE batch_item_id=?').get(batchItemId) as unknown as KeywordRadarRun | undefined
    if (!run) return result('not_found')
    if (run.status === 'complete') return result('already_complete')
    if (run.status === 'failed' && !retry) return result('retry_required')
    if (run.status === 'pending' && retry) return result('not_pending')
    attempt = markKeywordRadarAttemptStarted(db, batchItemId, retry ? 'failed' : 'pending')
    if (attempt === null) return result('stale_attempt')
    const rules = parseRulesSnapshot(run.rules_snapshot_json)
    const positions = parseSourcePositionsSnapshot(run.source_positions_snapshot_json)
    code = 'PROCESSING_FAILED'
    db.exec('BEGIN IMMEDIATE')
    transaction = true
    if (!ownsAttempt(db, batchItemId, attempt)) {
      db.exec('ROLLBACK')
      transaction = false
      return result('stale_attempt', { attempt })
    }
    const source = db.prepare(`SELECT m.content FROM batch_item_message_sources s
      LEFT JOIN messages m ON m.id=s.message_id WHERE s.batch_item_id=? AND s.source_position=?`)
    const insert = db.prepare(`INSERT INTO keyword_hits
      (id,group_id,batch_item_id,source_position,group_name_snapshot,matched_terms_snapshot,matched_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(group_id,batch_item_id,source_position) DO NOTHING`)
    const existing = db.prepare(`SELECT group_name_snapshot,matched_terms_snapshot FROM keyword_hits
      WHERE group_id=? AND batch_item_id=? AND source_position=?`)
    const matchedAt = new Date().toISOString()
    let hitCount = 0
    for (const position of positions) {
      const occurrence = source.get(batchItemId, position)
      if (!occurrence || typeof occurrence.content !== 'string') {
        code = 'OCCURRENCE_INTEGRITY_FAILED'
        throw new Error(code)
      }
      for (const match of matchKeywordSnapshot(occurrence.content, rules)) {
        const snapshot = JSON.stringify(match.matched_terms)
        const inserted = insert.run(randomUUID(), match.group_id, batchItemId, position, match.group_name, snapshot, matchedAt)
        if (inserted.changes === 0) {
          code = 'HIT_CONFLICT'
          const old = existing.get(match.group_id, batchItemId, position)
          if (!old || old.group_name_snapshot !== match.group_name ||
            JSON.stringify(parseMatchedTermsSnapshot(String(old.matched_terms_snapshot))) !== snapshot) throw new Error(code)
          code = 'PROCESSING_FAILED'
        }
        hitCount++
      }
    }
    if (!markKeywordRadarComplete(db, batchItemId, attempt)) {
      db.exec('ROLLBACK')
      transaction = false
      return result('stale_attempt', { attempt })
    }
    db.exec('COMMIT')
    transaction = false
    return result('complete', { attempt, hitCount })
  } catch {
    if (transaction) {
      try { db.exec('ROLLBACK'); transaction = false } catch {
        logKeywordRadarFailure('FAILURE_PERSISTENCE_FAILED')
        return result('pending', { attempt: attempt ?? undefined })
      }
    }
    if (attempt === null) {
      logKeywordRadarFailure('PROCESSING_UNAVAILABLE')
      return result('pending')
    }
    // 失败记录与命中事务分离；代次条件也保护较新执行的结果。
    try {
      db.exec('BEGIN IMMEDIATE')
      transaction = true
      const failed = markKeywordRadarFailed(db, batchItemId, attempt, code)
      db.exec('COMMIT')
      transaction = false
      return result(failed ? 'failed' : 'stale_attempt', { attempt })
    } catch {
      if (transaction) { try { db.exec('ROLLBACK') } catch { /* 保留安全状态，不尝试完成。 */ } }
      logKeywordRadarFailure('FAILURE_PERSISTENCE_FAILED')
      return result('pending', { attempt })
    }
  }
}
export function processKeywordRadarRun(db: DatabaseSync, batchItemId: string): KeywordRadarProcessingResult {
  return processRun(db, batchItemId, false)
}
/** 仅供内部明确重试；不重新创建 Run、不重新冻结配置。 */
export function retryKeywordRadarRun(db: DatabaseSync, batchItemId: string): KeywordRadarProcessingResult {
  return processRun(db, batchItemId, true)
}
