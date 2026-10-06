import type { DatabaseSync } from 'node:sqlite'

/** 只扩展结构；旧来源事实保持未知，不读取历史正文或 Evidence。 */
export function migrateKeywordRadarSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      ALTER TABLE batch_item_message_sources ADD COLUMN source_sender_name TEXT;
      ALTER TABLE batch_item_message_sources ADD COLUMN source_sender_name_source TEXT
        CHECK (source_sender_name_source IN ('source_native','user_supplied','inferred','unknown'));
      ALTER TABLE batch_item_message_sources ADD COLUMN source_timestamp TEXT;
      ALTER TABLE batch_item_message_sources ADD COLUMN source_timestamp_source TEXT
        CHECK (source_timestamp_source IN ('source_native','user_supplied','inferred','unknown'));
      ALTER TABLE batch_item_message_sources ADD COLUMN source_conversation_name TEXT;
      ALTER TABLE batch_item_message_sources ADD COLUMN source_conversation_name_source TEXT
        CHECK (source_conversation_name_source IN ('source_native','user_supplied','inferred','unknown'));
      CREATE TRIGGER require_occurrence_metadata BEFORE INSERT ON batch_item_message_sources
      WHEN NEW.source_sender_name_source IS NULL OR NEW.source_timestamp_source IS NULL
        OR NEW.source_conversation_name_source IS NULL
      BEGIN SELECT RAISE(ABORT, 'SOURCE_OCCURRENCE_METADATA_REQUIRED'); END;
      CREATE TRIGGER immutable_occurrence_metadata BEFORE UPDATE ON batch_item_message_sources
      WHEN NEW.batch_item_id IS NOT OLD.batch_item_id OR NEW.source_position IS NOT OLD.source_position
        OR NEW.message_id IS NOT OLD.message_id OR NEW.created_at IS NOT OLD.created_at
        OR NEW.source_sender_name IS NOT OLD.source_sender_name
        OR NEW.source_sender_name_source IS NOT OLD.source_sender_name_source
        OR NEW.source_timestamp IS NOT OLD.source_timestamp
        OR NEW.source_timestamp_source IS NOT OLD.source_timestamp_source
        OR NEW.source_conversation_name IS NOT OLD.source_conversation_name
        OR NEW.source_conversation_name_source IS NOT OLD.source_conversation_name_source
      BEGIN SELECT RAISE(ABORT, 'SOURCE_OCCURRENCE_IMMUTABLE'); END;
      CREATE TABLE keyword_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE keyword_terms (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES keyword_groups(id) ON DELETE RESTRICT,
        term TEXT NOT NULL CHECK (length(term) > 0),
        normalized_term TEXT NOT NULL CHECK (length(normalized_term) > 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), created_at TEXT NOT NULL,
        UNIQUE (group_id, normalized_term)
      );
      CREATE TRIGGER immutable_keyword_term BEFORE UPDATE OF id, group_id, term, normalized_term, created_at ON keyword_terms
      WHEN NEW.id IS NOT OLD.id OR NEW.group_id IS NOT OLD.group_id OR NEW.term IS NOT OLD.term
        OR NEW.normalized_term IS NOT OLD.normalized_term OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'KEYWORD_TERM_IMMUTABLE'); END;
      CREATE TABLE keyword_hits (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES keyword_groups(id) ON DELETE RESTRICT,
        batch_item_id TEXT NOT NULL, source_position INTEGER NOT NULL CHECK (source_position >= 0),
        group_name_snapshot TEXT NOT NULL,
        matched_terms_snapshot TEXT NOT NULL CHECK (json_valid(matched_terms_snapshot)),
        matched_at TEXT NOT NULL,
        UNIQUE (group_id, batch_item_id, source_position),
        FOREIGN KEY (batch_item_id, source_position)
          REFERENCES batch_item_message_sources(batch_item_id, source_position) ON DELETE RESTRICT
      );
      CREATE TABLE keyword_radar_runs (
        batch_item_id TEXT PRIMARY KEY REFERENCES batch_import_items(id) ON DELETE RESTRICT,
        core_import_job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('pending','complete','failed')),
        rules_snapshot_json TEXT NOT NULL CHECK (json_valid(rules_snapshot_json)),
        source_positions_snapshot_json TEXT NOT NULL CHECK (json_valid(source_positions_snapshot_json)),
        created_at TEXT NOT NULL, processed_at TEXT,
        error_summary TEXT CHECK (error_summary IS NULL OR length(error_summary) <= 160),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
      );
      CREATE INDEX idx_keyword_radar_runs_status ON keyword_radar_runs(status, created_at, batch_item_id);
      CREATE TRIGGER immutable_keyword_radar_run BEFORE UPDATE ON keyword_radar_runs
      WHEN NEW.batch_item_id IS NOT OLD.batch_item_id OR NEW.core_import_job_id IS NOT OLD.core_import_job_id
        OR NEW.rules_snapshot_json IS NOT OLD.rules_snapshot_json
        OR NEW.source_positions_snapshot_json IS NOT OLD.source_positions_snapshot_json
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'KEYWORD_RADAR_RUN_IMMUTABLE'); END;
      PRAGMA user_version = 7;
      COMMIT;
    `)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
