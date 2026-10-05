-- 由已审核的 1dc006b1e276bbe4348de2227882ae917f074552 初始化隔离空库后冻结的结构，不含用户数据。
-- 迁移测试直接载入此版本 4 结构，不能通过只降低新库版本号代替旧结构。
PRAGMA foreign_keys = ON;

CREATE TABLE analysis_runs (
      id TEXT PRIMARY KEY,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      input_message_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE "batch_import_items" (
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
        completed_at TEXT, effective_job_id TEXT REFERENCES import_jobs(id), evidence_source_kind TEXT NOT NULL DEFAULT 'zip'
        CHECK (evidence_source_kind IN ('zip', 'directory')),
        UNIQUE (batch_session_id, ordinal)
      );

CREATE TABLE batch_import_sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'preparing', 'in_progress', 'success', 'partial_success', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      conversation_type TEXT NOT NULL DEFAULT 'group',
      created_at TEXT NOT NULL
    );

CREATE TABLE daily_ai_briefs (
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

CREATE TABLE daily_briefs (
      id TEXT PRIMARY KEY,
      brief_date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_message_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

CREATE TABLE daily_candidate_sources (
      candidate_id TEXT NOT NULL REFERENCES daily_intelligence_candidates(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_order INTEGER NOT NULL,
      PRIMARY KEY (candidate_id, message_id)
    );

CREATE TABLE daily_intelligence_candidates (
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

CREATE TABLE embeddings (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_blob BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

CREATE TABLE import_jobs (
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
    , batch_item_id TEXT REFERENCES batch_import_items(id) ON DELETE RESTRICT);

CREATE TABLE message_import_batches (
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

CREATE TABLE message_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      title TEXT,
      UNIQUE(message_id, canonical_url)
    );

CREATE TABLE messages (
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

CREATE VIRTUAL TABLE messages_fts USING fts5(
      content,
      conversation_name,
      sender_name,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

CREATE TABLE participants (
      id TEXT NOT NULL,
      platform TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (platform, id)
    );

CREATE TABLE query_answer_runs (
      id TEXT PRIMARY KEY,
      query_hash TEXT NOT NULL,
      answer_mode TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      source_message_ids_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );

CREATE TABLE topic_daily_metrics (
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

CREATE TABLE topic_daily_sources (
      topic_id TEXT NOT NULL,
      metric_date TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      source_order INTEGER NOT NULL,
      PRIMARY KEY (topic_id, metric_date, message_id),
      FOREIGN KEY (topic_id, metric_date) REFERENCES topic_daily_metrics(topic_id, metric_date) ON DELETE CASCADE
    );

CREATE TABLE topic_messages (
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      similarity REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (topic_id, message_id)
    );

CREATE TABLE topics (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

CREATE TABLE user_feedback (
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

CREATE INDEX idx_batch_import_items_session
        ON batch_import_items(batch_session_id, ordinal);

CREATE INDEX idx_daily_ai_briefs_lookup
      ON daily_ai_briefs(brief_date, provider, model, candidate_set_hash);

CREATE INDEX idx_daily_candidate_sources_message
      ON daily_candidate_sources(message_id);

CREATE INDEX idx_daily_candidates_date_score
      ON daily_intelligence_candidates(candidate_date, importance_score DESC, id);

CREATE INDEX idx_import_jobs_batch_item
        ON import_jobs(batch_item_id, started_at, id);

CREATE INDEX idx_messages_conversation_time ON messages(conversation_id, timestamp DESC);

CREATE INDEX idx_messages_sender_time ON messages(sender_id, timestamp DESC);

CREATE INDEX idx_messages_source_batch
      ON messages(source_batch_id);

CREATE INDEX idx_messages_source_identity
      ON messages(platform, source_message_id)
      WHERE source_message_id IS NOT NULL
      ;

CREATE UNIQUE INDEX idx_messages_stable_identity
      ON messages(stable_identity)
      WHERE stable_identity IS NOT NULL;

CREATE INDEX idx_messages_time ON messages(timestamp DESC);

CREATE INDEX idx_query_answer_runs_hash ON query_answer_runs(query_hash, generated_at DESC);

CREATE INDEX idx_topic_daily_metrics_date_score
      ON topic_daily_metrics(metric_date, signal_score DESC, topic_id);

CREATE INDEX idx_topic_daily_sources_message ON topic_daily_sources(message_id);

CREATE INDEX idx_topic_messages_message ON topic_messages(message_id);

CREATE INDEX idx_user_feedback_created_at
      ON user_feedback(created_at DESC);

CREATE INDEX idx_user_feedback_surface_target
      ON user_feedback(surface, target_key, updated_at DESC);

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, conversation_name, sender_name)
      VALUES ('delete', old.rowid, old.content, old.conversation_name, old.sender_name);
    END;

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, conversation_name, sender_name)
      VALUES (new.rowid, new.content, new.conversation_name, new.sender_name);
    END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, conversation_name, sender_name)
      VALUES ('delete', old.rowid, old.content, old.conversation_name, old.sender_name);
      INSERT INTO messages_fts(rowid, content, conversation_name, sender_name)
      VALUES (new.rowid, new.content, new.conversation_name, new.sender_name);
    END;

PRAGMA user_version = 4;
