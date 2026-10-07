import type { DatabaseSync } from 'node:sqlite'

/** 只创建空派生表，不扫描历史消息、来源、关键词运行记录或证据。 */
export function migrateCommitmentSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE commitment_extractor_runs (
        batch_item_id TEXT NOT NULL REFERENCES batch_import_items(id) ON DELETE RESTRICT,
        core_import_job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE RESTRICT,
        rule_version TEXT NOT NULL CHECK (length(trim(rule_version)) > 0),
        source_positions_snapshot_json TEXT NOT NULL
          CHECK (CASE WHEN json_valid(source_positions_snapshot_json)
            THEN json_type(source_positions_snapshot_json) = 'array' ELSE 0 END),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
        created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
        processed_at TEXT,
        error_summary TEXT CHECK (error_summary IS NULL OR length(error_summary) <= 160),
        PRIMARY KEY (batch_item_id, rule_version),
        CHECK ((status = 'pending' AND processed_at IS NULL AND error_summary IS NULL)
          OR (status = 'complete' AND processed_at IS NOT NULL AND error_summary IS NULL)
          OR (status = 'failed' AND processed_at IS NOT NULL AND error_summary IS NOT NULL))
      );
      CREATE INDEX idx_commitment_extractor_runs_status
        ON commitment_extractor_runs(status, created_at, batch_item_id, rule_version);
      CREATE TRIGGER validate_commitment_run BEFORE INSERT ON commitment_extractor_runs
      BEGIN
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM import_jobs
          WHERE id = NEW.core_import_job_id AND batch_item_id = NEW.batch_item_id)
          THEN RAISE(ABORT, '承诺提取运行记录的导入任务与附件项不一致') END;
        SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.source_positions_snapshot_json)
          WHERE type <> 'integer' OR value < 0 OR value > 9007199254740991)
          OR EXISTS (SELECT 1 FROM json_each(NEW.source_positions_snapshot_json) current
            JOIN json_each(NEW.source_positions_snapshot_json) previous ON previous.key = current.key - 1
            WHERE previous.value >= current.value)
          THEN RAISE(ABORT, '承诺提取来源位置必须为递增且唯一的非负安全整数') END;
        SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.source_positions_snapshot_json) position
          WHERE NOT EXISTS (SELECT 1 FROM batch_item_message_sources source
            WHERE source.batch_item_id = NEW.batch_item_id AND source.source_position = position.value))
          THEN RAISE(ABORT, '承诺提取运行记录包含不存在的来源') END;
      END;
      CREATE TRIGGER immutable_commitment_run BEFORE UPDATE ON commitment_extractor_runs
      WHEN NEW.batch_item_id IS NOT OLD.batch_item_id OR NEW.rule_version IS NOT OLD.rule_version
        OR NEW.core_import_job_id IS NOT OLD.core_import_job_id
        OR NEW.source_positions_snapshot_json IS NOT OLD.source_positions_snapshot_json
        OR NEW.created_at IS NOT OLD.created_at OR NEW.attempt_count < OLD.attempt_count
      BEGIN SELECT RAISE(ABORT, '承诺提取运行记录的身份和来源快照不可修改，尝试次数不可减少'); END;

      CREATE TABLE commitment_candidates (
        id TEXT NOT NULL PRIMARY KEY,
        batch_item_id TEXT NOT NULL,
        source_position INTEGER NOT NULL
          CHECK (typeof(source_position) = 'integer' AND source_position >= 0 AND source_position <= 9007199254740991),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','ignored')),
        reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
        rule_id TEXT NOT NULL CHECK (length(trim(rule_id)) > 0),
        rule_version TEXT NOT NULL CHECK (length(trim(rule_version)) > 0),
        created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
        reviewed_at TEXT,
        UNIQUE (batch_item_id, source_position, rule_version),
        FOREIGN KEY (batch_item_id, source_position)
          REFERENCES batch_item_message_sources(batch_item_id, source_position) ON DELETE RESTRICT,
        FOREIGN KEY (batch_item_id, rule_version)
          REFERENCES commitment_extractor_runs(batch_item_id, rule_version) ON DELETE RESTRICT,
        CHECK ((status = 'pending' AND reviewed_at IS NULL)
          OR (status IN ('confirmed','ignored') AND reviewed_at IS NOT NULL))
      );
      CREATE INDEX idx_commitment_candidates_run
        ON commitment_candidates(batch_item_id, rule_version, source_position);
      CREATE TRIGGER validate_commitment_candidate BEFORE INSERT ON commitment_candidates
      BEGIN
        SELECT CASE WHEN NEW.status <> 'pending' OR NEW.reviewed_at IS NOT NULL
          THEN RAISE(ABORT, '承诺候选项首次创建必须待审核') END;
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM commitment_extractor_runs run,
          json_each(run.source_positions_snapshot_json) position
          WHERE run.batch_item_id = NEW.batch_item_id AND run.rule_version = NEW.rule_version
            AND position.value = NEW.source_position)
          THEN RAISE(ABORT, '承诺候选项必须属于对应运行记录的冻结来源集合') END;
      END;
      CREATE TRIGGER immutable_commitment_candidate BEFORE UPDATE ON commitment_candidates
      WHEN NEW.id IS NOT OLD.id OR NEW.batch_item_id IS NOT OLD.batch_item_id
        OR NEW.source_position IS NOT OLD.source_position OR NEW.rule_version IS NOT OLD.rule_version
        OR NEW.created_at IS NOT OLD.created_at OR NEW.reason_code IS NOT OLD.reason_code
        OR NEW.rule_id IS NOT OLD.rule_id
      BEGIN SELECT RAISE(ABORT, '承诺候选项身份和生成原因快照不可修改'); END;
      CREATE TRIGGER validate_commitment_review BEFORE UPDATE ON commitment_candidates
      WHEN (OLD.status <> 'pending' AND NEW.status = 'pending')
        OR (OLD.status = NEW.status AND NEW.reviewed_at IS NOT OLD.reviewed_at)
      BEGIN SELECT RAISE(ABORT, '承诺审核不可重置，同状态审核不得刷新时间'); END;
      PRAGMA user_version = 8;
      COMMIT;
    `)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
