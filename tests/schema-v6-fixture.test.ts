import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { importChatContent } from '../src/main/import/importer'
import { createKeywordGroup } from '../src/main/keyword-radar/config'
import { prepareSchemaV6Fixture } from './schema-v6-fixture'

describe('旧版结构 Fixture 的非空数据保护', () => {
  it('空派生数据降级为合法版本六结构，后续删除来源表没有悬空外键', () => {
    const db = new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      prepareSchemaV6Fixture(db)
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 })
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      db.exec('DROP TABLE batch_item_message_sources; PRAGMA user_version = 5')
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally { db.close() }
  })

  it.each(['keyword_rescans', 'keyword_rescan_coverage'])('拒绝丢弃已有 %s，结构、版本和全部派生行保持不变', table => {
    const db = new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      const group = createKeywordGroup(db, '隔离保护规则')
      db.prepare(`INSERT INTO keyword_rescans
        (id,group_id,rules_snapshot_json,owner_pid,status,total_messages,started_at)
        VALUES ('保护扫描',?,'[]',?,'complete',0,'2026-10-30T00:00:00Z')`).run(group.id, process.pid)
      if (table === 'keyword_rescan_coverage') {
        expect(importChatContent(db, '隔离.json', 'JSON', JSON.stringify([
          { conversation_name: '隔离群', sender_name: '隔离发送人', timestamp: '2026-10-30 09:00', content: '只用于旧版 Fixture 的非空保护' }
        ])).importedCount).toBe(1)
        const message = db.prepare('SELECT id FROM messages').get()!
        db.prepare(`INSERT INTO keyword_rescan_coverage (id,group_id,message_id,run_id)
          VALUES ('保护覆盖',?,?,'保护扫描')`).run(group.id, message.id)
      }
      const schemaBefore = db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY name').all()
      const versionBefore = db.prepare('PRAGMA user_version').get()
      const protectedTables = ['keyword_groups', 'keyword_rescans', 'keyword_rescan_coverage']
      const rowsBefore = protectedTables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY id`).all())

      expect(() => prepareSchemaV6Fixture(db)).toThrow('不能丢弃已有 Radar 测试数据')

      expect(db.prepare('SELECT name,type,sql FROM sqlite_master ORDER BY name').all()).toEqual(schemaBefore)
      expect(db.prepare('PRAGMA user_version').get()).toEqual(versionBefore)
      expect(protectedTables.map(name => db.prepare(`SELECT * FROM ${name} ORDER BY id`).all())).toEqual(rowsBefore)
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally { db.close() }
  })
})
