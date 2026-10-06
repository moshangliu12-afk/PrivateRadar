import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { importChatContent } from '../src/main/import/importer'
import { prepareSchemaV6Fixture } from './schema-v6-fixture'
import {
  attachImportJobToBatchItem,
  createBatchImportItem,
  createBatchImportSession,
  listBatchImportItems,
  listBatchItemJobs
} from '../src/main/batch-import/repository'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-batch-schema-'))
  directories.push(directory)
  const db = new DatabaseSync(join(directory, '测试.db'))
  initializeDatabase(db)
  databases.push(db)
  return db
}

function recordSnapshot(db: DatabaseSync, itemId: string): string {
  const messages = db.prepare('SELECT content, source_position, source_batch_id FROM messages ORDER BY source_position').all()
  const main = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')!
  const relativePath = `evidence/${itemId}/messages.json`
  const bytes = Buffer.from(JSON.stringify({ schema_version: 1, input: { messages } }))
  mkdirSync(join(dirname(String(main.file)), 'evidence', itemId), { recursive: true })
  writeFileSync(join(dirname(String(main.file)), relativePath), bytes)
  db.prepare('UPDATE batch_import_items SET snapshot_relative_path = ?, snapshot_sha256 = ?, source_batch_id = ? WHERE id = ?')
    .run(relativePath, createHash('sha256').update(bytes).digest('hex'), messages[0].source_batch_id, itemId)
  return createHash('sha256').update(bytes).digest('hex')
}

// 以 alpha.14 的相关表结构构造隔离旧库；其余表由原有初始化逻辑补齐。
function alpha14Database(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL,
      conversation_type TEXT NOT NULL DEFAULT 'group', created_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      conversation_name TEXT, sender_id TEXT NOT NULL, sender_name TEXT,
      timestamp TEXT, content TEXT NOT NULL, message_type TEXT NOT NULL,
      links_json TEXT NOT NULL DEFAULT '[]', attachments_json TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT, source TEXT NOT NULL, raw_metadata_json TEXT NOT NULL DEFAULT '{}',
      source_message_id TEXT, stable_identity TEXT,
      source_batch_id TEXT NOT NULL DEFAULT '', source_position INTEGER NOT NULL DEFAULT 0,
      conversation_name_source TEXT NOT NULL DEFAULT 'source_native',
      sender_name_source TEXT NOT NULL DEFAULT 'source_native',
      timestamp_source TEXT NOT NULL DEFAULT 'source_native',
      content_source TEXT NOT NULL DEFAULT 'source_native',
      fingerprint TEXT NOT NULL UNIQUE, import_job_id TEXT, imported_at TEXT NOT NULL
    );
    CREATE TABLE import_jobs (
      id TEXT PRIMARY KEY, adapter TEXT NOT NULL, source_name TEXT NOT NULL,
      file_type TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      recognized_count INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      error_details_json TEXT NOT NULL DEFAULT '[]',
      cursor_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE message_import_batches (
      source_batch_id TEXT PRIMARY KEY,
      import_job_id TEXT REFERENCES import_jobs(id),
      import_mode TEXT NOT NULL DEFAULT 'quick', imported_at TEXT NOT NULL,
      first_attempt_at TEXT, last_attempt_at TEXT, last_success_at TEXT,
      conversation_name TEXT,
      conversation_name_source TEXT NOT NULL DEFAULT 'unknown',
      approximate_date TEXT,
      approximate_date_source TEXT NOT NULL DEFAULT 'unknown',
      sender_mapping_json TEXT,
      completeness_level TEXT NOT NULL DEFAULT 'content_only'
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content, conversation_name, sender_name,
      content='messages', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, conversation_name, sender_name)
      VALUES (new.rowid, new.content, new.conversation_name, new.sender_name);
    END;
    INSERT INTO conversations (id, platform, name, created_at)
    VALUES ('legacy-conversation', 'wechat', '旧群', '2026-09-01T00:00:00Z');
    INSERT INTO import_jobs (id, adapter, source_name, status, started_at, completed_at)
    VALUES ('legacy-job', 'workbuddy', 'workbuddy-mcp.json', 'success',
      '2026-09-01T00:00:00Z', '2026-09-01T00:00:01Z');
    INSERT INTO message_import_batches (source_batch_id, import_job_id, imported_at)
    VALUES ('legacy-batch', 'legacy-job', '2026-09-01T00:00:00Z');
    INSERT INTO messages (
      id, platform, conversation_id, sender_id, content, message_type,
      source, source_batch_id, source_position, fingerprint, import_job_id, imported_at
    ) VALUES (
      'legacy-message', 'wechat', 'legacy-conversation', 'legacy-sender',
      'legacyfts 旧库全文索引仍可检索', 'text', 'workbuddy', 'legacy-batch', 0,
      'legacy-fingerprint', 'legacy-job', '2026-09-01T00:00:00Z'
    );
  `)
  return db
}

describe('alpha.15 批量数据模型', () => {
  it('版本 3 仅增加来源类型，旧 ZIP 路径、哈希、有效任务与快照指针原样保留', () => {
    const db = database()
    const session = createBatchImportSession(db, 'workbuddy')
    const item = createBatchImportItem(db, session.id, 0, '旧附件.zip', 'a'.repeat(64))
    const job = importChatContent(db, '旧任务.json', 'JSON', JSON.stringify([
      { conversation_name: '旧群', sender_name: '甲', timestamp: '2026-09-01 09:00', content: '保持消息和全文索引' }
    ]))
    attachImportJobToBatchItem(db, job.jobId, item.id)
    const snapshotHash = recordSnapshot(db, item.id)
    db.prepare(`UPDATE batch_import_items SET evidence_relative_path = ?, evidence_status = 'available',
      snapshot_relative_path = ?, snapshot_sha256 = ?, source_batch_id = ?, effective_job_id = ? WHERE id = ?`
    ).run(`evidence/${item.id}/original.zip`, `evidence/${item.id}/messages.json`, snapshotHash,
      db.prepare('SELECT source_batch_id FROM messages').get()!.source_batch_id, job.jobId, item.id)
    prepareSchemaV6Fixture(db)
    db.exec('ALTER TABLE batch_import_items DROP COLUMN evidence_source_kind; PRAGMA user_version = 3')
    const before = db.prepare('SELECT * FROM batch_import_items').get()
    initializeDatabase(db)
    initializeDatabase(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    expect(db.prepare('SELECT * FROM batch_import_items').get()).toEqual({ ...before, evidence_source_kind: 'zip' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT batch_item_id FROM import_jobs WHERE id = ?').get(job.jobId)).toEqual({ batch_item_id: item.id })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('新数据库默认 ZIP、仅接受两种来源；重复迁移与高版本不降级', () => {
    const db = database()
    const session = createBatchImportSession(db, 'workbuddy')
    const item = createBatchImportItem(db, session.id, 0)
    expect(item.evidence_source_kind).toBe('zip')
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    db.prepare("UPDATE batch_import_items SET evidence_source_kind = 'directory' WHERE id = ?").run(item.id)
    expect(() => db.prepare("UPDATE batch_import_items SET evidence_source_kind = 'invalid' WHERE id = ?").run(item.id)).toThrow()
    initializeDatabase(db)
    expect(listBatchImportItems(db, session.id)[0].evidence_source_kind).toBe('directory')
    db.exec('PRAGMA user_version = 8')
    initializeDatabase(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
  })

  it('升级隔离 alpha.14 数据库并在重新打开后保留旧消息、任务、批次和全文索引', () => {
    const directory = mkdtempSync(join(tmpdir(), 'privateradar-batch-schema-'))
    directories.push(directory)
    const path = join(directory, 'legacy.db')
    const legacy = alpha14Database(path)
    expect(legacy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    legacy.close()

    const upgraded = new DatabaseSync(path)
    databases.push(upgraded)
    initializeDatabase(upgraded)
    initializeDatabase(upgraded)
    expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    expect(upgraded.prepare('SELECT id, source_batch_id, source_position, fingerprint FROM messages').get()).toEqual({
      id: 'legacy-message', source_batch_id: 'legacy-batch', source_position: 0, fingerprint: 'legacy-fingerprint'
    })
    expect(upgraded.prepare('SELECT id, batch_item_id FROM import_jobs').get()).toEqual({ id: 'legacy-job', batch_item_id: null })
    expect(upgraded.prepare('SELECT source_batch_id, import_job_id FROM message_import_batches').get()).toEqual({
      source_batch_id: 'legacy-batch', import_job_id: 'legacy-job'
    })
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'legacyfts'").get()).toEqual({ count: 1 })
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'batch_import_sessions'").get()).toBeTruthy()
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'batch_import_items'").get()).toBeTruthy()
    upgraded.close()
    databases.pop()

    const reopened = new DatabaseSync(path)
    databases.push(reopened)
    initializeDatabase(reopened)
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    reopened.close()
    databases.pop()
  })

  it('一个会话容纳两项，相同附件哈希仍是不同实例，并约束顺序和状态', () => {
    const db = database()
    const session = createBatchImportSession(db, 'workbuddy')
    const hash = 'a'.repeat(64)
    const first = createBatchImportItem(db, session.id, 0, '甲.zip', hash)
    const second = createBatchImportItem(db, session.id, 1, '乙.zip', hash)
    expect(first.id).not.toBe(second.id)
    expect(listBatchImportItems(db, session.id).map((item) => [item.id, item.ordinal, item.attachment_identity])).toEqual([
      [first.id, 0, hash], [second.id, 1, hash]
    ])
    const differentSession = createBatchImportSession(db, 'workbuddy')
    const differentA = createBatchImportItem(db, differentSession.id, 0, '丙.zip', 'b'.repeat(64))
    const differentB = createBatchImportItem(db, differentSession.id, 1, '丁.zip', 'c'.repeat(64))
    expect(differentA.attachment_identity).not.toBe(differentB.attachment_identity)
    expect(() => createBatchImportItem(db, session.id, 1, '重复顺序.zip')).toThrow()
    expect(() => createBatchImportItem(db, session.id, -1)).toThrow()
    expect(() => db.prepare("UPDATE batch_import_sessions SET status = 'invalid' WHERE id = ?").run(session.id)).toThrow()
    db.prepare("UPDATE batch_import_sessions SET status = 'partial_success' WHERE id = ?").run(session.id)
    db.prepare("UPDATE batch_import_items SET status = 'failed' WHERE id = ?").run(second.id)
    db.prepare("UPDATE batch_import_items SET evidence_status = 'error' WHERE id = ?").run(second.id)
    expect(db.prepare('SELECT status FROM batch_import_sessions WHERE id = ?').get(session.id)).toEqual({ status: 'partial_success' })
    expect(listBatchImportItems(db, session.id)[1].status).toBe('failed')
    expect(listBatchImportItems(db, session.id)[1].evidence_status).toBe('error')
  })

  it('结构版本 1 升至 7 后保留已有附件项和任务关联', () => {
    const db = database()
    const session = createBatchImportSession(db, 'workbuddy')
    const batchItem = createBatchImportItem(db, session.id, 0)
    const job = importChatContent(db, '旧任务.json', 'JSON', JSON.stringify([
      { conversation_name: '旧群', sender_name: '甲', timestamp: '2026-09-01 09:00', content: '旧任务内容' }
    ]))
    attachImportJobToBatchItem(db, job.jobId, batchItem.id)
    recordSnapshot(db, batchItem.id)
    prepareSchemaV6Fixture(db)
    db.exec('PRAGMA user_version = 1')

    initializeDatabase(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    expect(listBatchImportItems(db, session.id).map((value) => value.id)).toEqual([batchItem.id])
    expect(listBatchItemJobs(db, batchItem.id).map((value) => value.id)).toEqual([job.jobId])
    db.prepare("UPDATE batch_import_items SET evidence_status = 'error' WHERE id = ?").run(batchItem.id)
    expect(db.prepare('SELECT evidence_status FROM batch_import_items WHERE id = ?').get(batchItem.id)).toEqual({ evidence_status: 'error' })
    expect(db.prepare('SELECT effective_job_id FROM batch_import_items WHERE id = ?').get(batchItem.id)).toEqual({ effective_job_id: null })
  })

  it('结构版本 2 升至 7 后增加有效任务指针且保留原有记录', () => {
    const db = database()
    const session = createBatchImportSession(db, 'workbuddy')
    const item = createBatchImportItem(db, session.id, 0)
    prepareSchemaV6Fixture(db)
    db.exec('ALTER TABLE batch_import_items DROP COLUMN effective_job_id')
    db.exec('PRAGMA user_version = 2')
    initializeDatabase(db)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    expect(db.prepare('SELECT id, effective_job_id FROM batch_import_items WHERE id = ?').get(item.id)).toEqual({
      id: item.id, effective_job_id: null
    })
  })

  it('两个附件项分别关联一个和两个任务，重新打开后历史与旧式任务仍可读取', () => {
    const directory = mkdtempSync(join(tmpdir(), 'privateradar-batch-relations-'))
    directories.push(directory)
    const path = join(directory, 'relations.db')
    const db = new DatabaseSync(path)
    databases.push(db)
    initializeDatabase(db)
    const session = createBatchImportSession(db, 'workbuddy')
    const itemA = createBatchImportItem(db, session.id, 0)
    const itemB = createBatchImportItem(db, session.id, 1)
    const content = JSON.stringify([{ conversation_name: '测试群', sender_name: '甲', timestamp: '2026-09-01 09:00', content: '保留导入任务历史' }])
    const first = importChatContent(db, 'legacy.json', 'JSON', content)
    const second = importChatContent(db, 'legacy.json', 'JSON', content)
    const third = importChatContent(db, 'legacy.json', 'JSON', content)
    const legacy = importChatContent(db, 'legacy.json', 'JSON', content)
    expect(db.prepare('SELECT batch_item_id FROM import_jobs WHERE id = ?').get(first.jobId)).toEqual({ batch_item_id: null })
    attachImportJobToBatchItem(db, first.jobId, itemA.id)
    attachImportJobToBatchItem(db, second.jobId, itemB.id)
    attachImportJobToBatchItem(db, third.jobId, itemB.id)
    expect(() => attachImportJobToBatchItem(db, first.jobId, itemB.id)).toThrow()
    db.close()
    databases.pop()

    const reopened = new DatabaseSync(path)
    databases.push(reopened)
    initializeDatabase(reopened)
    expect(listBatchImportItems(reopened, session.id).map((item) => item.id)).toEqual([itemA.id, itemB.id])
    expect(listBatchItemJobs(reopened, itemA.id).map((job) => job.id)).toEqual([first.jobId])
    expect(listBatchItemJobs(reopened, itemB.id).map((job) => job.id).sort()).toEqual([second.jobId, third.jobId].sort())
    expect(reopened.prepare('SELECT id, batch_item_id FROM import_jobs WHERE id = ?').get(legacy.jobId)).toEqual({
      id: legacy.jobId, batch_item_id: null
    })
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()).toEqual({ count: 1 })
  })
})
