import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { importChatContent } from '../src/main/import/importer'
import { createMessageFingerprint } from '../src/main/import/fingerprint'
import { normalizeMessage } from '../src/main/import/normalize'

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  return db
}

function example(name: string): string {
  return readFileSync(join(process.cwd(), 'examples', name), 'utf8')
}

describe('阶段 C 文件导入', () => {
  it('依次导入三个演示文件能正确统计跨文件重复', () => {
    const db = database()
    const json = importChatContent(db, 'demo-chat.json', 'JSON', example('demo-chat.json'))
    const csv = importChatContent(db, 'demo-chat.csv', 'CSV', example('demo-chat.csv'))
    const txt = importChatContent(db, 'demo-chat.txt', 'TXT', example('demo-chat.txt'))
    expect(json).toMatchObject({ importedCount: 5, duplicateCount: 0 })
    expect(csv).toMatchObject({ importedCount: 3, duplicateCount: 2 })
    expect(txt).toMatchObject({ importedCount: 3, duplicateCount: 2 })
    const count = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE platform = 'local-file'").get() as { count: number }
    expect(count.count).toBe(11)
    db.close()
  })

  it('正常导入 JSON，并保存导入任务', () => {
    const db = database()
    const result = importChatContent(db, 'demo-chat.json', 'JSON', example('demo-chat.json'))
    const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(result.jobId) as Record<string, unknown>
    expect(result).toMatchObject({ recognizedCount: 5, importedCount: 5, duplicateCount: 0, invalidCount: 0, status: 'success' })
    expect(job).toMatchObject({ total_count: 5, recognized_count: 5, imported_count: 5, duplicate_count: 0, error_count: 0, status: 'success' })
    db.close()
  })

  it('正常导入 CSV，包括被引号包裹且含逗号的正文', () => {
    const db = database()
    const result = importChatContent(db, 'demo-chat.csv', 'CSV', example('demo-chat.csv'))
    const row = db.prepare("SELECT content FROM messages WHERE source_message_id = 'demo-csv-006'").get() as { content: string }
    expect(result.importedCount).toBe(5)
    expect(row.content).toContain('带逗号的正文')
    db.close()
  })

  it('正常导入 TXT 的制表符和可读行格式', () => {
    const db = database()
    const result = importChatContent(db, 'demo-chat.txt', 'TXT', example('demo-chat.txt'))
    expect(result).toMatchObject({ recognizedCount: 5, importedCount: 5, invalidCount: 0, status: 'success' })
    db.close()
  })

  it('同一个文件重复导入不会增加消息', () => {
    const db = database()
    const content = example('demo-chat.json')
    const first = importChatContent(db, 'demo-chat.json', 'JSON', content)
    const second = importChatContent(db, 'demo-chat.json', 'JSON', content)
    expect(first.importedCount).toBe(5)
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 5, status: 'success' })
    db.close()
  })

  it('两份时间范围重叠的数据只新增非重叠日期', () => {
    const db = database()
    const record = (day: number) => ({
      platform: 'overlap-test', conversation_name: '测试群', sender_name: '测试员',
      timestamp: `2026-09-${String(day).padStart(2, '0')} 10:00:00`, content: `第 ${day} 天的消息`
    })
    const first = importChatContent(db, 'first.json', 'JSON', JSON.stringify(Array.from({ length: 12 }, (_, index) => record(index + 1))))
    const second = importChatContent(db, 'second.json', 'JSON', JSON.stringify(Array.from({ length: 4 }, (_, index) => record(index + 10))))
    expect(first.importedCount).toBe(12)
    expect(second).toMatchObject({ importedCount: 1, duplicateCount: 3 })
    db.close()
  })

  it('少量坏数据不会阻止正常消息入库', () => {
    const db = database()
    const rows = [
      { conversation_name: '容错群', sender_name: '甲', timestamp: '2026-09-12 10:00:00', content: '正常一' },
      { conversation_name: '容错群', sender_name: '乙', timestamp: '错误时间', content: '坏数据' },
      { conversation_name: '容错群', sender_name: '甲', timestamp: '2026-09-12 10:02:00', content: '正常二' },
      { conversation_name: '容错群', timestamp: '2026-09-12 10:03:00', content: '缺少发送人' },
      { conversation_name: '容错群', sender_name: '丙', timestamp: '2026-09-12 10:04:00', content: '正常三' }
    ]
    const result = importChatContent(db, 'mixed.json', 'JSON', JSON.stringify(rows))
    expect(result).toMatchObject({ recognizedCount: 3, importedCount: 3, invalidCount: 2, status: 'partial' })
    db.close()
  })

  it('消息指纹对字段顺序和无意义空白保持稳定，对关键字段变化敏感', () => {
    const first = normalizeMessage({ sender_name: '林舟', content: '同一条   消息', timestamp: '2026-09-12 10:00:00', conversation_name: '测试群' }, 'a.json')
    const reordered = normalizeMessage({ conversation_name: '测试群', timestamp: '2026-09-12T10:00:00+08:00', content: '同一条 消息', sender_name: '林舟' }, 'b.csv')
    expect(createMessageFingerprint(first.message)).toBe(createMessageFingerprint(reordered.message))
    const changed = { ...reordered.message, senderName: '另一人' }
    expect(createMessageFingerprint(changed)).not.toBe(createMessageFingerprint(first.message))
  })
})
