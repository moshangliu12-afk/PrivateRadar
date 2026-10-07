import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { saveOriginalZip, saveStructuredSnapshot } from '../src/main/batch-import/evidence'
import { importSavedBatchItem } from '../src/main/batch-import/import-item'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { executeBatchImportSession, getBatchImportSessionSummary, resumeInterruptedBatchImportSession } from '../src/main/batch-import/session'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-session-'))
  directories.push(directory)
  const databasePath = join(directory, 'private-radar.db')
  const db = new DatabaseSync(databasePath)
  databases.push(db)
  initializeDatabase(db)
  const zipPath = join(directory, 'source.zip')
  const bytes = Buffer.alloc(22)
  bytes.write('PK\u0005\u0006', 0, 'binary')
  writeFileSync(zipPath, bytes)
  const session = createBatchImportSession(db, 'workbuddy')
  const a = createBatchImportItem(db, session.id, 0)
  const b = createBatchImportItem(db, session.id, 1)
  return { db, databasePath, zipPath, session, a, b }
}

async function prepare(f: ReturnType<typeof fixture>, itemId: string, count: number) {
  await saveOriginalZip(f.db, f.databasePath, itemId, f.zipPath)
  await saveStructuredSnapshot(f.db, f.databasePath, itemId, {
    messages: Array.from({ length: count }, (_, index) => ({
      platform: 'wechat', sender_name: '甲', content: `来自 ${itemId} 的消息 ${index}`,
      timestamp: `2026-09-26T10:${String(index).padStart(2, '0')}:00+08:00`,
      timestamp_source: 'source_native' as const, source_position: index
    }))
  })
}

function count(db: DatabaseSync, table: 'messages' | 'messages_fts' | 'import_jobs') {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

describe('单附件及双附件会话编排', () => {
  it('一个真实附件复用同一会话与证据编排，汇总按一个附件计算', async () => {
    const f = fixture()
    f.db.prepare('DELETE FROM batch_import_items WHERE id=?').run(f.b.id)
    await prepare(f, f.a.id, 4)
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'success', attachments_total: 1, attachments_completed: 1,
      input_messages_total: 4, imported_total: 4, failed_attachments: 0, attention_required_attachments: 0 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ item_id: f.a.id, ordinal: 0, outcome: 'success' })
    expect(f.db.prepare('SELECT batch_item_id FROM import_jobs').all()).toEqual([{ batch_item_id: f.a.id }])
    expect(count(f.db, 'messages')).toBe(4)
    expect(count(f.db, 'messages_fts')).toBe(4)
  })

  it('单附件显式中断恢复只使用已保存证据与原有任务边界', async () => {
    const f = fixture()
    f.db.prepare('DELETE FROM batch_import_items WHERE id=?').run(f.b.id)
    await prepare(f, f.a.id, 3)
    f.db.prepare("UPDATE batch_import_sessions SET status='in_progress',completed_at=NULL WHERE id=?").run(f.session.id)
    const result = await resumeInterruptedBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'success', attachments_total: 1, attachments_completed: 1, imported_total: 3 })
    expect(result.items).toHaveLength(1)
    expect(count(f.db, 'import_jobs')).toBe(1)
    expect(count(f.db, 'messages')).toBe(3)
  })

  it.each([0, 3])('%s 个附件的会话首次执行仍在写入前拒绝', async total => {
    const f = fixture()
    if (total === 0) f.db.prepare('DELETE FROM batch_import_items WHERE batch_session_id=?').run(f.session.id)
    else createBatchImportItem(f.db, f.session.id, 2)
    await expect(executeBatchImportSession(f.db, f.databasePath, f.session.id)).rejects.toThrow('一个或两个附件项')
    expect(f.db.prepare('SELECT status FROM batch_import_sessions WHERE id=?').get(f.session.id)).toEqual({ status: 'pending' })
    expect(count(f.db, 'import_jobs')).toBe(0)
    expect(count(f.db, 'messages')).toBe(0)
  })

  it('两个附件顺序执行并成功，汇总与数据库均为 3 + 6', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'success', attachments_total: 2, attachments_completed: 2,
      input_messages_total: 9, imported_total: 9, duplicate_total: 0, failed_attachments: 0,
      attention_required_attachments: 0 })
    expect(result.items.map((item) => [item.ordinal, item.outcome, item.imported])).toEqual([
      [0, 'success', 3], [1, 'success', 6]
    ])
    expect(f.db.prepare('SELECT batch_item_id FROM import_jobs ORDER BY rowid').all()).toEqual([
      { batch_item_id: f.a.id }, { batch_item_id: f.b.id }
    ])
    expect(count(f.db, 'messages')).toBe(9)
    expect(count(f.db, 'messages_fts')).toBe(9)
    expect(f.db.prepare('SELECT completed_at FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toMatchObject({ completed_at: expect.any(String) })
    await expect(executeBatchImportSession(f.db, f.databasePath, f.session.id)).rejects.toThrow('not_pending')
    expect(count(f.db, 'import_jobs')).toBe(2)
  })

  it('一个成功、另一个快照损坏时，已成功消息保留且未知输入数量不伪装为零', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    writeFileSync(join(f.databasePath, '..', 'evidence', f.b.id, 'messages.json'), 'corrupt')
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'partial_success', attachments_completed: 2,
      input_messages_total: null, imported_total: 3, failed_attachments: 1, attention_required_attachments: 0 })
    expect(result.items.map((item) => item.outcome)).toEqual(['success', 'failed_zero_write'])
    expect(count(f.db, 'import_jobs')).toBe(1)
    expect(count(f.db, 'messages')).toBe(3)
  })

  it('第二附件写入后元数据失败，任务与真实写入保留并要求人工处理', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    f.db.exec(`
      CREATE TRIGGER fail_b_metadata BEFORE INSERT ON message_import_batches
      WHEN NEW.source_batch_id = 'workbuddy:item:${f.b.id}'
      BEGIN SELECT RAISE(ABORT, 'batch metadata failed'); END;
    `)
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'partial_success', imported_total: 9,
      failed_attachments: 0, attention_required_attachments: 1 })
    expect(result.items.map((item) => item.outcome)).toEqual(['success', 'needs_attention'])
    expect(result.items[1]).toMatchObject({ imported: 6, written_messages: 6, indexed_messages: 6 })
    expect(f.db.prepare('SELECT status FROM import_jobs WHERE id = ?').get(result.items[1].effective_job_id!)).toEqual({ status: 'success' })
    expect(f.db.prepare('SELECT status FROM batch_import_items WHERE id = ?').get(f.b.id)).toEqual({ status: 'failed' })
    expect(count(f.db, 'messages')).toBe(9)
    expect(count(f.db, 'messages_fts')).toBe(9)
  })

  it('两个证据失败时无任务或消息，会话失败', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    rmSync(join(f.databasePath, '..', 'evidence', f.a.id, 'messages.json'))
    writeFileSync(join(f.databasePath, '..', 'evidence', f.b.id, 'original.zip'), 'corrupt')
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'failed', attachments_completed: 2,
      input_messages_total: null, imported_total: 0, failed_attachments: 2 })
    expect(count(f.db, 'import_jobs')).toBe(0)
    expect(count(f.db, 'messages')).toBe(0)
  })

  it('导入器部分写入及无效消息按有效任务计数，并归为需关注', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await saveOriginalZip(f.db, f.databasePath, f.b.id, f.zipPath)
    await saveStructuredSnapshot(f.db, f.databasePath, f.b.id, {
      messages: [{ content: '有效正文' }, { sender_name: '缺正文' }]
    })
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'partial_success', input_messages_total: 5,
      imported_total: 4, invalid_total: 1, failed_attachments: 0, attention_required_attachments: 1 })
    expect(result.items[1].outcome).toBe('needs_attention')
    expect(count(f.db, 'messages')).toBe(4)
  })

  it('首次会话拒绝两个附件共用同一个来源批次编号', async () => {
    const f = fixture()
    f.db.prepare('UPDATE batch_import_items SET source_batch_id = ? WHERE id IN (?, ?)').run('shared', f.a.id, f.b.id)
    await expect(executeBatchImportSession(f.db, f.databasePath, f.session.id)).rejects.toThrow('不能共用来源批次编号')
    expect(f.db.prepare('SELECT status FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toEqual({ status: 'pending' })
  })

  it('有效任务指针只采用当前结果，不累计同一附件的历史任务', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 4)
    await prepare(f, f.b.id, 1)
    const first = await importSavedBatchItem(f.db, f.databasePath, f.a.id)
    const second = await importSavedBatchItem(f.db, f.databasePath, f.a.id, 'deterministic_replay')
    expect(first.importedCount).toBe(4)
    expect(second.duplicateCount).toBe(4)
    f.db.prepare('UPDATE batch_import_items SET effective_job_id = ? WHERE id = ?').run(second.jobId, f.a.id)
    const result = await getBatchImportSessionSummary(f.db, f.databasePath, f.session.id)
    expect(result.items[0]).toMatchObject({ imported: 0, duplicate: 4, effective_job_id: second.jobId })
    expect(result).toMatchObject({ imported_total: 0, duplicate_total: 4, input_messages_total: 5 })
    expect(f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ? ORDER BY rowid').all(f.a.id)).toEqual([
      { id: first.jobId }, { id: second.jobId }
    ])
  })

  it('两个附件都在真实写入后出现元数据异常时，会话为部分成功', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    f.db.exec(`CREATE TRIGGER fail_all_metadata BEFORE INSERT ON message_import_batches
      BEGIN SELECT RAISE(ABORT, 'metadata failed'); END;`)
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'partial_success', imported_total: 9,
      attention_required_attachments: 2, failed_attachments: 0 })
    expect(result.items.map((item) => item.outcome)).toEqual(['needs_attention', 'needs_attention'])
    expect(count(f.db, 'messages')).toBe(9)
    expect(count(f.db, 'messages_fts')).toBe(9)
  })

  it('一个附件写入后需关注，另一个零写入失败时仍为部分成功', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    f.db.exec(`CREATE TRIGGER fail_a_metadata BEFORE INSERT ON message_import_batches
      WHEN NEW.source_batch_id = 'workbuddy:item:${f.a.id}'
      BEGIN SELECT RAISE(ABORT, 'metadata failed'); END;`)
    writeFileSync(join(f.databasePath, '..', 'evidence', f.b.id, 'messages.json'), 'corrupt')
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'partial_success', imported_total: 3,
      failed_attachments: 1, attention_required_attachments: 1 })
    expect(count(f.db, 'messages')).toBe(3)
  })

  it('两个附件全部确定性去重时仍为成功，未新增不等于失败', async () => {
    const f = fixture()
    for (const [item, total] of [[f.a, 3], [f.b, 6]] as const) {
      const messages = Array.from({ length: total }, (_, index) => ({
        platform: 'wechat', sender_name: '甲', content: `去重 ${item.id} ${index}`,
        source_message_id: `${item.id}:${index}`
      }))
      const seed = ingestWorkBuddyMessages(f.db, { source_batch_id: `seed:${item.id}`, messages })
      expect(seed.importedCount).toBe(total)
      await saveOriginalZip(f.db, f.databasePath, item.id, f.zipPath)
      await saveStructuredSnapshot(f.db, f.databasePath, item.id, { messages })
    }
    const before = count(f.db, 'messages')
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'success', imported_total: 0, duplicate_total: 9,
      failed_attachments: 0, attention_required_attachments: 0 })
    expect(result.items.map((item) => item.outcome)).toEqual(['success', 'success'])
    expect(count(f.db, 'messages')).toBe(before)
  })

  it('跨来源强身份重复不补写旧时间，仍通过来源关系保持成功', async () => {
    const f = fixture()
    for (const item of [f.a, f.b]) {
      const sourceId = `updated:${item.id}`
      ingestWorkBuddyMessages(f.db, { source_batch_id: `seed:${item.id}`, messages: [
        { content: `更新 ${item.id}`, source_message_id: sourceId }
      ] })
      await saveOriginalZip(f.db, f.databasePath, item.id, f.zipPath)
      await saveStructuredSnapshot(f.db, f.databasePath, item.id, { messages: [
        { content: `更新 ${item.id}`, source_message_id: sourceId,
          timestamp: '2026-09-26T10:00:00+08:00', timestamp_source: 'source_native' }
      ] })
    }
    const before = f.db.prepare('SELECT * FROM messages ORDER BY id').all()
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'success', imported_total: 0, duplicate_total: 2, updated_total: 0,
      failed_attachments: 0, attention_required_attachments: 0 })
    expect(f.db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before)
  })

  it('中断后只恢复尚未开始的第二附件，第一附件任务和消息保持不变', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    const first = await importSavedBatchItem(f.db, f.databasePath, f.a.id)
    f.db.prepare("UPDATE batch_import_sessions SET status = 'in_progress', completed_at = NULL WHERE id = ?").run(f.session.id)
    expect(f.db.prepare('SELECT completed_at FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toEqual({ completed_at: null })
    const result = await resumeInterruptedBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'success', imported_total: 9, attachments_completed: 2 })
    expect(f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').all(f.a.id)).toEqual([{ id: first.jobId }])
    expect(f.db.prepare('SELECT effective_job_id FROM batch_import_items WHERE id = ?').get(f.a.id)).toEqual({ effective_job_id: first.jobId })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE source_batch_id = ?').get(first.sourceBatchId)).toEqual({ count: 3 })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE batch_item_id = ?').get(f.b.id)).toEqual({ count: 1 })
    expect(f.db.prepare('SELECT completed_at FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toMatchObject({ completed_at: expect.any(String) })
  })

  it('已有写入且需关注的第一附件不重放，仍可安全执行未开始的第二附件', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    f.db.exec(`CREATE TRIGGER fail_a_metadata BEFORE INSERT ON message_import_batches
      WHEN NEW.source_batch_id = 'workbuddy:item:${f.a.id}'
      BEGIN SELECT RAISE(ABORT, 'metadata failed'); END;`)
    await expect(importSavedBatchItem(f.db, f.databasePath, f.a.id)).rejects.toThrow('metadata failed')
    const originalJob = (f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').get(f.a.id) as { id: string }).id
    f.db.prepare("UPDATE batch_import_sessions SET status = 'in_progress', completed_at = NULL WHERE id = ?").run(f.session.id)
    const result = await resumeInterruptedBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'partial_success', imported_total: 9, attention_required_attachments: 1 })
    expect(result.items[0]).toMatchObject({ outcome: 'needs_attention', effective_job_id: originalJob })
    expect(f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').all(f.a.id)).toEqual([{ id: originalJob }])
    expect(f.db.prepare('SELECT completed_at FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toMatchObject({ completed_at: expect.any(String) })
  })

  it('有任务却仍标为待处理的附件视为不一致，恢复拒绝自动执行', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    const first = await importSavedBatchItem(f.db, f.databasePath, f.a.id)
    f.db.prepare("UPDATE batch_import_items SET status = 'pending' WHERE id = ?").run(f.a.id)
    f.db.prepare("UPDATE batch_import_sessions SET status = 'in_progress', completed_at = NULL WHERE id = ?").run(f.session.id)
    await expect(resumeInterruptedBatchImportSession(f.db, f.databasePath, f.session.id)).rejects.toThrow('需人工处理')
    expect(f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').all(f.a.id)).toEqual([{ id: first.jobId }])
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE batch_item_id = ?').get(f.b.id)).toEqual({ count: 0 })
    expect(f.db.prepare('SELECT completed_at FROM batch_import_sessions WHERE id = ?').get(f.session.id)).toEqual({ completed_at: null })
  })

  it('已有任务但附件仍处于处理中时，恢复拒绝猜测执行结果', async () => {
    const f = fixture()
    await prepare(f, f.a.id, 3)
    await prepare(f, f.b.id, 6)
    const first = await importSavedBatchItem(f.db, f.databasePath, f.a.id)
    f.db.prepare("UPDATE batch_import_items SET status = 'in_progress' WHERE id = ?").run(f.a.id)
    f.db.prepare("UPDATE batch_import_sessions SET status = 'in_progress', completed_at = NULL WHERE id = ?").run(f.session.id)
    await expect(resumeInterruptedBatchImportSession(f.db, f.databasePath, f.session.id)).rejects.toThrow('需人工处理')
    expect(f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').all(f.a.id)).toEqual([{ id: first.jobId }])
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE batch_item_id = ?').get(f.b.id)).toEqual({ count: 0 })
  })

  it.each(['success', 'partial_success', 'failed'])('终态 %s 会话拒绝恢复', async (status) => {
    const f = fixture()
    f.db.prepare('UPDATE batch_import_sessions SET status = ? WHERE id = ?').run(status, f.session.id)
    await expect(resumeInterruptedBatchImportSession(f.db, f.databasePath, f.session.id)).rejects.toThrow('仅执行中')
  })
})
