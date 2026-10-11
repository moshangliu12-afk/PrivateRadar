import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportResult } from '../src/shared/models'
import { importChatFile } from '../src/main/import/importer'
import { configureMacEvidenceRoot } from '../src/main/batch-import/mac-json-evidence'
import { createBatchImportItem, createBatchImportSession, type BatchImportItem, type BatchImportSession } from '../src/main/batch-import/repository'
import { saveCapturedJsonEvidence, saveStructuredSnapshot } from '../src/main/batch-import/evidence'
import { createManualJsonSnapshot } from '../src/main/import/manual-json-contract'
import { sharedCoreFixture } from './shared-core-fixture'

export type SharedJsonFixture = ReturnType<typeof sharedCoreFixture>
export type SharedJsonResult = ImportResult & { batchSessionId: string; batchItemId: string; rawSourceIdentity: string }
export function sharedJsonFixture() {
  const f = sharedCoreFixture()
  if (process.platform === 'darwin') configureMacEvidenceRoot(f.directory)
  return f
}
export function sharedJsonItem(f: SharedJsonFixture, itemId: string): BatchImportItem {
  return f.db.prepare('SELECT * FROM batch_import_items WHERE id=?').get(itemId) as unknown as BatchImportItem
}
export async function importSharedJson(f: SharedJsonFixture, values: unknown[], name = '原始输入.json') {
  const source = join(f.directory, name), bytes = Buffer.from(JSON.stringify(values))
  writeFileSync(source, bytes)
  const result = await importChatFile(f.db, source, f.path) as SharedJsonResult
  const session = f.db.prepare('SELECT * FROM batch_import_sessions WHERE id=?').get(result.batchSessionId) as unknown as BatchImportSession
  return { result, bytes, source, item: sharedJsonItem(f, result.batchItemId), session }
}
/** 证据服务单位：原记录可以无效，不把保全成功说成消息导入成功。 */
export function createSharedJsonItem(f: SharedJsonFixture) {
  const session = createBatchImportSession(f.db, 'file'), item = createBatchImportItem(f.db, session.id, 0)
  f.db.prepare('UPDATE batch_import_items SET source_batch_id=? WHERE id=?').run(`file:json:item:${item.id}`, item.id)
  return sharedJsonItem(f, item.id)
}
export async function saveSharedJsonRaw(f: SharedJsonFixture, values: unknown[], snapshot = true) {
  const item = createSharedJsonItem(f), bytes = Buffer.from(JSON.stringify(values))
  await saveCapturedJsonEvidence(f.db, f.path, item.id, bytes)
  const input = createManualJsonSnapshot(bytes)
  if (snapshot) await saveStructuredSnapshot(f.db, f.path, item.id, input)
  return { item: sharedJsonItem(f, item.id), bytes, input }
}
export function sharedEvidenceBytes(f: SharedJsonFixture, itemId: string) {
  const item = sharedJsonItem(f, itemId)
  return [item.evidence_relative_path, item.snapshot_relative_path].filter((p): p is string => p !== null)
    .map(p => [p, readFileSync(join(f.directory, p))] as const)
}
