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
    expect(Object.values(result.timingMs).every((value) => Number.isFinite(value) && value >= 0)).toBe(true)
    expect(result.timingMs.rpcHandlerMs).toBeGreaterThanOrEqual(
      result.timingMs.sqliteWriteAndFtsMs
    )
    db.close()
  })

  it('通过标准 MCP Tool 接收消息并返回结构化统计', async () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    const server = createWorkBuddyMcpServer(db)
    const client = new Client({ name: 'privateradar-test-client', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain('privateradar_ingest_messages')
    const result = await client.callTool({
      name: 'privateradar_ingest_messages',
      arguments: { messages }
    })
    expect(result.structuredContent).toMatchObject({
      status: 'success',
      imported_count: 4,
      duplicate_count: 0,
      invalid_count: 0
    })
    expect((result.structuredContent as { timing_ms: { validation: number } }).timing_ms.validation).toBeGreaterThanOrEqual(0)

    await client.close()
    await server.close()
    db.close()
  })
})
