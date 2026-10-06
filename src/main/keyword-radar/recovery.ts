import type { DatabaseSync } from 'node:sqlite'
import { logKeywordRadarFailure, processKeywordRadarRun, type KeywordRadarProcessingResult } from './processor'

/** 只枚举已登记的 pending；损坏快照交给单个处理器落 failed，不阻断其他 Run。 */
export async function processPendingKeywordRadarRuns(
  db: DatabaseSync, batchItemIds?: readonly string[]
): Promise<KeywordRadarProcessingResult[]> {
  const results: KeywordRadarProcessingResult[] = []
  try {
    if (!db.isOpen || db.isTransaction) return results
    const selected = batchItemIds ? new Set(batchItemIds) : null
    const rows = db.prepare(`SELECT batch_item_id FROM keyword_radar_runs
      WHERE status='pending' ORDER BY created_at,batch_item_id`).all()
    for (const row of rows) {
      const id = String(row.batch_item_id)
      if (selected && !selected.has(id)) continue
      // 每个 Run 之间让出事件循环；退出后不再访问已关闭连接。
      await new Promise<void>(resolve => setImmediate(resolve))
      if (!db.isOpen) break
      try { results.push(processKeywordRadarRun(db, id)) } catch { logKeywordRadarFailure('RECOVERY_FAILED') }
    }
  } catch { logKeywordRadarFailure('RECOVERY_FAILED') }
  return results
}
/** 导入返回与窗口创建均不等待派生处理，且没有计时器、重试循环或调度框架。 */
export function schedulePendingKeywordRadarRuns(db: DatabaseSync, batchItemIds?: readonly string[]): void {
  try {
    setImmediate(() => {
      try {
        void processPendingKeywordRadarRuns(db, batchItemIds).catch(() => logKeywordRadarFailure('RECOVERY_FAILED'))
      } catch { logKeywordRadarFailure('RECOVERY_FAILED') }
    })
  } catch { logKeywordRadarFailure('RECOVERY_FAILED') }
}
