import type { DatabaseSync } from 'node:sqlite'
import { ingestWorkBuddyMessages, type WorkBuddyIngestResult } from '../integrations/workbuddy/ingest'
import type { WorkBuddyIngestInput } from '../integrations/workbuddy/validation'
import { loadStructuredSnapshot, verifyBatchEvidence } from './evidence'
import type { BatchImportItem, BatchImportStatus } from './repository'

export interface ReadyBatchItem {
  itemId: string
  sourceBatchId: string
  input: WorkBuddyIngestInput
}

export type BatchItemClaimResult = 'claimed' | 'already_running' | 'not_executable' | 'terminal'

export class BatchItemClaimError extends Error {
  constructor(readonly reason: Exclude<BatchItemClaimResult, 'claimed'>) {
    super(`附件项未取得首次执行权：${reason}`)
    this.name = 'BatchItemClaimError'
  }
}

export function claimBatchItemForFirstImport(db: DatabaseSync, batchItemId: string): BatchItemClaimResult {
  const now = new Date().toISOString()
  const claimed = db.prepare(`
    UPDATE batch_import_items
    SET status = 'in_progress', error_summary = NULL, updated_at = ?, completed_at = NULL
    WHERE id = ? AND status IN ('pending', 'preparing') AND effective_job_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM import_jobs WHERE batch_item_id = batch_import_items.id)
      AND NOT EXISTS (
        SELECT 1 FROM messages WHERE source_batch_id = batch_import_items.source_batch_id
      )
  `).run(now, batchItemId)
  if (claimed.changes === 1) return 'claimed'
  const item = db.prepare('SELECT status FROM batch_import_items WHERE id = ?').get(batchItemId) as { status: BatchImportStatus } | undefined
  if (!item) return 'not_executable'
  if (item.status === 'in_progress') return 'already_running'
  if (['success', 'partial_success', 'failed'].includes(item.status)) return 'terminal'
  return 'not_executable'
}

export async function verifyBatchItemReadyForImport(
  db: DatabaseSync,
  databasePath: string,
  batchItemId: string
): Promise<ReadyBatchItem> {
  const item = loadItem(db, batchItemId)
  if (!item.source_batch_id?.trim()) throw new Error('附件项尚无稳定来源批次编号')
  if (item.evidence_status !== 'available') throw new Error('原始 ZIP 尚未登记为可用')
  const verification = await verifyBatchEvidence(db, databasePath, batchItemId)
  if (verification.status !== 'available') throw new Error(`附件证据未准备好：${verification.status}`)
  const input = await loadStructuredSnapshot(db, databasePath, batchItemId)
  for (const [index, message] of input.messages.entries()) {
    if (message.source_position !== undefined && message.source_position !== index) {
      throw new Error(`结构化快照第 ${index + 1} 条的原始位置与数组顺序不一致`)
    }
  }
  return { itemId: batchItemId, sourceBatchId: item.source_batch_id, input }
}

export async function importSavedBatchItem(
  db: DatabaseSync,
  databasePath: string,
  batchItemId: string,
  mode: 'first' | 'deterministic_replay' = 'first'
): Promise<WorkBuddyIngestResult> {
  const initialItem = loadItem(db, batchItemId)
  if (mode === 'first') {
    const claim = claimBatchItemForFirstImport(db, batchItemId)
    if (claim !== 'claimed') throw new BatchItemClaimError(claim)
  } else {
    const claimed = db.prepare(`
      UPDATE batch_import_items
      SET status = 'in_progress', error_summary = NULL, updated_at = ?, completed_at = NULL
      WHERE id = ? AND status = 'success'
    `).run(new Date().toISOString(), batchItemId)
    if (claimed.changes !== 1) {
      const current = loadItem(db, batchItemId)
      throw new BatchItemClaimError(current.status === 'in_progress' ? 'already_running' : 'not_executable')
    }
  }
  try {
    // 先校验证据，缺失或损坏时不分配身份，也不创建导入任务。
    if (initialItem.evidence_status !== 'available') throw new Error('原始 ZIP 尚未登记为可用')
    const verification = await verifyBatchEvidence(db, databasePath, batchItemId)
    if (verification.status !== 'available') throw new Error(`附件证据未准备好：${verification.status}`)
    ensureSourceBatchId(db, batchItemId)
    const ready = await verifyBatchItemReadyForImport(db, databasePath, batchItemId)
    const result = ingestWorkBuddyMessages(db, ready.input, 0, {
      batchItemId,
      sourceBatchId: ready.sourceBatchId
    })
    const status: BatchImportStatus = result.status === 'success'
      ? 'success'
      : result.status === 'partial' ? 'partial_success' : 'failed'
    updateItemStatus(db, batchItemId, status, result.status === 'failed' ? result.errors[0] ?? '导入失败' : null, true)
    return result
  } catch (error) {
    updateItemStatus(db, batchItemId, 'failed', errorMessage(error), true)
    throw error
  }
}

function ensureSourceBatchId(db: DatabaseSync, batchItemId: string): string {
  const current = loadItem(db, batchItemId).source_batch_id
  if (current !== null) {
    if (!current.trim()) throw new Error('附件项来源批次编号为空')
    return current
  }
  const candidate = `workbuddy:item:${batchItemId}`
  db.prepare(`
    UPDATE batch_import_items SET source_batch_id = ?, updated_at = ?
    WHERE id = ? AND source_batch_id IS NULL
  `).run(candidate, new Date().toISOString(), batchItemId)
  const stored = loadItem(db, batchItemId).source_batch_id
  if (!stored?.trim()) throw new Error('无法持久保存附件项来源批次编号')
  return stored
}

function loadItem(db: DatabaseSync, batchItemId: string): BatchImportItem {
  const item = db.prepare('SELECT * FROM batch_import_items WHERE id = ?').get(batchItemId) as unknown as BatchImportItem | undefined
  if (!item) throw new Error('附件项不存在')
  return item
}

function updateItemStatus(
  db: DatabaseSync,
  batchItemId: string,
  status: BatchImportStatus,
  errorSummary: string | null,
  completed: boolean
): void {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE batch_import_items SET status = ?, error_summary = ?, updated_at = ?, completed_at = ? WHERE id = ?
  `).run(status, errorSummary, now, completed ? now : null, batchItemId)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知导入错误'
}
