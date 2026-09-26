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
  batchItemId: string
): Promise<WorkBuddyIngestResult> {
  const initialItem = loadItem(db, batchItemId)
  try {
    // 先校验证据，缺失或损坏时不分配身份，也不创建导入任务。
    if (initialItem.evidence_status !== 'available') throw new Error('原始 ZIP 尚未登记为可用')
    const verification = await verifyBatchEvidence(db, databasePath, batchItemId)
    if (verification.status !== 'available') throw new Error(`附件证据未准备好：${verification.status}`)
    ensureSourceBatchId(db, batchItemId)
    const ready = await verifyBatchItemReadyForImport(db, databasePath, batchItemId)
    updateItemStatus(db, batchItemId, 'in_progress', null, false)
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
