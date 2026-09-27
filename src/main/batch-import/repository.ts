import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type BatchImportStatus = 'pending' | 'preparing' | 'in_progress' | 'success' | 'partial_success' | 'failed'

export interface BatchImportSession {
  id: string
  source: string
  status: BatchImportStatus
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface BatchImportItem {
  id: string
  batch_session_id: string
  ordinal: number
  attachment_name: string | null
  source_hint: string | null
  attachment_identity: string | null
  evidence_relative_path: string | null
  evidence_status: 'pending' | 'available' | 'missing' | 'corrupt' | 'error'
  snapshot_relative_path: string | null
  snapshot_sha256: string | null
  source_batch_id: string | null
  effective_job_id: string | null
  status: BatchImportStatus
  error_summary: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface BatchItemJob {
  id: string
  batch_item_id: string
  status: string
  started_at: string
  completed_at: string | null
}

export function createBatchImportSession(db: DatabaseSync, source: string): BatchImportSession {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO batch_import_sessions (id, source, status, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?)
  `).run(id, source, now, now)
  return db.prepare('SELECT * FROM batch_import_sessions WHERE id = ?').get(id) as unknown as BatchImportSession
}

export function createBatchImportItem(
  db: DatabaseSync,
  batchSessionId: string,
  ordinal: number,
  attachmentName: string | null = null,
  attachmentIdentity: string | null = null,
  sourceHint: string | null = null
): BatchImportItem {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO batch_import_items (
      id, batch_session_id, ordinal, attachment_name, attachment_identity, source_hint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, batchSessionId, ordinal, attachmentName, attachmentIdentity, sourceHint, now, now)
  return db.prepare('SELECT * FROM batch_import_items WHERE id = ?').get(id) as unknown as BatchImportItem
}

export function listBatchImportItems(db: DatabaseSync, batchSessionId: string): BatchImportItem[] {
  return db.prepare(`
    SELECT * FROM batch_import_items WHERE batch_session_id = ? ORDER BY ordinal, id
  `).all(batchSessionId) as unknown as BatchImportItem[]
}

export function listBatchItemJobs(db: DatabaseSync, batchItemId: string): BatchItemJob[] {
  return db.prepare(`
    SELECT id, batch_item_id, status, started_at, completed_at
    FROM import_jobs WHERE batch_item_id = ? ORDER BY started_at, id
  `).all(batchItemId) as unknown as BatchItemJob[]
}

export function attachImportJobToBatchItem(db: DatabaseSync, jobId: string, batchItemId: string): void {
  const result = db.prepare(`
    UPDATE import_jobs SET batch_item_id = ? WHERE id = ? AND batch_item_id IS NULL
  `).run(batchItemId, jobId)
  if (result.changes !== 1) throw new Error('导入任务不存在或已关联附件项')
}
