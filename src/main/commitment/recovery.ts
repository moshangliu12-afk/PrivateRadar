import type { DatabaseSync } from 'node:sqlite'
import { logCommitmentFailure, processCommitmentExtractorRun, type CommitmentProcessingResult } from './processor'

/** 只枚举持久待处理记录，不扫描历史消息、来源、附件项或关键词运行记录。 */
export async function processPendingCommitmentExtractorRuns(
  db: DatabaseSync, batchItemIds?: readonly string[]
): Promise<CommitmentProcessingResult[]> {
  const results: CommitmentProcessingResult[] = []
  try {
    if (!db.isOpen || db.isTransaction) return results
    const selected = batchItemIds ? new Set(batchItemIds) : null
    const rows = db.prepare(`SELECT batch_item_id,rule_version FROM commitment_extractor_runs
      WHERE status='pending' ORDER BY created_at,batch_item_id,rule_version`).all()
    for (const row of rows) {
      const id = String(row.batch_item_id), version = String(row.rule_version)
      if (selected && !selected.has(id)) continue
      await new Promise<void>(resolve => setImmediate(resolve))
      if (!db.isOpen) break
      try { results.push(processCommitmentExtractorRun(db, id, version)) } catch { logCommitmentFailure('RECOVERY_FAILED') }
    }
  } catch { logCommitmentFailure('RECOVERY_FAILED') }
  return results
}
/** 与现有关键词模式一致：导入返回及桌面创建不等待派生，不添加后台循环或队列。 */
export function schedulePendingCommitmentExtractorRuns(db: DatabaseSync, batchItemIds?: readonly string[]): void {
  try {
    setImmediate(() => {
      try {
        void processPendingCommitmentExtractorRuns(db, batchItemIds).catch(() => logCommitmentFailure('RECOVERY_FAILED'))
      } catch { logCommitmentFailure('RECOVERY_FAILED') }
    })
  } catch { logCommitmentFailure('RECOVERY_FAILED') }
}
