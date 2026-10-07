import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'
import { loadMessagesForDate } from '../src/main/intelligence/daily/repository'
import { runTopicRadar } from '../src/main/intelligence/topics/repository'
import { initializeDatabase } from '../src/main/schema'

const databases: DatabaseSync[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  databases.push(db)
  return db
}

describe('微信分享快速导入与完整导入', () => {
  it('既有数据库会迁移为可空元数据列且保留原消息', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL,
        conversation_type TEXT NOT NULL DEFAULT 'group', created_at TEXT NOT NULL
      );
      CREATE TABLE participants (
        id TEXT NOT NULL, platform TEXT NOT NULL, display_name TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (platform, id)
      );
      INSERT INTO conversations VALUES ('group-1', 'demo', '旧群', 'group', '2026-09-01T00:00:00.000Z');
      INSERT INTO participants VALUES ('sender-1', 'demo', '旧用户', '2026-09-01T00:00:00.000Z');
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, conversation_id TEXT NOT NULL,
        conversation_name TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL,
        timestamp TEXT NOT NULL, content TEXT NOT NULL, message_type TEXT NOT NULL,
        links_json TEXT NOT NULL DEFAULT '[]', attachments_json TEXT NOT NULL DEFAULT '[]',
        reply_to TEXT, source TEXT NOT NULL, raw_metadata_json TEXT NOT NULL DEFAULT '{}',
        source_message_id TEXT, stable_identity TEXT, source_batch_id TEXT NOT NULL DEFAULT '',
        source_position INTEGER NOT NULL DEFAULT 0,
        conversation_name_source TEXT NOT NULL DEFAULT 'source_native',
        sender_name_source TEXT NOT NULL DEFAULT 'source_native',
        timestamp_source TEXT NOT NULL DEFAULT 'source_native', content_source TEXT NOT NULL DEFAULT 'source_native',
        fingerprint TEXT NOT NULL UNIQUE, import_job_id TEXT, imported_at TEXT NOT NULL
      );
      INSERT INTO messages (
        id, platform, conversation_id, conversation_name, sender_id, sender_name,
        timestamp, content, message_type, source, fingerprint, imported_at
      ) VALUES ('legacy-1', 'demo', 'group-1', '旧群', 'sender-1', '旧用户',
        '2026-09-01T00:00:00.000Z', '旧消息', 'text', 'legacy', 'legacy-fingerprint', '2026-09-01T00:00:00.000Z');
    `)
    initializeDatabase(db)
    const columns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; notnull: number }>
    expect(columns.filter((column) => ['conversation_name', 'sender_name', 'timestamp'].includes(column.name)).every((column) => column.notnull === 0)).toBe(true)
    expect(db.prepare("SELECT content FROM messages WHERE id = 'legacy-1'").get()).toEqual({ content: '旧消息' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('快速导入只确认一次群名，正文、URL 和顺序完整保存', () => {
    const db = database()
    const result = ingestWorkBuddyMessages(db, {
      import_mode: 'quick',
      source_batch_id: '微信分享-快速-1',
      batch_metadata: { conversation_name: 'PrivateRadar 测试群', conversation_name_source: 'user_supplied' },
      messages: [
        { content: '先看第一条', source_position: 0 },
        { content: '项目地址：https://github.com/example/quick-import', source_position: 1 }
      ]
    })
    const rows = db.prepare(`
      SELECT conversation_name, conversation_name_source, sender_name, sender_name_source,
             timestamp, timestamp_source, content, links_json, source_position
      FROM messages ORDER BY source_position
    `).all() as Array<Record<string, unknown>>
    expect(result).toMatchObject({
      importedCount: 2, completenessLevel: 'conversation_known',
      conversationStatus: 'confirmed', senderStatus: 'missing', timestampStatus: 'missing'
    })
    expect(rows.map((row) => row.content)).toEqual(['先看第一条', '项目地址：https://github.com/example/quick-import'])
    expect(rows.map((row) => row.source_position)).toEqual([0, 1])
    expect(rows[1].links_json).toContain('https://github.com/example/quick-import')
    expect(rows.every((row) => row.conversation_name === 'PrivateRadar 测试群' && row.conversation_name_source === 'user_supplied')).toBe(true)
    expect(rows.every((row) => row.sender_name === null && row.sender_name_source === 'unknown')).toBe(true)
    expect(rows.every((row) => row.timestamp === null && row.timestamp_source === 'unknown')).toBe(true)
    expect(result.capabilityNotice).toContain('独立人数与精确趋势能力会降级')
  })

  it('同一批次从快速导入补全为完整导入时只 enrichment，不产生重复消息', () => {
    const db = database()
    const contents = ['Claude Code 新版已经发布。', 'GitHub：https://github.com/example/claude-demo']
    const quick = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '微信分享-补全-1',
      batch_metadata: { conversation_name: 'AI 开发群' },
      messages: contents.map((content, source_position) => ({ content, source_position, sender_marker: source_position === 0 ? '左侧' : '右侧' }))
    })
    const complete = ingestWorkBuddyMessages(db, {
      import_mode: 'complete', source_batch_id: '微信分享-补全-1',
      batch_metadata: {
        conversation_name: 'AI 开发群', conversation_name_source: 'user_supplied',
        approximate_date: '2026-09-13', approximate_date_source: 'user_supplied',
        sender_mapping: { 左侧: '张三', 右侧: '李四' }
      },
      messages: contents.map((content, source_position) => ({
        content, source_position, sender_marker: source_position === 0 ? '左侧' : '右侧',
        timestamp: `2026-09-13 11:${String(19 + source_position).padStart(2, '0')}`,
        timestamp_source: 'user_supplied'
      }))
    })
    const rows = db.prepare(`
      SELECT sender_name, sender_name_source, timestamp, timestamp_source,
             conversation_name_source, stable_identity, fingerprint
      FROM messages ORDER BY source_position
    `).all() as Array<Record<string, unknown>>
    const batch = db.prepare('SELECT * FROM message_import_batches WHERE source_batch_id = ?').get(complete.sourceBatchId) as Record<string, unknown>
    expect(quick).toMatchObject({ importedCount: 2, updatedCount: 0 })
    expect(complete).toMatchObject({ importedCount: 0, updatedCount: 2, duplicateCount: 0, completenessLevel: 'complete' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 2 })
    expect(rows.map((row) => row.sender_name)).toEqual(['张三', '李四'])
    expect(rows.every((row) => row.sender_name_source === 'user_supplied' && row.timestamp_source === 'user_supplied')).toBe(true)
    expect(new Set(rows.map((row) => row.stable_identity)).size).toBe(2)
    expect(new Set(rows.map((row) => row.fingerprint)).size).toBe(2)
    expect(batch).toMatchObject({
      import_mode: 'complete', conversation_name: 'AI 开发群', conversation_name_source: 'user_supplied',
      approximate_date: '2026-09-13', approximate_date_source: 'user_supplied', completeness_level: 'complete'
    })
    expect(JSON.parse(String(batch.sender_mapping_json))).toEqual({ 左侧: '张三', 右侧: '李四' })
  })

  it('大致日期和 imported_at 只保存在批次，不写入 message timestamp 或趋势日期', () => {
    const db = database()
    const result = ingestWorkBuddyMessages(db, {
      import_mode: 'complete', source_batch_id: '微信分享-大致日期-1',
      batch_metadata: { conversation_name: '测试群', approximate_date: '2026-08-20' },
      messages: Array.from({ length: 4 }, (_, source_position) => ({ content: `NovaFlow 讨论 ${source_position + 1}`, source_position }))
    })
    const messages = db.prepare('SELECT timestamp, imported_at FROM messages').all() as Array<{ timestamp: string | null; imported_at: string }>
    const batch = db.prepare('SELECT imported_at, approximate_date, completeness_level FROM message_import_batches').get() as Record<string, unknown>
    expect(messages.every((message) => message.timestamp === null && Boolean(message.imported_at))).toBe(true)
    expect(batch.approximate_date).toBe('2026-08-20')
    expect(result.timestampStatus).toBe('approximate')
    expect(result.completenessLevel).toBe('approximate_time_known')
    expect(loadMessagesForDate(db, '2026-08-20')).toHaveLength(0)
    expect(runTopicRadar(db, '2026-08-20', []).topics).toHaveLength(0)
  })

  it('批次 imported_at 在重复导入和补全时保持首次导入时间', () => {
    const db = database()
    const input = {
      import_mode: 'quick' as const, source_batch_id: '微信分享-导入时间-1',
      batch_metadata: { conversation_name: '测试群' }, messages: [{ content: '同一条正文' }]
    }
    const first = ingestWorkBuddyMessages(db, input)
    const second = ingestWorkBuddyMessages(db, input)
    const batch = db.prepare('SELECT imported_at FROM message_import_batches').get() as { imported_at: string }
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 1 })
    expect(batch.imported_at).toBe(first.importedAt)
    expect(second.importedAt).toBe(first.importedAt)
  })

  it('旧公开快速消息入口明确拒绝，不创建任务或批次', async () => {
    const db = database()
    const server = createWorkBuddyMcpServer(db)
    const client = new Client({ name: 'workbuddy-import-mode-test', version: '0.2.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const response = await client.callTool({
      name: 'privateradar_ingest_messages',
      arguments: {
        import_mode: 'quick', source_batch_id: 'MCP-快速-1',
        batch_metadata: { conversation_name: 'MCP 测试群', conversation_name_source: 'user_supplied' },
        messages: [{ content: '通过正式 MCP 链路导入。' }]
      }
    })
    expect(response.isError).toBe(true)
    expect(response.structuredContent).toBeUndefined()
    expect((response.content[0] as { text: string }).text).toContain('RAW_CURRENT_CONTEXT_REQUIRED')
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM message_import_batches').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM import_jobs').get()).toEqual({ count: 0 })
    await client.close()
    await server.close()
  })
})
