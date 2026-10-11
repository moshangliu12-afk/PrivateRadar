import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import type { WorkBuddyMessageInput } from '../src/main/integrations/workbuddy/validation'

const fixtures: Array<{ db: DatabaseSync; directory: string }> = []
export async function drainSharedDerived() {
  for (let tick = 0; tick < 12; tick++) await new Promise<void>(resolve => setImmediate(resolve))
}
afterEach(async () => {
  await drainSharedDerived()
  for (const f of fixtures.splice(0)) {
    if (f.db.isOpen) f.db.close()
    const target = resolve(f.directory)
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith('privateradar-shared-core-')) {
      throw new Error('共享隔离目录清理目标越界')
    }
    rmSync(target, { recursive: true, force: true })
  }
})

export function sharedCoreFixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'privateradar-shared-core-'))
  const path = join(directory, 'private-radar.db'), db = new DatabaseSync(path)
  initializeDatabase(db)
  fixtures.push({ db, directory })
  return { db, directory, path }
}
export function sharedCoreItems(f: ReturnType<typeof sharedCoreFixture>, count = 2, collectionId?: string) {
  const session = createBatchImportSession(f.db, 'workbuddy', collectionId)
  const items = Array.from({ length: count }, (_, ordinal) => {
    const item = createBatchImportItem(f.db, session.id, ordinal)
    const sourceBatchId = `workbuddy:item:${item.id}`
    f.db.prepare('UPDATE batch_import_items SET source_batch_id=? WHERE id=?').run(sourceBatchId, item.id)
    return { ...item, source_batch_id: sourceBatchId }
  })
  return { ...f, session, items }
}
/** 只运行已有内部数据事务，不声明运行了公开 WorkBuddy 或 Evidence 入口。 */
export function ingestSharedCore(f: ReturnType<typeof sharedCoreItems>, ordinal: number, messages: WorkBuddyMessageInput[]) {
  const item = f.items[ordinal]
  const result = ingestWorkBuddyMessages(f.db, { messages }, 0, { batchItemId: item.id, sourceBatchId: item.source_batch_id })
  // 数据库读模型单位的终态前提；Job、消息、来源和派生任务均由真实核心事务产生。
  f.db.prepare('UPDATE batch_import_items SET status=?,effective_job_id=?,error_summary=? WHERE id=?')
    .run(result.status === 'success' ? 'success' : result.status === 'partial' ? 'partial_success' : 'failed',
      result.jobId, result.status === 'failed' ? result.errors[0] ?? '核心导入失败' : null, item.id)
  return result
}
export function sharedRows(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT * FROM "${table}"`).all()
}
export function sharedCount(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n)
}
export function sharedCoreState(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'keyword_%' AND name NOT LIKE 'commitment_%' ORDER BY name")
    .all().map(row => [row.name, sharedRows(db, String(row.name))])
}
