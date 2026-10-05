import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { migrateBatchImportSchema } from '../src/main/batch-import/schema'
import { attachImportJobToBatchItem, createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { importChatContent } from '../src/main/import/importer'
import { bindSession, createCollection, getCollection, listCollectionSessions } from '../src/main/collections/service'

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) {
    expect(resolve(directory)).toBe(directory)
    expect(resolve(directory, '..')).toBe(resolve(tmpdir()))
    expect(basename(directory).startsWith('privateradar-collection-schema-')).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

function database(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path)
  databases.push(db)
  return db
}

function tableFingerprints(db: DatabaseSync, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map((row) => {
      const copy = { ...row }
      if (name === 'batch_import_sessions') delete copy.collection_id
      return JSON.stringify(copy, (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value)
    }).sort()
    return [name, createHash('sha256').update(JSON.stringify(rows)).digest('hex')]
  }))
}

function healthy(db: DatabaseSync): void {
  expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
}

describe('归集结构版本 5 隔离迁移', () => {
  it('从冻结的真实版本 4 结构迁移，只新增归集结构，所有旧数据及全文索引保持原样', () => {
    const directory = mkdtempSync(join(tmpdir(), 'privateradar-collection-schema-'))
    directories.push(directory)
    const db = database(join(directory, '旧库.db'))
    db.exec(readFileSync(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8'))
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'collections'").get()).toBeUndefined()
    expect(db.prepare('PRAGMA table_info(batch_import_sessions)').all().map((column) => column.name))
      .toEqual(['id', 'source', 'status', 'created_at', 'updated_at', 'completed_at'])
    const first = createBatchImportSession(db, 'workbuddy')
    const second = createBatchImportSession(db, 'workbuddy')
    const item = createBatchImportItem(db, first.id, 0, '旧附件.zip')
    createBatchImportItem(db, second.id, 0, '旧目录')
    const job = importChatContent(db, '旧聊天.json', 'JSON', JSON.stringify([
      { conversation_name: '旧群', sender_name: '甲', timestamp: '2026-10-04 09:00', content: 'legacyfts 安吉星' },
      { conversation_name: '旧群', sender_name: '乙', timestamp: '2026-10-04 09:01', content: 'legacyfts 主动安全' }
    ]))
    attachImportJobToBatchItem(db, job.jobId, item.id)
    db.prepare(`UPDATE batch_import_items SET evidence_relative_path = 'evidence/旧附件/original.zip',
      snapshot_relative_path = 'evidence/旧附件/messages.json', snapshot_sha256 = ?,
      evidence_status = 'available', effective_job_id = ? WHERE id = ?`).run('a'.repeat(64), job.jobId, item.id)
    const evidencePath = join(directory, '隔离证据.zip')
    writeFileSync(evidencePath, Buffer.from('仅用于隔离迁移验证的合成证据'))
    const evidenceBefore = createHash('sha256').update(readFileSync(evidencePath)).digest('hex')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((row) => String(row.name))
    const before = tableFingerprints(db, tables)
    const objects = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'batch_import_sessions' ORDER BY name").all()
    const sessionsBefore = db.prepare('SELECT * FROM batch_import_sessions ORDER BY id').all()
    const rowidsBefore = db.prepare('SELECT rowid, * FROM messages ORDER BY rowid').all()
    const ftsBefore = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'legacyfts' ORDER BY rowid").all()

    migrateBatchImportSchema(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
    expect(tableFingerprints(db, tables)).toEqual(before)
    expect(db.prepare('SELECT * FROM batch_import_sessions ORDER BY id').all())
      .toEqual(sessionsBefore.map((session) => ({ ...session, collection_id: null })))
    expect(db.prepare('SELECT rowid, * FROM messages ORDER BY rowid').all()).toEqual(rowidsBefore)
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'legacyfts' ORDER BY rowid").all()).toEqual(ftsBefore)
    expect(ftsBefore).toHaveLength(2)
    for (const object of objects) {
      expect(db.prepare('SELECT name, type, sql FROM sqlite_master WHERE name = ?').get(String(object.name))).toEqual(object)
    }
    expect(createHash('sha256').update(readFileSync(evidencePath)).digest('hex')).toBe(evidenceBefore)
    initializeDatabase(db)
    initializeDatabase(db)
    expect(tableFingerprints(db, tables)).toEqual(before)
    healthy(db)
  })

  it('全新数据库直接初始化版本 5，仅有五个归集字段、两种状态、可空外键与查询索引', () => {
    const db = database()
    initializeDatabase(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
    expect(db.prepare('PRAGMA table_info(collections)').all().map((column) => [column.name, column.type, column.notnull, column.pk]))
      .toEqual([['id', 'TEXT', 0, 1], ['display_name', 'TEXT', 1, 0], ['status', 'TEXT', 1, 0],
        ['created_at', 'TEXT', 1, 0], ['completed_at', 'TEXT', 0, 0]])
    expect(db.prepare('PRAGMA table_info(batch_import_sessions)').all().find((column) => column.name === 'collection_id'))
      .toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    expect(db.prepare('PRAGMA foreign_key_list(batch_import_sessions)').all())
      .toEqual([expect.objectContaining({ table: 'collections', from: 'collection_id', to: 'id', on_delete: 'RESTRICT' })])
    expect(db.prepare('PRAGMA index_info(idx_batch_import_sessions_collection)').all().map((column) => column.name))
      .toEqual(['collection_id', 'created_at', 'id'])
    const collection = createCollection(db, '约束测试')
    expect(() => db.prepare("UPDATE collections SET status = 'failed' WHERE id = ?").run(collection.id)).toThrow()
    const session = createBatchImportSession(db, 'workbuddy')
    expect(() => db.prepare('UPDATE batch_import_sessions SET collection_id = ? WHERE id = ?').run('不存在', session.id)).toThrow()
    bindSession(db, collection.id, session.id)
    expect(() => db.prepare('DELETE FROM collections WHERE id = ?').run(collection.id)).toThrow()
    healthy(db)
  })

  it('重新初始化和重新打开不重复迁移，不破坏归集和会话关联', () => {
    const directory = mkdtempSync(join(tmpdir(), 'privateradar-collection-schema-'))
    directories.push(directory)
    const path = join(directory, '持久库.db')
    const db = database(path)
    initializeDatabase(db)
    const collection = createCollection(db, '跨启动')
    const session = bindSession(db, collection.id, createBatchImportSession(db, 'workbuddy').id)
    const before = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()
    initializeDatabase(db)
    initializeDatabase(db)
    expect(db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(before)
    db.close()
    databases.pop()
    const reopened = database(path)
    initializeDatabase(reopened)
    expect(getCollection(reopened, collection.id)).toEqual(collection)
    expect(listCollectionSessions(reopened, collection.id)).toEqual([session])
    healthy(reopened)
  })

  it('迁移中途失败时回滚新增结构与版本，旧表不受影响', () => {
    const db = database()
    db.exec(readFileSync(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8'))
    const session = createBatchImportSession(db, 'workbuddy')
    // 隔离构造名称冲突，强制让事务在新增列之后失败，验证原子回滚。
    db.exec('CREATE TABLE idx_batch_import_sessions_collection (id TEXT)')
    expect(() => migrateBatchImportSchema(db)).toThrow()
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'collections'").get()).toBeUndefined()
    expect(db.prepare('SELECT * FROM batch_import_sessions').get()).toEqual(session)
    expect(db.prepare('PRAGMA table_info(batch_import_sessions)').all().some((column) => column.name === 'collection_id')).toBe(false)
    healthy(db)
  })
})
