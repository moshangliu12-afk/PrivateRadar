import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createDemoMessages, seedDemoData } from '../src/main/demo'
import { initializeDatabase } from '../src/main/schema'

describe('演示数据', () => {
  it('包含七天、四个群、八个用户和一千条以上消息', () => {
    const messages = createDemoMessages()
    expect(messages.length).toBeGreaterThan(1000)
    expect(new Set(messages.map((item) => item.timestamp.slice(0, 10))).size).toBe(7)
    expect(new Set(messages.map((item) => item.conversationId)).size).toBe(4)
    expect(new Set(messages.map((item) => item.senderId)).size).toBe(8)
  })

  it('重复执行种子导入不会产生重复消息', () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    const expected = createDemoMessages().length
    const first = seedDemoData(db)
    const second = seedDemoData(db)
    const count = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }
    expect(first.inserted).toBe(expected)
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(expected)
    expect(count.count).toBe(expected)
    db.close()
  })

  it('全文索引能找到语义明确的演示消息', () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    seedDemoData(db)
    const result = db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'Claude'").get() as { count: number }
    expect(result.count).toBeGreaterThan(0)
    db.close()
  })
})
