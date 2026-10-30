import type { DatabaseSync } from 'node:sqlite'
import { prepareSchemaV7Fixture } from './schema-v7-fixture'

/** 仅为旧版本迁移测试恢复真实四列结构；拒绝删除任何已有 Radar 测试数据。 */
export function prepareSchemaV6Fixture(db: DatabaseSync): void {
  const radarTables = ['keyword_rescan_coverage', 'keyword_rescans', 'keyword_hits', 'keyword_radar_runs', 'keyword_terms', 'keyword_groups']
  // 降级前先检查全部派生数据，不能在遇到非空表之前已删除其他表。
  for (const table of radarTables) {
    if (Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) !== 0) throw new Error('不能丢弃已有 Radar 测试数据')
  }
  prepareSchemaV7Fixture(db)
  for (const table of radarTables) {
    db.exec(`DROP TABLE ${table}`)
  }
  db.exec('DROP TRIGGER require_occurrence_metadata; DROP TRIGGER immutable_occurrence_metadata')
  for (const column of ['source_sender_name', 'source_sender_name_source', 'source_timestamp',
    'source_timestamp_source', 'source_conversation_name', 'source_conversation_name_source']) {
    db.exec(`ALTER TABLE batch_item_message_sources DROP COLUMN ${column}`)
  }
  db.exec('PRAGMA user_version = 6')
}
