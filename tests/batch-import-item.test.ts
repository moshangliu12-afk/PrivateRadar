import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { importChatContent } from '../src/main/import/importer'
import { createBatchImportItem, createBatchImportSession, listBatchItemJobs } from '../src/main/batch-import/repository'
import { saveOriginalZip, saveStructuredSnapshot } from '../src/main/batch-import/evidence'
import { importSavedBatchItem, verifyBatchItemReadyForImport } from '../src/main/batch-import/import-item'
import type { WorkBuddyIngestInput } from '../src/main/integrations/workbuddy/validation'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function fixture(): { db: DatabaseSync; databasePath: string; directory: string; zipPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-item-import-'))
  directories.push(directory)
  const databasePath = join(directory, 'private-radar.db')
  const db = new DatabaseSync(databasePath)
  databases.push(db)
  initializeDatabase(db)
  const zipPath = join(directory, 'source.zip')
  const emptyZip = Buffer.alloc(22)
  emptyZip.write('PK\u0005\u0006', 0, 'binary')
  writeFileSync(zipPath, emptyZip)
  return { db, databasePath, directory, zipPath }
}

function snapshot(): WorkBuddyIngestInput {
  return {
    source_batch_id: '快照原有来源提示',
    messages: ['A', 'B', 'C', 'D'].map((label, index) => ({
      platform: 'wechat', sender_name: index % 2 === 0 ? '甲' : '乙',
      timestamp: `2026-09-${index < 2 ? '24' : '25'}T10:0${index}:00+08:00`,
      timestamp_source: 'source_native', content: `消息 ${label}`, source_position: index
    }))
  }
}

async function readyItem(f: ReturnType<typeof fixture>, input = snapshot()): Promise<string> {
  const session = createBatchImportSession(f.db, 'workbuddy')
  const itemId = createBatchImportItem(f.db, session.id, 0).id
  await saveOriginalZip(f.db, f.databasePath, itemId, f.zipPath)
  await saveStructuredSnapshot(f.db, f.databasePath, itemId, input)
  return itemId
}

function storedMessages(db: DatabaseSync): Array<{
  content: string; source_batch_id: string; source_position: number; stable_identity: string; fingerprint: string
}> {
  return db.prepare(`
    SELECT content, source_batch_id, source_position, stable_identity, fingerprint
    FROM messages ORDER BY source_position, id
  `).all() as unknown as ReturnType<typeof storedMessages>
}

function count(db: DatabaseSync, table: 'import_jobs' | 'messages' | 'messages_fts'): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

describe('alpha.15 已保存附件项确定性导入', () => {
  it('已准备附件项首次进入现有导入器，任务、消息和全文索引均正确', async () => {
    const f = fixture()
    const itemId = await readyItem(f)
    await expect(verifyBatchItemReadyForImport(f.db, f.databasePath, itemId)).rejects.toThrow('稳定来源批次')
    const result = await importSavedBatchItem(f.db, f.databasePath, itemId)
    const item = f.db.prepare('SELECT source_batch_id, status FROM batch_import_items WHERE id = ?').get(itemId) as {
      source_batch_id: string; status: string
    }
    expect(result).toMatchObject({ status: 'success', importedCount: 4, duplicateCount: 0 })
    expect(item).toEqual({ source_batch_id: `workbuddy:item:${itemId}`, status: 'success' })
    expect(f.db.prepare('SELECT batch_item_id FROM import_jobs WHERE id = ?').get(result.jobId)).toEqual({ batch_item_id: itemId })
    expect(storedMessages(f.db).map((row) => [row.content, row.source_position, row.source_batch_id])).toEqual([
      ['消息 A', 0, item.source_batch_id], ['消息 B', 1, item.source_batch_id],
      ['消息 C', 2, item.source_batch_id], ['消息 D', 3, item.source_batch_id]
    ])
    expect(count(f.db, 'messages_fts')).toBe(4)
    expect((await verifyBatchItemReadyForImport(f.db, f.databasePath, itemId)).sourceBatchId).toBe(item.source_batch_id)
  })

  it('导入任务在 INSERT 时已有 batch_item_id，不能依赖事后关联', async () => {
    const f = fixture()
    const itemId = await readyItem(f)
    f.db.exec(`
      CREATE TRIGGER require_batch_item_on_insert BEFORE INSERT ON import_jobs
      WHEN new.adapter = 'workbuddy' AND new.batch_item_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'batch_item_id must exist at insert'); END;
    `)
    const result = await importSavedBatchItem(f.db, f.databasePath, itemId)
    expect(result.status).toBe('success')
    expect(f.db.prepare('SELECT batch_item_id FROM import_jobs WHERE id = ?').get(result.jobId)).toEqual({ batch_item_id: itemId })
  })

  it('同一项两次执行保留两个任务，来源、顺序、稳定身份与指纹不漂移', async () => {
    const f = fixture()
    const itemId = await readyItem(f)
    const first = await importSavedBatchItem(f.db, f.databasePath, itemId)
    const before = storedMessages(f.db)
    const firstSource = (f.db.prepare('SELECT source_batch_id FROM batch_import_items WHERE id = ?').get(itemId) as { source_batch_id: string }).source_batch_id
    const second = await importSavedBatchItem(f.db, f.databasePath, itemId)
    const after = storedMessages(f.db)
    expect(first.jobId).not.toBe(second.jobId)
    expect(first).toMatchObject({ importedCount: 4, duplicateCount: 0 })
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 4 })
    expect(listBatchItemJobs(f.db, itemId).map((job) => job.id).sort()).toEqual([first.jobId, second.jobId].sort())
    expect((f.db.prepare('SELECT source_batch_id FROM batch_import_items WHERE id = ?').get(itemId) as { source_batch_id: string }).source_batch_id).toBe(firstSource)
    expect(after).toEqual(before)
    expect(after.map((row) => row.source_position)).toEqual([0, 1, 2, 3])
    expect(count(f.db, 'messages')).toBe(4)
    expect(count(f.db, 'messages_fts')).toBe(4)
  })

  it('关闭并重新打开数据库后再次执行仍复用已保存来源批次', async () => {
    const f = fixture()
    const itemId = await readyItem(f)
    const first = await importSavedBatchItem(f.db, f.databasePath, itemId)
    const source = first.sourceBatchId
    f.db.close()
    databases.pop()
    const reopened = new DatabaseSync(f.databasePath)
    databases.push(reopened)
    initializeDatabase(reopened)
    const second = await importSavedBatchItem(reopened, f.databasePath, itemId)
    expect(second.sourceBatchId).toBe(source)
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 4 })
    expect(listBatchItemJobs(reopened, itemId)).toHaveLength(2)
  })

  it('已存在的来源批次编号被原样复用，不被快照提示或新任务覆盖', async () => {
    const f = fixture()
    const itemId = await readyItem(f)
    f.db.prepare('UPDATE batch_import_items SET source_batch_id = ? WHERE id = ?').run('workbuddy:既有固定来源', itemId)
    const result = await importSavedBatchItem(f.db, f.databasePath, itemId)
    expect(result.sourceBatchId).toBe('workbuddy:既有固定来源')
    expect(storedMessages(f.db).every((row) => row.source_batch_id === 'workbuddy:既有固定来源')).toBe(true)
  })

  it('快照显式位置与数组顺序不一致时拒绝导入，不自行重排', async () => {
    const f = fixture()
    const input = snapshot()
    input.messages[1].source_position = 9
    const itemId = await readyItem(f, input)
    await expect(importSavedBatchItem(f.db, f.databasePath, itemId)).rejects.toThrow('原始位置与数组顺序不一致')
    expect(count(f.db, 'import_jobs')).toBe(0)
  })

  it.each(['missing', 'corrupt'] as const)('原始 ZIP %s 时拒绝导入且不创建任务', async (kind) => {
    const f = fixture()
    const itemId = await readyItem(f)
    const path = join(f.directory, 'evidence', itemId, 'original.zip')
    if (kind === 'missing') rmSync(path)
    else writeFileSync(path, '已篡改')
    await expect(importSavedBatchItem(f.db, f.databasePath, itemId)).rejects.toThrow('附件证据未准备好')
    expect(count(f.db, 'import_jobs')).toBe(0)
    expect(count(f.db, 'messages')).toBe(0)
  })

  it.each(['missing', 'corrupt', 'invalid_json'] as const)('结构化快照 %s 时拒绝导入且不创建任务', async (kind) => {
    const f = fixture()
    const itemId = await readyItem(f)
    const path = join(f.directory, 'evidence', itemId, 'messages.json')
    if (kind === 'missing') rmSync(path)
    else if (kind === 'corrupt') writeFileSync(path, '已篡改')
    else {
      const broken = Buffer.from('{无效 JSON', 'utf8')
      writeFileSync(path, broken)
      f.db.prepare('UPDATE batch_import_items SET snapshot_sha256 = ? WHERE id = ?')
        .run(createHash('sha256').update(broken).digest('hex'), itemId)
    }
    await expect(importSavedBatchItem(f.db, f.databasePath, itemId)).rejects.toThrow('附件证据未准备好')
    expect(count(f.db, 'import_jobs')).toBe(0)
    expect(count(f.db, 'messages_fts')).toBe(0)
  })

  it('不存在的附件项不产生任务', async () => {
    const f = fixture()
    await expect(importSavedBatchItem(f.db, f.databasePath, '不存在的附件项')).rejects.toThrow('附件项不存在')
    expect(count(f.db, 'import_jobs')).toBe(0)
  })

  it('导入器返回失败时保留真实任务并记录附件项失败状态', async () => {
    const f = fixture()
    const itemId = await readyItem(f, { messages: [{ content: '时间无效但正文存在', timestamp: '错误时间' }] })
    const result = await importSavedBatchItem(f.db, f.databasePath, itemId)
    expect(result.status).toBe('failed')
    expect(result.invalidCount).toBe(1)
    expect(f.db.prepare('SELECT status, batch_item_id FROM import_jobs WHERE id = ?').get(result.jobId)).toEqual({
      status: 'failed', batch_item_id: itemId
    })
    expect(f.db.prepare('SELECT status FROM batch_import_items WHERE id = ?').get(itemId)).toEqual({ status: 'failed' })
  })

  it('导入器部分成功时附件项保持部分成功，已写入消息不回滚', async () => {
    const f = fixture()
    const itemId = await readyItem(f, { messages: [{ content: '有效消息' }, { sender_name: '缺正文' }] })
    const result = await importSavedBatchItem(f.db, f.databasePath, itemId)
    expect(result).toMatchObject({ status: 'partial', importedCount: 1, invalidCount: 1 })
    expect(f.db.prepare('SELECT status FROM batch_import_items WHERE id = ?').get(itemId)).toEqual({ status: 'partial_success' })
    expect(count(f.db, 'messages')).toBe(1)
    expect(count(f.db, 'messages_fts')).toBe(1)
  })

  it('导入器已提交后后续元数据登记抛错时不回滚真实消息和任务', async () => {
    const f = fixture()
    const itemId = await readyItem(f)
    f.db.exec(`
      CREATE TRIGGER fail_batch_metadata BEFORE INSERT ON message_import_batches
      BEGIN SELECT RAISE(ABORT, 'batch metadata failed'); END;
    `)
    await expect(importSavedBatchItem(f.db, f.databasePath, itemId)).rejects.toThrow('batch metadata failed')
    expect(count(f.db, 'import_jobs')).toBe(1)
    expect(count(f.db, 'messages')).toBe(4)
    expect(count(f.db, 'messages_fts')).toBe(4)
    expect(f.db.prepare('SELECT status, batch_item_id FROM import_jobs').get()).toEqual({
      status: 'success', batch_item_id: itemId
    })
    expect(f.db.prepare('SELECT status FROM batch_import_items WHERE id = ?').get(itemId)).toEqual({ status: 'failed' })
  })

  it('普通导入不传附件项编号时保持空关联和原有去重、身份及全文索引行为', () => {
    const f = fixture()
    const content = JSON.stringify([
      { platform: 'wechat', conversation_name: '普通群', sender_name: '甲',
        timestamp: '2026-09-24 10:00', content: '普通导入消息' }
    ])
    const first = importChatContent(f.db, 'normal.json', 'JSON', content)
    const before = storedMessages(f.db)
    const second = importChatContent(f.db, 'normal.json', 'JSON', content)
    expect(first).toMatchObject({ importedCount: 1, duplicateCount: 0 })
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 1 })
    expect(f.db.prepare('SELECT batch_item_id FROM import_jobs WHERE id = ?').get(first.jobId)).toEqual({ batch_item_id: null })
    expect(f.db.prepare('SELECT batch_item_id FROM import_jobs WHERE id = ?').get(second.jobId)).toEqual({ batch_item_id: null })
    expect(storedMessages(f.db)).toEqual(before)
    expect(before[0].source_position).toBe(0)
    expect(before[0].source_batch_id).toMatch(/^file:/)
    expect(before[0].stable_identity).toMatch(/^identity:/)
    expect(before[0].fingerprint).toHaveLength(64)
    expect(count(f.db, 'messages_fts')).toBe(1)
  })

  it('相同 ZIP 与快照的两个附件项仍有独立任务和来源身份', async () => {
    const f = fixture()
    const session = createBatchImportSession(f.db, 'workbuddy')
    const a = createBatchImportItem(f.db, session.id, 0)
    const b = createBatchImportItem(f.db, session.id, 1)
    for (const value of [a, b]) {
      await saveOriginalZip(f.db, f.databasePath, value.id, f.zipPath)
      await saveStructuredSnapshot(f.db, f.databasePath, value.id, snapshot())
    }
    const first = await importSavedBatchItem(f.db, f.databasePath, a.id)
    const second = await importSavedBatchItem(f.db, f.databasePath, b.id)
    expect(first.sourceBatchId).not.toBe(second.sourceBatchId)
    expect(first.jobId).not.toBe(second.jobId)
    expect(listBatchItemJobs(f.db, a.id).map((job) => job.id)).toEqual([first.jobId])
    expect(listBatchItemJobs(f.db, b.id).map((job) => job.id)).toEqual([second.jobId])
    expect(count(f.db, 'messages')).toBe(8)
  })
})
