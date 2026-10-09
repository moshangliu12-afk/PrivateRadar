import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportResult } from '../../shared/models'
import { createBatchImportItem, createBatchImportSession } from '../batch-import/repository'
import { claimBatchItemForFirstImport } from '../batch-import/import-item'
import { loadManualJsonSnapshot, saveCapturedJsonEvidence, saveStructuredSnapshot } from '../batch-import/evidence'
import { schedulePendingKeywordRadarRuns } from '../keyword-radar/recovery'
import { schedulePendingCommitmentExtractorRuns } from '../commitment/recovery'
import { importChatContent } from './importer'
import { createManualJsonSnapshot, MANUAL_JSON_MAX_BYTES } from './manual-json-contract'

export interface ManualJsonImportResult extends ImportResult {
  batchSessionId: string
  batchItemId: string
  rawSourceIdentity: string
}

/** 只从同一个普通文件句柄读取一次，解析和 ZIP 均消费这份已捕获字节。 */
async function captureSource(path: string): Promise<Buffer> {
  const selected = await lstat(path)
  if (!selected.isFile() || selected.isSymbolicLink()) throw new Error('请选择普通 JSON 文件')
  if (selected.size > MANUAL_JSON_MAX_BYTES) throw new Error('文件超过 50 MB，请拆分后再导入')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== selected.dev || before.ino !== selected.ino ||
        before.size > MANUAL_JSON_MAX_BYTES) throw new Error('JSON 文件在捕获前发生变化，请重新选择')
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const block = Buffer.alloc(1024 * 1024)
      const { bytesRead } = await handle.read(block, 0, block.length, null)
      if (bytesRead === 0) break
      size += bytesRead
      if (size > MANUAL_JSON_MAX_BYTES) throw new Error('文件超过 50 MB，请拆分后再导入')
      chunks.push(block.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    if (before.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('JSON 文件在捕获中发生变化，请重新选择')
    }
    return Buffer.concat(chunks, size)
  } finally { await handle.close() }
}

function preparationFailure(
  db: DatabaseSync, itemId: string, sessionId: string, fileName: string
): ImportResult {
  const now = new Date().toISOString(), jobId = randomUUID()
  const reason = 'MANUAL_JSON_PREPARATION_FAILED: 本来源未导入，原始证据或结构化快照未能完成校验。已封存的原始证据保留。'
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare("INSERT INTO import_jobs (id,adapter,source_name,file_type,status,started_at,completed_at,batch_item_id,error_details_json) " +
      "VALUES (?,'file',?,'JSON','failed',?,?,?,?)").run(jobId, fileName, now, now, itemId, JSON.stringify([reason]))
    db.prepare("UPDATE batch_import_items SET status='failed',effective_job_id=?,error_summary=?,updated_at=?,completed_at=? WHERE id=?")
      .run(jobId, reason, now, now, itemId)
    db.prepare("UPDATE batch_import_sessions SET status='failed',updated_at=?,completed_at=? WHERE id=?").run(now, now, sessionId)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return { jobId, fileName, fileType: 'JSON', recognizedCount: 0, importedCount: 0, duplicateCount: 0,
    updatedCount: 0, invalidCount: 0, status: 'failed', errors: [reason] }
}

export async function importManualJsonFile(
  db: DatabaseSync, databasePath: string, filePath: string
): Promise<ManualJsonImportResult> {
  const actualDatabasePath = db.location()
  if (!actualDatabasePath || resolve(actualDatabasePath) !== resolve(databasePath)) throw new Error('原始证据目录与当前数据库不匹配')
  const bytes = await captureSource(filePath)
  const rawSourceIdentity = createHash('sha256').update(bytes).digest('hex'), fileName = basename(filePath)
  db.exec('BEGIN IMMEDIATE')
  let sessionId: string, itemId: string, sourceBatchId: string
  try {
    const session = createBatchImportSession(db, 'file'), item = createBatchImportItem(db, session.id, 0, fileName)
    sessionId = session.id; itemId = item.id; sourceBatchId = 'file:json:item:' + item.id
    db.prepare("UPDATE batch_import_items SET status='preparing',source_batch_id=? WHERE id=?").run(sourceBatchId, itemId)
    db.prepare("UPDATE batch_import_sessions SET status='preparing' WHERE id=?").run(sessionId)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  try {
    await saveCapturedJsonEvidence(db, databasePath, itemId, bytes)
    const snapshot = createManualJsonSnapshot(bytes)
    await saveStructuredSnapshot(db, databasePath, itemId, snapshot)
    const verified = await loadManualJsonSnapshot(db, databasePath, itemId)
    if (verified.raw_source_sha256 !== rawSourceIdentity || verified.raw_source_bytes !== bytes.length) throw new Error('原始 JSON 身份校验失败')
  } catch {
    return { ...preparationFailure(db, itemId, sessionId, fileName), batchSessionId: sessionId, batchItemId: itemId, rawSourceIdentity }
  }
  const claimed = claimBatchItemForFirstImport(db, itemId)
  if (claimed !== 'claimed') throw new Error('手动 JSON 来源未取得首次执行权')
  const result = importChatContent(db, fileName, 'JSON', bytes.toString('utf8'), {
    adapter: 'file', batchItemId: itemId, sourceBatchId, messageSource: 'file'
  })
  if (result.status !== 'failed') {
    for (const schedule of [schedulePendingKeywordRadarRuns, schedulePendingCommitmentExtractorRuns]) {
      try { schedule(db, [itemId]) } catch {
        result.errors.push('POST_COMMIT_DERIVED_SCHEDULE_FAILED: 核心导入已提交，派生处理保留待恢复状态。')
      }
    }
  }
  return { ...result, batchSessionId: sessionId, batchItemId: itemId, rawSourceIdentity }
}
