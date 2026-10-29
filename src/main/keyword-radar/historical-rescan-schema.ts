import type { DatabaseSync } from 'node:sqlite'

/** 仅扩展派生扫描状态与覆盖记录；原消息、来源、Evidence、FTS 结构不变。 */
export function ensureHistoricalRescanSchema(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='keyword_rescan_coverage'").get()) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS keyword_rescans (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES keyword_groups(id) ON DELETE CASCADE,
        rules_snapshot_json TEXT NOT NULL CHECK(json_valid(rules_snapshot_json)), owner_pid INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','complete','failed','cancelled')),
        scanned_messages INTEGER NOT NULL DEFAULT 0,total_messages INTEGER NOT NULL,
        matched_hits INTEGER NOT NULL DEFAULT 0,new_hits INTEGER NOT NULL DEFAULT 0,
        existing_hits INTEGER NOT NULL DEFAULT 0,removed_hits INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,finished_at TEXT,error_code TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_one_rescan ON keyword_rescans((1)) WHERE status='running';
      CREATE INDEX IF NOT EXISTS idx_keyword_rescan_group ON keyword_rescans(group_id,started_at,id);
      CREATE TABLE IF NOT EXISTS keyword_rescan_coverage (
        id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES keyword_groups(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        batch_item_id TEXT,source_position INTEGER,
        run_id TEXT NOT NULL REFERENCES keyword_rescans(id) ON DELETE CASCADE,
        matched_terms_snapshot TEXT CHECK(matched_terms_snapshot IS NULL OR json_valid(matched_terms_snapshot)),matched_at TEXT,
        CHECK((batch_item_id IS NULL AND source_position IS NULL) OR (batch_item_id IS NOT NULL AND source_position IS NOT NULL AND source_position>=0 AND matched_terms_snapshot IS NULL)),
        FOREIGN KEY(batch_item_id,source_position) REFERENCES batch_item_message_sources(batch_item_id,source_position) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_rescan_source ON keyword_rescan_coverage(group_id,batch_item_id,source_position) WHERE batch_item_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_rescan_message ON keyword_rescan_coverage(group_id,message_id) WHERE batch_item_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_keyword_rescan_lookup ON keyword_rescan_coverage(batch_item_id,source_position);
      CREATE INDEX IF NOT EXISTS idx_keyword_rescan_orphans ON keyword_rescan_coverage(group_id,message_id) WHERE matched_terms_snapshot IS NOT NULL;
      COMMIT;
    `)
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
