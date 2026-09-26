import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { saveOriginalZip, saveStructuredSnapshot } from '../src/main/batch-import/evidence'
import { BatchItemClaimError, claimBatchItemForFirstImport, importSavedBatchItem } from '../src/main/batch-import/import-item'
import { BatchSessionClaimError, claimBatchSessionForFirstExecution, executeBatchImportSession, resumeInterruptedBatchImportSession } from '../src/main/batch-import/session'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-concurrent-'))
  directories.push(directory)
  const databasePath = join(directory, 'private-radar.db')
  const a = new DatabaseSync(databasePath)
  const b = new DatabaseSync(databasePath)
  databases.push(a, b)
  initializeDatabase(a)
  initializeDatabase(b)
  const zipPath = join(directory, 'source.zip')
  const bytes = Buffer.alloc(22)
  bytes.write('PK\u0005\u0006', 0, 'binary')
  writeFileSync(zipPath, bytes)
  const session = createBatchImportSession(a, 'workbuddy')
  const first = createBatchImportItem(a, session.id, 0)
  const second = createBatchImportItem(a, session.id, 1)
  return { a, b, databasePath, zipPath, session, first, second }
}

async function prepare(f: ReturnType<typeof fixture>, itemId: string, count: number) {
  await saveOriginalZip(f.a, f.databasePath, itemId, f.zipPath)
  await saveStructuredSnapshot(f.a, f.databasePath, itemId, {
    messages: Array.from({ length: count }, (_, index) => ({
      content: `并发测试 ${itemId} ${index}`, sender_name: '甲', source_position: index
    }))
  })
}

function count(db: DatabaseSync, table: 'import_jobs' | 'messages' | 'messages_fts') {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

describe('alpha.15 跨数据库连接执行权', () => {
  it('两个连接都先读到待处理，数据库条件更新仍只允许一个认领', () => {
    const f = fixture()
    expect(f.a.prepare('SELECT status FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toEqual({ status: 'pending' })
    expect(f.b.prepare('SELECT status FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toEqual({ status: 'pending' })
    expect(claimBatchSessionForFirstExecution(f.a, f.session.id)).toBe('claimed')
    expect(claimBatchSessionForFirstExecution(f.b, f.session.id)).toBe('already_running')
    expect(claimBatchItemForFirstImport(f.a, f.first.id)).toBe('claimed')
    expect(claimBatchItemForFirstImport(f.b, f.first.id)).toBe('already_running')
    expect(count(f.a, 'import_jobs')).toBe(0)
  })

  it('两个连接竞争首次会话，仅一个认领，两项各一个任务', async () => {
    const f = fixture()
    await prepare(f, f.first.id, 3)
    await prepare(f, f.second.id, 6)
    expect(f.a).not.toBe(f.b)
    const results = await Promise.allSettled([
      executeBatchImportSession(f.a, f.databasePath, f.session.id),
      executeBatchImportSession(f.b, f.databasePath, f.session.id)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(BatchSessionClaimError)
    expect(['already_running', 'not_pending']).toContain(rejected.reason.reason)
    expect(f.a.prepare('SELECT batch_item_id, COUNT(*) AS count FROM import_jobs GROUP BY batch_item_id ORDER BY batch_item_id').all()).toEqual([
      { batch_item_id: f.first.id, count: 1 }, { batch_item_id: f.second.id, count: 1 }
    ].sort((left, right) => left.batch_item_id.localeCompare(right.batch_item_id)))
    expect(count(f.b, 'import_jobs')).toBe(2)
    expect(count(f.b, 'messages')).toBe(9)
    expect(count(f.b, 'messages_fts')).toBe(9)
  })

  it('两个连接竞争同一附件，只有认领者创建任务', async () => {
    const f = fixture()
    await prepare(f, f.first.id, 3)
    const results = await Promise.allSettled([
      importSavedBatchItem(f.a, f.databasePath, f.first.id),
      importSavedBatchItem(f.b, f.databasePath, f.first.id)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(BatchItemClaimError)
    expect(['already_running', 'terminal']).toContain(rejected.reason.reason)
    expect(count(f.a, 'import_jobs')).toBe(1)
    expect(count(f.b, 'messages')).toBe(3)
    expect(count(f.b, 'messages_fts')).toBe(3)
  })

  it('现有显式确定性重放也不能被两个连接同时进入', async () => {
    const f = fixture()
    await prepare(f, f.first.id, 3)
    const original = await importSavedBatchItem(f.a, f.databasePath, f.first.id)
    const results = await Promise.allSettled([
      importSavedBatchItem(f.a, f.databasePath, f.first.id, 'deterministic_replay'),
      importSavedBatchItem(f.b, f.databasePath, f.first.id, 'deterministic_replay')
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(BatchItemClaimError)
    expect(count(f.a, 'import_jobs')).toBe(2)
    expect(f.a.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ? ORDER BY rowid').all(f.first.id)[0]).toEqual({ id: original.jobId })
    expect(count(f.b, 'messages')).toBe(3)
  })

  it('两个连接竞争恢复时，只为未开始的第二附件创建一个任务', async () => {
    const f = fixture()
    await prepare(f, f.first.id, 3)
    await prepare(f, f.second.id, 6)
    const first = await importSavedBatchItem(f.a, f.databasePath, f.first.id)
    f.a.prepare('UPDATE batch_import_items SET effective_job_id = ? WHERE id = ?').run(first.jobId, f.first.id)
    f.a.prepare("UPDATE batch_import_sessions SET status = 'in_progress', completed_at = NULL WHERE id = ?").run(f.session.id)
    const results = await Promise.allSettled([
      resumeInterruptedBatchImportSession(f.a, f.databasePath, f.session.id),
      resumeInterruptedBatchImportSession(f.b, f.databasePath, f.session.id)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected).toBeDefined()
    expect(rejected.reason).toBeInstanceOf(Error)
    expect(rejected.reason.message).not.toMatch(/SQLITE_BUSY|database is locked/)
    expect(f.a.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').all(f.first.id)).toEqual([{ id: first.jobId }])
    expect(f.b.prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE batch_item_id = ?').get(f.second.id)).toEqual({ count: 1 })
    expect(count(f.b, 'messages')).toBe(9)
    expect(count(f.b, 'messages_fts')).toBe(9)
    expect(f.b.prepare('SELECT status FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toEqual({ status: 'success' })
  })

  it('终态附件和已有任务的待处理附件均不能再次首次认领', async () => {
    const f = fixture()
    for (const status of ['success', 'partial_success', 'failed']) {
      f.a.prepare('UPDATE batch_import_items SET status = ? WHERE id = ?').run(status, f.first.id)
      expect(claimBatchItemForFirstImport(f.b, f.first.id)).toBe('terminal')
    }
    f.a.prepare("UPDATE batch_import_items SET status = 'pending' WHERE id = ?").run(f.first.id)
    f.a.prepare(`INSERT INTO import_jobs (id, adapter, source_name, status, started_at, batch_item_id)
      VALUES ('old-job', 'workbuddy', 'old', 'success', '2026-09-26T00:00:00Z', ?)`)
      .run(f.first.id)
    expect(claimBatchItemForFirstImport(f.b, f.first.id)).toBe('not_executable')
    expect(count(f.a, 'import_jobs')).toBe(1)
  })

  it('附件已认领后进程中断，另一连接不能抢占或猜测恢复', async () => {
    const f = fixture()
    await prepare(f, f.first.id, 3)
    await prepare(f, f.second.id, 6)
    const first = await importSavedBatchItem(f.a, f.databasePath, f.first.id)
    f.a.prepare('UPDATE batch_import_items SET effective_job_id = ? WHERE id = ?').run(first.jobId, f.first.id)
    f.a.prepare("UPDATE batch_import_sessions SET status = 'in_progress', completed_at = NULL WHERE id = ?").run(f.session.id)
    expect(claimBatchItemForFirstImport(f.a, f.second.id)).toBe('claimed')
    f.a.close()
    databases.splice(databases.indexOf(f.a), 1)
    expect(claimBatchItemForFirstImport(f.b, f.second.id)).toBe('already_running')
    await expect(resumeInterruptedBatchImportSession(f.b, f.databasePath, f.session.id)).rejects.toThrow('需人工处理')
    expect(f.b.prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE batch_item_id = ?').get(f.second.id)).toEqual({ count: 0 })
    expect(f.b.prepare('SELECT completed_at FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toEqual({ completed_at: null })
  })
})
