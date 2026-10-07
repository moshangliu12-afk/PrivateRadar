import type { DatabaseSync } from 'node:sqlite'

/** 仅恢复隔离测试库的版本七结构；拒绝丢弃已有承诺派生数据。 */
export function prepareSchemaV7Fixture(db: DatabaseSync): void {
  for (const table of ['commitment_candidates', 'commitment_extractor_runs']) {
    if (Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) !== 0) {
      throw new Error('不能丢弃已有承诺派生测试数据')
    }
    db.exec(`DROP TABLE ${table}`)
  }
  db.exec('PRAGMA user_version = 7')
}
