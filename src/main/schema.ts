import type { DatabaseSync } from 'node:sqlite'
import { migrateBatchImportSchema } from './batch-import/schema'

export function initializeDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      conversation_type TEXT NOT NULL DEFAULT 'group',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT NOT NULL,
      platform TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (platform, id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      conversation_name TEXT,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      timestamp TEXT,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL,
      links_json TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT,
      source TEXT NOT NULL,
      raw_metadata_json TEXT NOT NULL DEFAULT '{}',
      source_message_id TEXT,
      stable_identity TEXT,
      source_batch_id TEXT NOT NULL DEFAULT '',
      source_position INTEGER NOT NULL DEFAULT 0,
      conversation_name_source TEXT NOT NULL DEFAULT 'source_native',
      sender_name_source TEXT NOT NULL DEFAULT 'source_native',
      timestamp_source TEXT NOT NULL DEFAULT 'source_native',
      content_source TEXT NOT NULL DEFAULT 'source_native',
      fingerprint TEXT NOT NULL UNIQUE,
      import_job_id TEXT,
      imported_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_id, timestamp DESC);
    CREATE TABLE IF NOT EXISTS message_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      title TEXT,
      UNIQUE(message_id, canonical_url)
    );

    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      input_message_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS daily_briefs (
      id TEXT PRIMARY KEY,
      brief_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_intelligence_candidates (
      id TEXT PRIMARY KEY,
      candidate_date TEXT NOT NULL,
      title TEXT NOT NULL,
      representative_text TEXT NOT NULL,
      importance_score REAL NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      source_conversation_ids_json TEXT NOT NULL,
      source_sender_ids_json TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      conversation_count INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_daily_candidates_date_score
      ON daily_intelligence_candidates(candidate_date, importance_score DESC, id);

    CREATE TABLE IF NOT EXISTS daily_candidate_sources (
      candidate_id TEXT NOT NULL REFERENCES daily_intelligence_candidates(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_order INTEGER NOT NULL,
      PRIMARY KEY (candidate_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_candidate_sources_message
      ON daily_candidate_sources(message_id);

    CREATE TABLE IF NOT EXISTS daily_ai_briefs (
      id TEXT PRIMARY KEY,
      analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id),
      brief_date TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      candidate_set_hash TEXT NOT NULL,
      candidate_count INTEGER NOT NULL,
      evidence_message_count INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      UNIQUE(brief_date, provider, model, candidate_set_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_ai_briefs_lookup
      ON daily_ai_briefs(brief_date, provider, model, candidate_set_hash);

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topic_messages (
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      similarity REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (topic_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_topic_messages_message ON topic_messages(message_id);

    CREATE TABLE IF NOT EXISTS topic_daily_metrics (
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      metric_date TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      conversation_count INTEGER NOT NULL,
      sender_count INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      historical_avg_message_count REAL NOT NULL,
      historical_avg_conversation_count REAL NOT NULL,
      historical_avg_sender_count REAL NOT NULL,
      growth_rate REAL NOT NULL,
      novelty_score REAL NOT NULL,
      signal_score REAL NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      trend_json TEXT NOT NULL,
      algorithm_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (topic_id, metric_date)
    );

    CREATE INDEX IF NOT EXISTS idx_topic_daily_metrics_date_score
      ON topic_daily_metrics(metric_date, signal_score DESC, topic_id);

    CREATE TABLE IF NOT EXISTS topic_daily_sources (
      topic_id TEXT NOT NULL,
      metric_date TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_order INTEGER NOT NULL,
      PRIMARY KEY (topic_id, metric_date, message_id),
      FOREIGN KEY (topic_id, metric_date) REFERENCES topic_daily_metrics(topic_id, metric_date) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_topic_daily_sources_message ON topic_daily_sources(message_id);

    CREATE TABLE IF NOT EXISTS embeddings (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_blob BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS query_answer_runs (
      id TEXT PRIMARY KEY,
      query_hash TEXT NOT NULL,
      answer_mode TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      source_message_ids_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_query_answer_runs_hash ON query_answer_runs(query_hash, generated_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY,
      feedback_key TEXT NOT NULL UNIQUE,
      surface TEXT NOT NULL,
      feedback_type TEXT NOT NULL,
      vote TEXT NOT NULL,
      reason_code TEXT,
      note TEXT,
      target_key TEXT,
      date_key TEXT,
      query_text TEXT,
      source_message_ids_json TEXT NOT NULL DEFAULT '[]',
      context_json TEXT NOT NULL DEFAULT '{}',
      algorithm_version TEXT NOT NULL,
      app_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_user_feedback_surface_target
      ON user_feedback(surface, target_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_feedback_created_at
      ON user_feedback(created_at DESC);

    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY,
      adapter TEXT NOT NULL,
      source_name TEXT NOT NULL,
      file_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      recognized_count INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      error_details_json TEXT NOT NULL DEFAULT '[]',
      cursor_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS message_import_batches (
      source_batch_id TEXT PRIMARY KEY,
      import_job_id TEXT REFERENCES import_jobs(id),
      import_mode TEXT NOT NULL DEFAULT 'quick',
      imported_at TEXT NOT NULL,
      first_attempt_at TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      conversation_name TEXT,
      conversation_name_source TEXT NOT NULL DEFAULT 'unknown',
      approximate_date TEXT,
      approximate_date_source TEXT NOT NULL DEFAULT 'unknown',
      sender_mapping_json TEXT,
      completeness_level TEXT NOT NULL DEFAULT 'content_only'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      conversation_name,
      sender_name,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, conversation_name, sender_name)
      VALUES (new.rowid, new.content, new.conversation_name, new.sender_name);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, conversation_name, sender_name)
      VALUES ('delete', old.rowid, old.content, old.conversation_name, old.sender_name);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, conversation_name, sender_name)
      VALUES ('delete', old.rowid, old.content, old.conversation_name, old.sender_name);
      INSERT INTO messages_fts(rowid, content, conversation_name, sender_name)
      VALUES (new.rowid, new.content, new.conversation_name, new.sender_name);
    END;
  `)

  ensureColumn(db, 'messages', 'source_message_id', 'TEXT')
  ensureColumn(db, 'messages', 'import_job_id', 'TEXT')
  ensureColumn(db, 'messages', 'stable_identity', 'TEXT')
  ensureColumn(db, 'messages', 'source_batch_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'messages', 'source_position', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'messages', 'conversation_name_source', "TEXT NOT NULL DEFAULT 'source_native'")
  ensureColumn(db, 'messages', 'sender_name_source', "TEXT NOT NULL DEFAULT 'source_native'")
  ensureColumn(db, 'messages', 'timestamp_source', "TEXT NOT NULL DEFAULT 'source_native'")
  ensureColumn(db, 'messages', 'content_source', "TEXT NOT NULL DEFAULT 'source_native'")
  ensureColumn(db, 'import_jobs', 'file_type', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'import_jobs', 'total_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'import_jobs', 'recognized_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'import_jobs', 'updated_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'import_jobs', 'error_details_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'message_import_batches', 'first_attempt_at', 'TEXT')
  ensureColumn(db, 'message_import_batches', 'last_attempt_at', 'TEXT')
  ensureColumn(db, 'message_import_batches', 'last_success_at', 'TEXT')
  migrateImportBatchTimes(db)
  ensureNullableMessageMetadata(db)
  db.exec(`
    UPDATE messages SET
      conversation_name_source = CASE WHEN conversation_name IS NULL OR conversation_name = '' THEN 'unknown' ELSE 'user_supplied' END,
      sender_name_source = CASE WHEN sender_name IS NULL OR sender_name = '' THEN 'unknown' ELSE 'user_supplied' END,
      timestamp_source = CASE WHEN timestamp IS NULL OR timestamp = '' THEN 'unknown' ELSE 'user_supplied' END,
      content_source = 'source_native'
    WHERE source = 'file:workbuddy-mcp.json' AND stable_identity IS NULL;
  `)
  db.exec(`
    DROP INDEX IF EXISTS idx_messages_source_identity;
    CREATE INDEX IF NOT EXISTS idx_messages_source_identity
      ON messages(platform, source_message_id)
      WHERE source_message_id IS NOT NULL
      ;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_stable_identity
      ON messages(stable_identity)
      WHERE stable_identity IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_source_batch
      ON messages(source_batch_id);
  `)
  migrateBatchImportSchema(db)
  // 沿用按列检测的增量迁移，不重建消息表或全文索引。
  ensureConversationLabel(db)
}

function migrateImportBatchTimes(db: DatabaseSync): void {
  db.exec(`
    UPDATE message_import_batches
    SET first_attempt_at = COALESCE(first_attempt_at, imported_at)
    WHERE first_attempt_at IS NULL;

    UPDATE message_import_batches
    SET last_attempt_at = COALESCE(
      last_attempt_at,
      (SELECT j.started_at
       FROM import_jobs j WHERE j.id = message_import_batches.import_job_id),
      imported_at
    )
    WHERE last_attempt_at IS NULL;

    UPDATE message_import_batches
    SET last_success_at = COALESCE(
      last_success_at,
      (SELECT COALESCE(j.completed_at, j.started_at)
       FROM import_jobs j
       WHERE j.id = message_import_batches.import_job_id
         AND j.status IN ('success', 'partial'))
    )
    WHERE last_success_at IS NULL;
  `)
}

function ensureNullableMessageMetadata(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; notnull: number }>
  const needsMigration = ['conversation_name', 'sender_name', 'timestamp']
    .some((name) => columns.find((column) => column.name === name)?.notnull === 1)
  if (!needsMigration) return
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
    CREATE TABLE messages_nullable (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      conversation_name TEXT,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      timestamp TEXT,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL,
      links_json TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT,
      source TEXT NOT NULL,
      raw_metadata_json TEXT NOT NULL DEFAULT '{}',
      source_message_id TEXT,
      stable_identity TEXT,
      source_batch_id TEXT NOT NULL DEFAULT '',
      source_position INTEGER NOT NULL DEFAULT 0,
      conversation_name_source TEXT NOT NULL DEFAULT 'source_native',
      sender_name_source TEXT NOT NULL DEFAULT 'source_native',
      timestamp_source TEXT NOT NULL DEFAULT 'source_native',
      content_source TEXT NOT NULL DEFAULT 'source_native',
      fingerprint TEXT NOT NULL UNIQUE,
      import_job_id TEXT,
      imported_at TEXT NOT NULL
    );
    INSERT INTO messages_nullable (
      rowid, id, platform, conversation_id, conversation_name, sender_id, sender_name,
      timestamp, content, message_type, links_json, attachments_json, reply_to,
      source, raw_metadata_json, source_message_id, stable_identity, source_batch_id,
      source_position, conversation_name_source, sender_name_source, timestamp_source,
      content_source, fingerprint, import_job_id, imported_at
    )
    SELECT rowid, id, platform, conversation_id, NULLIF(conversation_name, ''), sender_id,
      NULLIF(sender_name, ''), NULLIF(timestamp, ''), content, message_type, links_json,
      attachments_json, reply_to, source, raw_metadata_json, source_message_id,
      stable_identity, source_batch_id, source_position, conversation_name_source,
      sender_name_source, timestamp_source, content_source, fingerprint, import_job_id, imported_at
    FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_nullable RENAME TO messages;
    CREATE INDEX idx_messages_time ON messages(timestamp DESC);
    CREATE INDEX idx_messages_conversation_time ON messages(conversation_id, timestamp DESC);
    CREATE INDEX idx_messages_sender_time ON messages(sender_id, timestamp DESC);
    CREATE INDEX idx_messages_source_batch ON messages(source_batch_id);
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, conversation_name, sender_name)
      VALUES (new.rowid, new.content, new.conversation_name, new.sender_name);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, conversation_name, sender_name)
      VALUES ('delete', old.rowid, old.content, old.conversation_name, old.sender_name);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, conversation_name, sender_name)
      VALUES ('delete', old.rowid, old.content, old.conversation_name, old.sender_name);
      INSERT INTO messages_fts(rowid, content, conversation_name, sender_name)
      VALUES (new.rowid, new.content, new.conversation_name, new.sender_name);
    END;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `)
}

function ensureConversationLabel(db: DatabaseSync): void {
  if (db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'user_conversation_label')) return
  db.exec('BEGIN IMMEDIATE')
  try {
    // App 与 Connector 同时打开旧库时，在写锁内再次检查。
    ensureColumn(db, 'conversations', 'user_conversation_label', 'TEXT')
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
