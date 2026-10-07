import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { migrateBatchImportSchema } from '../src/main/batch-import/schema'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { createCollection, bindSession } from '../src/main/collections/service'
import { cleanupRadarFixtures, radarFixture, radarCount } from './keyword-radar-fixture'
import { prepareSchemaV6Fixture } from './schema-v6-fixture'

afterEach(cleanupRadarFixtures)
const tables = ['keyword_groups', 'keyword_terms', 'keyword_hits', 'keyword_radar_runs']
const laterTables = ['commitment_candidates', 'commitment_extractor_runs']
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function fingerprints(db: DatabaseSync) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .filter(row => ![...tables, ...laterTables].includes(String(row.name))).map(row => {
      const table = String(row.name)
      const columns = table === 'batch_item_message_sources' ? 'batch_item_id,source_position,message_id,created_at' : '*'
      const rows = db.prepare(`SELECT ${columns} FROM "${table}"`).all()
        .map(value => JSON.stringify(value, (_key, entry) => entry instanceof Uint8Array ? Buffer.from(entry).toString('hex') : entry)).sort()
      return [table, hash(JSON.stringify(rows))]
    }))
}
function schema(db: DatabaseSync) {
  return db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => {
    const name = String(row.name)
    return row.type === 'table' ? { name, columns: db.prepare(`PRAGMA table_info("${name}")`).all(),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list("${name}")`).all() } :
      { name, type: row.type, sql: db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)!.sql }
  })
}
function legacyFixture() {
  const f = radarFixture()
  prepareSchemaV6Fixture(f.db)
  const collection = createCollection(f.db, '隔离旧归集')
  bindSession(f.db, collection.id, f.session.id)
  const result = ingestWorkBuddyMessages(f.db, { messages: Array.from({ length: 294 }, (_, index) => ({
    platform: 'wechat', content: `legacyradarfts 隔离旧消息${index}`, source_message_id: `旧原生身份${index}`,
    conversation_name: '旧群', sender_name: '旧发送人', timestamp: '2026-10-04T09:00:00+08:00'
  })) })
  expect(result.importedCount).toBe(294)
  const messages = f.db.prepare('SELECT id FROM messages ORDER BY rowid').all()
  for (let position = 0; position < 89; position++) {
    const ordinal = position < 47 ? 0 : 1, sourcePosition = ordinal === 0 ? position : position - 47
    f.db.prepare('INSERT INTO batch_item_message_sources VALUES (?,?,?,?)')
      .run(f.items[ordinal].id, sourcePosition, messages[position].id, '原来源登记时间')
  }
  const paths = f.items.map(item => {
    const directory = join(f.directory, 'evidence', item.id), path = join(directory, 'messages.json')
    mkdirSync(directory, { recursive: true })
    // 故意不是可解析快照：结构 7 迁移不允许读取或猜测历史来源事实。
    writeFileSync(path, '历史证据原字节，不参与 Radar 迁移')
    f.db.prepare(`UPDATE batch_import_items SET evidence_relative_path=?,snapshot_relative_path=?,evidence_status='available' WHERE id=?`)
      .run(`evidence/${item.id}/original.zip`, `evidence/${item.id}/messages.json`, item.id)
    return path
  })
  return { ...f, paths }
}

describe('结构版本 7 仅建立持久化基础', () => {
  it('隔离 6→7 保留全部旧表指纹、294 条消息和索引、89 条旧绑定及 Evidence；不回扫、不生成历史 Run 或 Hit', () => {
    const f = legacyFixture(), before = fingerprints(f.db), evidence = f.paths.map(path => hash(readFileSync(path)))
    const bindings = f.db.prepare('SELECT * FROM batch_item_message_sources ORDER BY batch_item_id,source_position').all()
    migrateBatchImportSchema(f.db)
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    expect(fingerprints(f.db)).toEqual(before)
    expect(radarCount(f.db, 'messages')).toBe(294); expect(radarCount(f.db, 'messages_fts')).toBe(294)
    expect(f.db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'legacyradarfts'").get()).toEqual({ n: 294 })
    expect(f.db.prepare('SELECT batch_item_id,source_position,message_id,created_at FROM batch_item_message_sources ORDER BY batch_item_id,source_position').all()).toEqual(bindings)
    const sources = f.db.prepare('SELECT * FROM batch_item_message_sources').all()
    expect(sources).toHaveLength(89)
    for (const source of sources) for (const field of Object.keys(source).filter(name => name.startsWith('source_') && name !== 'source_position')) {
      expect(source[field]).toBeNull()
    }
    expect(f.paths.map(path => hash(readFileSync(path)))).toEqual(evidence)
    for (const table of tables) expect(radarCount(f.db, table)).toBe(0)
    expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('新库与真实四列旧结构升级后的最终结构一致，重复初始化不漂移，高版本不降级', () => {
    const f = legacyFixture(), fresh = radarFixture()
    migrateBatchImportSchema(f.db)
    expect(schema(f.db)).toEqual(schema(fresh.db))
    const before = schema(f.db), data = fingerprints(f.db)
    initializeDatabase(f.db); initializeDatabase(f.db)
    expect(schema(f.db)).toEqual(before); expect(fingerprints(f.db)).toEqual(data)
    f.db.exec('PRAGMA user_version=9'); initializeDatabase(f.db)
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
  })
  it('迁移中途失败整体回滚新增列、表和版本，不丢旧来源', () => {
    const f = legacyFixture(), before = fingerprints(f.db)
    f.db.exec('CREATE TABLE keyword_groups (冲突 TEXT)')
    expect(() => migrateBatchImportSchema(f.db)).toThrow()
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 })
    expect(f.db.prepare('PRAGMA table_info(batch_item_message_sources)').all()).toHaveLength(4)
    expect(fingerprints(f.db)).toEqual(before)
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='require_occurrence_metadata'").get()).toBeUndefined()
  })
  it('Hit 唯一键与复合来源外键、分组外键均为限制删除，且没有重复正文或媒体字段', () => {
    const f = radarFixture()
    expect(f.db.prepare('PRAGMA table_info(keyword_hits)').all().map(row => row.name)).toEqual([
      'id', 'group_id', 'batch_item_id', 'source_position', 'group_name_snapshot', 'matched_terms_snapshot', 'matched_at'
    ])
    const keys = f.db.prepare('PRAGMA foreign_key_list(keyword_hits)').all()
    expect(keys).toHaveLength(3)
    expect(keys.every(key => key.on_delete === 'RESTRICT')).toBe(true)
    expect(keys.filter(key => key.table === 'batch_item_message_sources').map(key => [key.from, key.to])).toEqual([
      ['batch_item_id', 'batch_item_id'], ['source_position', 'source_position']
    ])
    const unique = f.db.prepare('PRAGMA index_list(keyword_hits)').all().find(index => index.origin === 'u')!
    expect(f.db.prepare(`PRAGMA index_info("${String(unique.name)}")`).all().map(row => row.name))
      .toEqual(['group_id', 'batch_item_id', 'source_position'])
    expect(radarCount(f.db, 'keyword_hits')).toBe(0)
  })
})
