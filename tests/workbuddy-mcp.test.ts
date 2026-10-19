// 手工消息为从零构造的合成场景，日期为人工测试锚点；不代表真实聊天或事件。
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { normalizeMessage } from '../src/main/import/normalize'
import { askChat } from '../src/main/retrieval/service'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'

const messages = [
  {
    platform: 'wechat',
    conversation_name: '合成协议演练群',
    sender_name: '合成成员甲',
    timestamp: '2004-02-03T13:06:00+08:00',
    content: '虚构排练用 Claude Code 记录纸偶零件的编号方案。',
    source_message_id: 'wb-spike-001'
  },
  {
    platform: 'wechat',
    conversation_name: '合成协议演练群',
    sender_name: '合成成员乙',
    timestamp: '2004-02-03T13:07:00+08:00',
    content: '合成角色乙选择三角纹作为封面。',
    source_message_id: 'wb-spike-002'
  },
  {
    platform: 'wechat',
    conversation_name: '合成协议演练群',
    sender_name: '合成成员丙',
    timestamp: '2004-02-03T13:08:00+08:00',
    content: '合成棋盘的 GitHub 练习项目仓库：https://github.com/example/synthetic-tiles',
    source_message_id: 'wb-spike-003'
  },
  {
    platform: 'wechat',
    conversation_name: '合成协议演练群',
    sender_name: '合成成员丁',
    timestamp: '2004-02-03T13:09:00+08:00',
    content: '虚构转盘的刻度先涂灰色。'
  }
]

describe('WorkBuddy MCP Connector Spike', () => {
  it('转换为 Standard Message 并保留 URL 与来源消息 ID', () => {
    const normalized = normalizeMessage(messages[2], 'workbuddy-mcp.json')
    expect(normalized.message.platform).toBe('wechat')
    expect(normalized.message.conversationName).toBe('合成协议演练群')
    expect(normalized.message.senderName).toBe('合成成员丙')
    expect(normalized.message.links).toEqual(['https://github.com/example/synthetic-tiles'])
    expect(normalized.sourceMessageId).toBe('wb-spike-003')
  })

  it('容忍坏数据、写入现有数据库、幂等去重并保持 FTS 与现有搜索可用', async () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)

    const first = ingestWorkBuddyMessages(db, {
      messages: [...messages, { platform: 'wechat', conversation_name: '合成协议演练群', sender_name: '坏数据' }]
    })
    expect(first.status).toBe('partial')
    expect(first.importedCount).toBe(4)
    expect(first.timingMs.rpcHandlerMs).toBeGreaterThanOrEqual(0)
    expect(first.timingMs.sqliteWriteAndFtsMs).toBeGreaterThanOrEqual(0)
    expect(first.invalidCount).toBe(1)
    expect(first).toMatchObject({ timestampPresentCount: 4, timestampMissingCount: 0, timestampInvalidCount: 0 })

    const second = ingestWorkBuddyMessages(db, {
      messages: [...messages, { platform: 'wechat', conversation_name: '合成协议演练群', sender_name: '坏数据' }]
    })
    expect(second.importedCount).toBe(0)
    expect(second.duplicateCount).toBe(4)
    expect(second.invalidCount).toBe(1)

    const stored = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }
    const fts = db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'GitHub'").get() as { count: number }
    expect(stored.count).toBe(4)
    expect(fts.count).toBe(1)
    const search = await askChat(db, '谁分享过 synthetic-tiles GitHub 项目？')
    expect(search.insufficientEvidence).toBe(false)
    expect(search.results.some((item) => item.senderName === '合成成员丙')).toBe(true)
    db.close()
  })

  it('九条快速导入返回完整的本地处理耗时分段', () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    const contents = [
      '合成纸鲸的尾巴涂成了青色。', '沙盘左格放一枚圆片。', '下一步拼接虚构月轮。', '折纸角先向内收。',
      '[图片] synthetic_workshop_009.jpg', '空白格暂不填色。',
      '合成角色甲把星纹卡归入方盒。', '本轮演练只摆放纸制道具。', '虚构纸鲸停在圆点的旁边。'
    ]
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: '九条耗时回归',
      batch_metadata: { conversation_name: 'PrivateRadar测试群', approximate_date: '2004-02-03' },
      messages: contents.map((content, source_position) => ({ content, source_position }))
    })
    expect(result.importedCount).toBe(9)
    expect(result).toMatchObject({ timestampPresentCount: 0, timestampMissingCount: 9, timestampInvalidCount: 0 })
    expect(Object.values(result.timingMs).every((value) => Number.isFinite(value) && value >= 0)).toBe(true)
    expect(result.timingMs.rpcHandlerMs).toBeGreaterThanOrEqual(
      result.timingMs.sqliteWriteAndFtsMs
    )
    db.close()
  })

  it('只接受已支持的带时区和无时区标准时间格式', () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: '时间格式回归',
      messages: [
        { content: '带时区时间', source_position: 0, timestamp: '2004-02-05T14:37:00+08:00', timestamp_source: 'source_native' },
        { content: '无时区标准时间', source_position: 1, timestamp: '2004-02-05 14:38:00', timestamp_source: 'user_supplied' }
      ]
    })
    const rows = db.prepare('SELECT timestamp, timestamp_source FROM messages ORDER BY source_position').all()
    expect(result).toMatchObject({ importedCount: 2, timestampPresentCount: 2, timestampMissingCount: 0, timestampInvalidCount: 0 })
    expect(rows).toEqual([
      { timestamp: '2004-02-05T06:37:00.000Z', timestamp_source: 'source_native' },
      { timestamp: '2004-02-05T06:38:00.000Z', timestamp_source: 'user_supplied' }
    ])
    db.close()
  })

  it('混合批次分别统计合法、缺失和非法时间且非法消息不入库', () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    const valid = Array.from({ length: 6 }, (_, source_position) => ({
      content: `有时间消息 ${source_position + 1}`,
      source_position,
      timestamp: `2004-02-05 14:${String(source_position).padStart(2, '0')}:00`,
      timestamp_source: 'source_native' as const
    }))
    const missing = Array.from({ length: 3 }, (_, index) => ({
      content: `缺时间消息 ${index + 1}`,
      source_position: index + 6
    }))
    const result = ingestWorkBuddyMessages(db, {
      source_batch_id: '混合时间完整性',
      messages: [...valid, ...missing, { content: '非法时间消息', source_position: 9, timestamp: 'not-a-time' }]
    })
    expect(result).toMatchObject({
      status: 'partial', recognizedCount: 9, importedCount: 9, invalidCount: 1,
      timestampPresentCount: 6, timestampMissingCount: 3, timestampInvalidCount: 1
    })
    expect(result.errors).toContain('第 10 条：时间格式无效')
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 9 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()).toEqual({ count: 9 })
    db.close()
  })

  it('保留旧公开消息工具并在任何产品写入前明确拒绝', async () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    const server = createWorkBuddyMcpServer(db)
    const client = new Client({ name: 'privateradar-test-client', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('privateradar_ingest_messages')
    const before = db.prepare('SELECT total_changes() AS count').get()
    const result = await client.callTool({
      name: 'privateradar_ingest_messages',
      arguments: { messages }
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('RAW_CURRENT_CONTEXT_REQUIRED')
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('privateradar_ingest_current_context_batch')
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM import_jobs').get()).toEqual({ count: 0 })

    await client.close()
    await server.close()
    db.close()
  })
})
