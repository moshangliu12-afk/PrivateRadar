import type { DatabaseSync } from 'node:sqlite'
import { loadStructuredSnapshot, verifyBatchEvidence } from './evidence'
import { BatchItemClaimError, importSavedBatchItem } from './import-item'
import { listBatchImportItems, type BatchImportItem, type BatchImportSession, type BatchImportStatus } from './repository'

export type BatchItemOutcome = 'success' | 'failed_zero_write' | 'needs_attention' | 'pending' | 'processing'

interface JobRow {
  id: string
  status: string
  imported_count: number
  duplicate_count: number
  updated_count: number
  error_count: number
}

export interface BatchItemSummary {
  item_id: string
  ordinal: number
  outcome: BatchItemOutcome
  effective_job_id: string | null
  input_messages: number | null
  imported: number
  duplicate: number
  updated: number
  invalid: number
  written_messages: number
  indexed_messages: number
}

export interface BatchSessionSummary {
  session_id: string
  status: BatchImportStatus
  attachments_total: number
  attachments_completed: number
  input_messages_total: number | null
  imported_total: number
  duplicate_total: number
  updated_total: number
  invalid_total: number
  failed_attachments: number
  attention_required_attachments: number
  items: BatchItemSummary[]
}

export type BatchSessionClaimResult = 'claimed' | 'already_running' | 'not_pending'

export class BatchSessionClaimError extends Error {
  constructor(readonly reason: Exclude<BatchSessionClaimResult, 'claimed'>) {
    super(`批量会话未取得首次执行权：${reason}`)
    this.name = 'BatchSessionClaimError'
  }
}

export function claimBatchSessionForFirstExecution(db: DatabaseSync, sessionId: string): BatchSessionClaimResult {
  const now = new Date().toISOString()
  const claimed = db.prepare(`
    UPDATE batch_import_sessions SET status = 'in_progress', updated_at = ?, completed_at = NULL
    WHERE id = ? AND status = 'pending'
  `).run(now, sessionId)
  if (claimed.changes === 1) return 'claimed'
  const row = db.prepare('SELECT status FROM batch_import_sessions WHERE id = ?').get(sessionId) as { status: BatchImportStatus } | undefined
  return row?.status === 'in_progress' ? 'already_running' : 'not_pending'
}

const activeSessionIds = new WeakMap<DatabaseSync, Set<string>>()

export async function executeBatchImportSession(
  db: DatabaseSync,
  databasePath: string,
  sessionId: string
): Promise<BatchSessionSummary> {
  claimLocalExecution(db, sessionId)
  try {
    const session = loadSession(db, sessionId)
    const items = listBatchImportItems(db, sessionId)
    if (items.length !== 2) throw new Error('当前批量会话首次执行要求正好两个附件项')
    if (session.status !== 'pending') throw new BatchSessionClaimError(session.status === 'in_progress' ? 'already_running' : 'not_pending')
    for (const item of items) {
      const unstarted = item.status === 'pending' || item.status === 'preparing'
      const evidenceFailedWithoutWrite = item.status === 'failed' &&
        (item.evidence_status === 'error' || item.error_summary?.startsWith('快照保存失败：'))
      if ((!unstarted && !evidenceFailedWithoutWrite) || item.effective_job_id || jobIds(db, item.id).length > 0 || linkedMessageCount(db, item) > 0) {
        throw new Error('附件项已有导入记录，不能作为首次会话执行')
      }
    }
    if (items[0].source_batch_id && items[0].source_batch_id === items[1].source_batch_id) {
      throw new Error('两个附件项不能共用来源批次编号')
    }
    const claim = claimBatchSessionForFirstExecution(db, sessionId)
    if (claim !== 'claimed') throw new BatchSessionClaimError(claim)

    for (const item of items) {
      if (item.status === 'failed') continue
      await runItem(db, databasePath, item)
    }
    return finalizeSession(db, databasePath, sessionId)
  } finally {
    activeSessionIds.get(db)?.delete(sessionId)
  }
}

export async function resumeInterruptedBatchImportSession(
  db: DatabaseSync,
  databasePath: string,
  sessionId: string
): Promise<BatchSessionSummary> {
  claimLocalExecution(db, sessionId)
  try {
    const session = loadSession(db, sessionId)
    if (session.status !== 'in_progress') throw new Error('仅执行中的批量会话可以恢复')
    const items = listBatchImportItems(db, sessionId)
    if (items.length !== 2) throw new Error('恢复要求正好两个附件项')
    if (items[0].source_batch_id && items[0].source_batch_id === items[1].source_batch_id) {
      throw new Error('两个附件项不能共用来源批次编号')
    }
    const ready: BatchImportItem[] = []
    for (const item of items) {
      const jobs = jobIds(db, item.id)
      const written = linkedMessageCount(db, item)
      if (item.status === 'pending' || item.status === 'preparing') {
        if (jobs.length || written || item.effective_job_id) throw new Error(`附件项 ${item.id} 状态与导入记录不一致，需人工处理`)
        if (item.evidence_status !== 'available') throw new Error(`附件项 ${item.id} 证据未准备好，需人工处理`)
        const evidence = await verifyBatchEvidence(db, databasePath, item.id)
        if (evidence.status !== 'available') throw new Error(`附件项 ${item.id} 证据未通过校验，需人工处理`)
        const snapshot = await loadStructuredSnapshot(db, databasePath, item.id)
        for (const [index, message] of snapshot.messages.entries()) {
          if (message.source_position !== undefined && message.source_position !== index) {
            throw new Error(`附件项 ${item.id} 消息位置不一致，需人工处理`)
          }
        }
        ready.push(item)
      } else if (item.status === 'in_progress') {
        throw new Error(`附件项 ${item.id} 已开始但未终结，需人工处理`)
      } else if (item.status === 'success') {
        bindSoleExistingJob(db, item, jobs)
        const summary = await getBatchImportSessionSummary(db, databasePath, sessionId)
        if (summary.items.find((value) => value.item_id === item.id)?.outcome !== 'success') {
          throw new Error(`附件项 ${item.id} 成功状态缺少可信任务，需人工处理`)
        }
      } else if (item.status === 'failed' || item.status === 'partial_success') {
        // 已终结的失败或部分结果不自动重试；现有任务及消息保持原状。
        bindSoleExistingJob(db, item, jobs)
      }
    }
    if (ready.length !== 1) throw new Error('当前中断状态不符合单个未开始附件的安全恢复条件')
    for (const item of ready) await runItem(db, databasePath, item)
    return finalizeSession(db, databasePath, sessionId)
  } finally {
    activeSessionIds.get(db)?.delete(sessionId)
  }
}

function bindSoleExistingJob(db: DatabaseSync, item: BatchImportItem, jobs: string[]): void {
  if (item.effective_job_id || jobs.length === 0) return
  if (jobs.length !== 1) throw new Error(`附件项 ${item.id} 有多个任务但无有效任务指针，需人工处理`)
  db.prepare(`
    UPDATE batch_import_items SET effective_job_id = ?, updated_at = ?
    WHERE id = ? AND effective_job_id IS NULL
  `).run(jobs[0], new Date().toISOString(), item.id)
}

function claimLocalExecution(db: DatabaseSync, sessionId: string): void {
  let active = activeSessionIds.get(db)
  if (!active) {
    active = new Set<string>()
    activeSessionIds.set(db, active)
  }
  if (active.has(sessionId)) throw new Error('批量会话正在当前数据库连接执行')
  active.add(sessionId)
}

async function runItem(db: DatabaseSync, databasePath: string, item: BatchImportItem): Promise<void> {
  const before = new Set(jobIds(db, item.id))
  let claimRejected = false
  try {
    await importSavedBatchItem(db, databasePath, item.id)
  } catch (error) {
    if (error instanceof BatchItemClaimError) {
      claimRejected = true
      throw error
    }
    // 附件服务已保存失败状态；保留其他附件已经提交的消息。
  } finally {
    if (!claimRejected) {
      const added = jobIds(db, item.id).filter((id) => !before.has(id))
      if (added.length > 1) throw new Error('单附件执行产生多个导入任务，无法确定有效结果')
      if (added.length === 1) {
        db.prepare(`
          UPDATE batch_import_items SET effective_job_id = ?, updated_at = ? WHERE id = ?
        `).run(added[0], new Date().toISOString(), item.id)
      }
    }
  }
}

async function finalizeSession(db: DatabaseSync, databasePath: string, sessionId: string): Promise<BatchSessionSummary> {
  const summary = await getBatchImportSessionSummary(db, databasePath, sessionId)
  const unfinished = summary.items.some((item) => item.outcome === 'pending' || item.outcome === 'processing')
  const effectiveWork = summary.items.some((item) => {
    if (item.outcome === 'success') return true
    const row = item.effective_job_id ? loadJob(db, item.effective_job_id, item.item_id) : null
    return item.written_messages > 0 || (row != null && ['success', 'partial'].includes(row.status) &&
      (row.updated_count > 0 || row.duplicate_count > 0))
  })
  const finalStatus: BatchImportStatus = unfinished ? 'in_progress'
    : summary.items.every((item) => item.outcome === 'success') ? 'success'
      : effectiveWork ? 'partial_success' : 'failed'
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE batch_import_sessions SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?
  `).run(finalStatus, now, unfinished ? null : now, sessionId)
  return { ...summary, status: finalStatus }
}

export async function getBatchImportSessionSummary(
  db: DatabaseSync,
  databasePath: string,
  sessionId: string
): Promise<BatchSessionSummary> {
  const session = loadSession(db, sessionId)
  const items: BatchItemSummary[] = []
  for (const item of listBatchImportItems(db, sessionId)) {
    let inputMessages: number | null = null
    try {
      const evidence = await verifyBatchEvidence(db, databasePath, item.id)
      if (evidence.snapshot.status === 'available') inputMessages = evidence.snapshot.messageCount ?? null
    } catch {
      // 证据无法验证时，消息数未知，不能伪装为零。
    }
    const job = item.effective_job_id ? loadJob(db, item.effective_job_id, item.id) : null
    const historyExists = jobIds(db, item.id).length > 0
    const written = linkedMessageCount(db, item)
    const indexed = linkedIndexedMessageCount(db, item)
    let outcome: BatchItemOutcome
    if (item.status === 'pending' || item.status === 'preparing') outcome = 'pending'
    else if (item.status === 'in_progress') outcome = 'processing'
    else if (item.status === 'success' && job?.status === 'success' && indexed === written && written >= job.imported_count) outcome = 'success'
    else if (item.status === 'failed' && indexed === 0 && written === 0 &&
      (!job || (job.status === 'failed' && job.imported_count === 0 && job.updated_count === 0)) &&
      (!historyExists || job !== null)) outcome = 'failed_zero_write'
    else outcome = 'needs_attention'
    items.push({
      item_id: item.id, ordinal: item.ordinal, outcome,
      effective_job_id: item.effective_job_id, input_messages: inputMessages,
      imported: job?.imported_count ?? 0, duplicate: job?.duplicate_count ?? 0,
      updated: job?.updated_count ?? 0, invalid: job?.error_count ?? 0,
      written_messages: written, indexed_messages: indexed
    })
  }
  return {
    session_id: sessionId, status: session.status,
    attachments_total: items.length,
    attachments_completed: items.filter((item) => !['pending', 'processing'].includes(item.outcome)).length,
    input_messages_total: items.every((item) => item.input_messages !== null)
      ? items.reduce((sum, item) => sum + item.input_messages!, 0) : null,
    imported_total: items.reduce((sum, item) => sum + item.imported, 0),
    duplicate_total: items.reduce((sum, item) => sum + item.duplicate, 0),
    updated_total: items.reduce((sum, item) => sum + item.updated, 0),
    invalid_total: items.reduce((sum, item) => sum + item.invalid, 0),
    failed_attachments: items.filter((item) => item.outcome === 'failed_zero_write').length,
    attention_required_attachments: items.filter((item) => item.outcome === 'needs_attention').length,
    items
  }
}

function loadSession(db: DatabaseSync, id: string): BatchImportSession {
  const session = db.prepare('SELECT * FROM batch_import_sessions WHERE id = ?').get(id) as unknown as BatchImportSession | undefined
  if (!session) throw new Error('批量会话不存在')
  return session
}

function jobIds(db: DatabaseSync, itemId: string): string[] {
  return (db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ? ORDER BY rowid').all(itemId) as Array<{ id: string }>).map((row) => row.id)
}

function loadJob(db: DatabaseSync, jobId: string, itemId: string): JobRow | null {
  return db.prepare(`
    SELECT id, status, imported_count, duplicate_count, updated_count, error_count
    FROM import_jobs WHERE id = ? AND batch_item_id = ?
  `).get(jobId, itemId) as unknown as JobRow | null
}

function linkedMessageCount(db: DatabaseSync, item: BatchImportItem): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM messages m
    WHERE (m.source_batch_id = ? AND ? IS NOT NULL)
      OR m.import_job_id IN (SELECT id FROM import_jobs WHERE batch_item_id = ?)
  `).get(item.source_batch_id, item.source_batch_id, item.id) as { count: number }).count
}

function linkedIndexedMessageCount(db: DatabaseSync, item: BatchImportItem): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM messages m JOIN messages_fts f ON f.rowid = m.rowid
    WHERE (m.source_batch_id = ? AND ? IS NOT NULL)
      OR m.import_job_id IN (SELECT id FROM import_jobs WHERE batch_item_id = ?)
  `).get(item.source_batch_id, item.source_batch_id, item.id) as { count: number }).count
}
