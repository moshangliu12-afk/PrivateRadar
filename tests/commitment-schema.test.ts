import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { migrateBatchImportSchema } from '../src/main/batch-import/schema'
import { addKeywordTerm, createKeywordGroup } from '../src/main/keyword-radar/config'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { createCommitmentCandidate, reviewCommitmentCandidate } from '../src/main/commitment/candidates'
import { cleanupRadarFixtures, ingestRadarItem, radarCount, radarFixture } from './keyword-radar-fixture'
import { candidateInput, commitmentFixture, registerFixtureRun } from './commitment-fixture'
import { prepareSchemaV7Fixture } from './schema-v7-fixture'

afterEach(cleanupRadarFixtures)
const commitmentTables = ['commitment_candidates', 'commitment_extractor_runs']
function fingerprints(db: DatabaseSync) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => {
    const name = String(row.name)
    const rows = db.prepare(`SELECT * FROM "${name}"`).all().map(value => JSON.stringify(value,
      (_key, entry) => entry instanceof Uint8Array ? Buffer.from(entry).toString('hex') : entry)).sort()
    return [name, createHash('sha256').update(JSON.stringify(rows)).digest('hex')]
  }))
}
function schema(db: DatabaseSync) {
  return db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY name').all()
}
function legacyFixture() {
  const f = radarFixture()
  prepareSchemaV7Fixture(f.db)
  const group = createKeywordGroup(f.db, '隔离历史关键词')
  addKeywordTerm(f.db, group.id, 'Codex')
  f.items.forEach((_item, index) => {
    expect(ingestRadarItem(f, index).status).toBe('success')
    expect(processKeywordRadarRun(f.db, f.items[index].id).status).toBe('complete')
  })
  const evidencePath = join(f.directory, '隔离历史证据.bin')
  writeFileSync(evidencePath, '不可解析的隔离历史证据原字节')
  f.db.prepare(`UPDATE batch_import_items SET evidence_relative_path=?,snapshot_relative_path=?,evidence_status='available'`)
    .run('不应读取的隔离证据', '不应读取的隔离快照')
  return { ...f, evidencePath }
}

describe('承诺持久化结构版本八', () => {
  it('七到八仅新增两个空派生表，旧消息、全文索引、来源、关键词记录、全部旧表及证据原样保留', () => {
    const f = legacyFixture(), before = fingerprints(f.db), objects = schema(f.db)
    const evidence = readFileSync(f.evidencePath)
    const hits = f.db.prepare('SELECT * FROM keyword_hits ORDER BY id').all()
    expect(hits).toHaveLength(4)
    expect(radarCount(f.db, 'keyword_radar_runs')).toBe(2)
    migrateBatchImportSchema(f.db)
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    const after = fingerprints(f.db)
    for (const name of Object.keys(before)) expect(after[name]).toEqual(before[name])
    expect(Object.keys(after).filter(name => !Object.hasOwn(before, name)).sort()).toEqual(commitmentTables)
    for (const object of objects) {
      expect(f.db.prepare('SELECT name,type,sql FROM sqlite_master WHERE name=?').get(object.name)).toEqual(object)
    }
    for (const table of commitmentTables) expect(radarCount(f.db, table)).toBe(0)
    expect(f.db.prepare('SELECT * FROM keyword_hits ORDER BY id').all()).toEqual(hits)
    expect(radarCount(f.db, 'messages')).toBe(2)
    expect(radarCount(f.db, 'batch_item_message_sources')).toBe(4)
    expect(f.db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'Codex'").get()).toEqual({ n: 2 })
    expect(readFileSync(f.evidencePath)).toEqual(evidence)
    expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it.each(['commitment_candidates', 'idx_commitment_candidates_run', 'immutable_commitment_candidate'])(
    '迁移在创建 %s 时失败，全部新增表、约束、索引、触发器和版本整体回滚', collision => {
      const f = legacyFixture()
      if (collision === 'immutable_commitment_candidate') {
        f.db.exec(`CREATE TRIGGER ${collision} BEFORE INSERT ON import_jobs BEGIN SELECT 1; END`)
      } else {
        f.db.exec(`CREATE TABLE ${collision} (冲突 TEXT)`)
      }
      const before = fingerprints(f.db), objects = schema(f.db)
      expect(() => migrateBatchImportSchema(f.db)).toThrow()
      expect(f.db.isTransaction).toBe(false)
      expect(f.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
      expect(fingerprints(f.db)).toEqual(before)
      expect(schema(f.db)).toEqual(objects)
    }
  )
  it('新库与七到八迁移结构一致，多次初始化及重新打开保留审核数据且无漂移，高版本不降级', () => {
    const old = legacyFixture(), fresh = commitmentFixture()
    migrateBatchImportSchema(old.db)
    expect(schema(old.db)).toEqual(schema(fresh.db))
    registerFixtureRun(fresh)
    const candidate = createCommitmentCandidate(fresh.db, candidateInput(fresh))
    reviewCommitmentCandidate(fresh.db, candidate.id, 'confirmed')
    const before = fingerprints(fresh.db), objects = schema(fresh.db)
    initializeDatabase(fresh.db); initializeDatabase(fresh.db)
    expect(fingerprints(fresh.db)).toEqual(before)
    expect(schema(fresh.db)).toEqual(objects)
    const reopened = new DatabaseSync(fresh.path)
    try {
      initializeDatabase(reopened)
      expect(fingerprints(reopened)).toEqual(before)
      expect(schema(reopened)).toEqual(objects)
      reopened.exec('PRAGMA user_version=9')
      initializeDatabase(reopened)
      expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
    } finally { reopened.close() }
  })
  it('仅保留最小字段，候选项复合来源与运行外键、运行的附件项与任务外键均限制删除', () => {
    const f = radarFixture()
    expect(f.db.prepare('PRAGMA table_info(commitment_candidates)').all().map(row => row.name)).toEqual([
      'id', 'batch_item_id', 'source_position', 'status', 'reason_code', 'rule_id', 'rule_version', 'created_at', 'reviewed_at'
    ])
    expect(f.db.prepare('PRAGMA table_info(commitment_extractor_runs)').all().map(row => row.name)).toEqual([
      'batch_item_id', 'core_import_job_id', 'rule_version', 'source_positions_snapshot_json', 'status',
      'attempt_count', 'created_at', 'processed_at', 'error_summary'
    ])
    const candidateKeys = f.db.prepare('PRAGMA foreign_key_list(commitment_candidates)').all()
    expect(candidateKeys.every(key => key.on_delete === 'RESTRICT')).toBe(true)
    expect(candidateKeys.filter(key => key.table === 'batch_item_message_sources').map(key => [key.from, key.to]))
      .toEqual([['batch_item_id', 'batch_item_id'], ['source_position', 'source_position']])
    expect(candidateKeys.filter(key => key.table === 'commitment_extractor_runs').map(key => [key.from, key.to]))
      .toEqual([['batch_item_id', 'batch_item_id'], ['rule_version', 'rule_version']])
    const runKeys = f.db.prepare('PRAGMA foreign_key_list(commitment_extractor_runs)').all()
    expect(runKeys.map(key => key.table).sort()).toEqual(['batch_import_items', 'import_jobs'])
    expect(runKeys.every(key => key.on_delete === 'RESTRICT')).toBe(true)
    const unique = f.db.prepare('PRAGMA index_list(commitment_candidates)').all().find(row => row.origin === 'u')!
    expect(f.db.prepare(`PRAGMA index_info("${String(unique.name)}")`).all().map(row => row.name))
      .toEqual(['batch_item_id', 'source_position', 'rule_version'])
    expect(f.db.prepare('PRAGMA table_info(commitment_extractor_runs)').all().filter(row => Number(row.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk)).map(row => row.name)).toEqual(['batch_item_id', 'rule_version'])
  })
})
