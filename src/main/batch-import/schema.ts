import type { DatabaseSync } from 'node:sqlite'

// 旧版数据库没有显式版本号，user_version = 0 对应本次迁移前的结构。
const BATCH_IMPORT_SCHEMA_VERSION = 3

export function migrateBatchImportSchema(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version >= BATCH_IMPORT_SCHEMA_VERSION) return
  if (row.user_version < 1) migrateInitialBatchSchema(db)
  if (row.user_version < 2) migrateEvidenceErrorState(db)
  if (row.user_version < 3) migrateEffectiveJob(db)
}

function migrateEffectiveJob(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      ALTER TABLE batch_import_items ADD COLUMN effective_job_id TEXT REFERENCES import_jobs(id);
      PRAGMA user_version = 3;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function migrateInitialBatchSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS batch_import_sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'preparing', 'in_progress', 'success', 'partial_success', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS batch_import_items (
        id TEXT PRIMARY KEY,
        batch_session_id TEXT NOT NULL REFERENCES batch_import_sessions(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        attachment_name TEXT,
        source_hint TEXT,
        attachment_identity TEXT,
        evidence_relative_path TEXT,
        evidence_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (evidence_status IN ('pending', 'available', 'missing', 'corrupt')),
        snapshot_relative_path TEXT,
        snapshot_sha256 TEXT,
        source_batch_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'preparing', 'in_progress', 'success', 'partial_success', 'failed')),
        error_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (batch_session_id, ordinal)
      );
    `)

    const columns = db.prepare('PRAGMA table_info(import_jobs)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'batch_item_id')) {
      db.exec('ALTER TABLE import_jobs ADD COLUMN batch_item_id TEXT REFERENCES batch_import_items(id) ON DELETE RESTRICT')
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_batch_import_items_session
        ON batch_import_items(batch_session_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_import_jobs_batch_item
        ON import_jobs(batch_item_id, started_at, id);
      PRAGMA user_version = 1;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function migrateEvidenceErrorState(db: DatabaseSync): void {
  // SQLite 无法直接扩展已有 CHECK，重建的只有尚未承载消息的附件项表。
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE batch_import_items_next (
        id TEXT PRIMARY KEY,
        batch_session_id TEXT NOT NULL REFERENCES batch_import_sessions(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        attachment_name TEXT,
        source_hint TEXT,
        attachment_identity TEXT,
        evidence_relative_path TEXT,
        evidence_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (evidence_status IN ('pending', 'available', 'missing', 'corrupt', 'error')),
        snapshot_relative_path TEXT,
        snapshot_sha256 TEXT,
        source_batch_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'preparing', 'in_progress', 'success', 'partial_success', 'failed')),
        error_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (batch_session_id, ordinal)
      );
      INSERT INTO batch_import_items_next (
        id, batch_session_id, ordinal, attachment_name, source_hint,
        attachment_identity, evidence_relative_path, evidence_status,
        snapshot_relative_path, snapshot_sha256, source_batch_id, status,
        error_summary, created_at, updated_at, completed_at
      ) SELECT
        id, batch_session_id, ordinal, attachment_name, source_hint,
        attachment_identity, evidence_relative_path, evidence_status,
        snapshot_relative_path, snapshot_sha256, source_batch_id, status,
        error_summary, created_at, updated_at, completed_at
      FROM batch_import_items;
      DROP TABLE batch_import_items;
      ALTER TABLE batch_import_items_next RENAME TO batch_import_items;
      CREATE INDEX idx_batch_import_items_session
        ON batch_import_items(batch_session_id, ordinal);
    `)
    const violations = [
      ...db.prepare('PRAGMA foreign_key_check(batch_import_items)').all(),
      ...db.prepare('PRAGMA foreign_key_check(import_jobs)').all()
    ]
    if (violations.length > 0) throw new Error('批量附件项迁移后外键校验失败')
    db.exec('PRAGMA user_version = 2')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}
