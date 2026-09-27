import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'
import { ingestWorkBuddyBatch } from '../src/main/integrations/workbuddy/batch-tool'
import { workBuddyBatchIngestSchema } from '../src/main/integrations/workbuddy/validation'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-workbuddy-batch-'))
  directories.push(directory)
  const chatHistoryRoot = join(directory, 'user', '.workbuddy', 'app', 'tmp', 'chat-history')
  const dataDirectory = join(directory, 'data')
  mkdirSync(chatHistoryRoot, { recursive: true })
  mkdirSync(dataDirectory, { recursive: true })
  const databasePath = join(dataDirectory, 'private-radar.db')
  const db = new DatabaseSync(databasePath)
  databases.push(db)
  initializeDatabase(db)
  const options = { databasePath, chatHistoryRoot }
  const firstZip = join(chatHistoryRoot, '第一张聊天卡.zip')
  const secondZip = join(chatHistoryRoot, '第二张聊天卡.zip')
  writeZip(firstZip, 1)
  writeZip(secondZip, 2)
  return { db, options, directory, chatHistoryRoot, firstZip, secondZip }
}

function writeZip(path: string, marker: number) {
  const bytes = Buffer.alloc(22)
  bytes.write('PK\u0005\u0006', 0, 'binary')
  bytes[8] = marker
  writeFileSync(path, bytes)
}

function attachment(path: string, prefix: string, count: number) {
  return {
    source_zip_path: path,
    source_hint: `当前卡片 ${prefix}`,
    messages: Array.from({ length: count }, (_, index) => ({
      platform: 'wechat', sender_name: '甲', content: `${prefix} 原文 ${index}`,
      source_position: index,
      timestamp: `2026-09-26T10:${String(index * 2).padStart(2, '0')}:00+08:00`,
      timestamp_source: 'source_native' as const
    }))
  }
}

function count(db: DatabaseSync, table: 'batch_import_sessions' | 'batch_import_items' | 'import_jobs' | 'messages' | 'messages_fts') {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

describe('alpha.15 WorkBuddy 双附件批量 Tool', () => {
  it('标准 MCP 调用一次写入 3 + 6，两个附件分别有证据、身份和任务', async () => {
    const f = fixture()
    const server = createWorkBuddyMcpServer(f.db, undefined, f.options)
    const client = new Client({ name: 'batch-tool-test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toContain('privateradar_ingest_batch')
      expect(tools.tools.map((tool) => tool.name)).toContain('privateradar_ingest_messages')
      const batchTool = tools.tools.find((tool) => tool.name === 'privateradar_ingest_batch')!
      const attachmentsSchema = (batchTool.inputSchema.properties as Record<string, { minItems: number; maxItems: number }>).attachments
      expect(attachmentsSchema).toMatchObject({ minItems: 2, maxItems: 2 })
      const response = await client.callTool({ name: 'privateradar_ingest_batch', arguments: {
        attachments: [attachment(f.firstZip, '甲', 3), attachment(f.secondZip, '乙', 6)]
      } })
      expect(response.isError).not.toBe(true)
      const output = response.structuredContent as {
        batch_session_id: string; status: string; summary: { attachments_total: number; imported_total: number }
        items: Array<{ item_id: string; effective_job_id: string; source_batch_id: string; attachment_identity: string }>
      }
      expect(output).toMatchObject({ status: 'success', summary: { attachments_total: 2, imported_total: 9 } })
      expect(output.items).toHaveLength(2)
      expect(output.items[0].item_id).not.toBe(output.items[1].item_id)
      expect(output.items[0].source_batch_id).not.toBe(output.items[1].source_batch_id)
      expect(output.items[0].effective_job_id).not.toBe(output.items[1].effective_job_id)
      expect(output.items[0].attachment_identity).not.toBe(output.items[1].attachment_identity)
      expect(count(f.db, 'batch_import_sessions')).toBe(1)
      expect(count(f.db, 'batch_import_items')).toBe(2)
      expect(count(f.db, 'import_jobs')).toBe(2)
      expect(count(f.db, 'messages')).toBe(9)
      expect(count(f.db, 'messages_fts')).toBe(9)
      const rows = f.db.prepare(`SELECT ordinal, attachment_identity, evidence_relative_path, snapshot_relative_path,
        source_hint FROM batch_import_items ORDER BY ordinal`).all() as Array<{
          ordinal: number; attachment_identity: string; evidence_relative_path: string; snapshot_relative_path: string; source_hint: string
        }>
      expect(rows.map((row) => row.ordinal)).toEqual([0, 1])
      expect(rows.map((row) => row.source_hint)).toEqual(['当前卡片 甲', '当前卡片 乙'])
      expect(rows[0].attachment_identity).toBe(createHash('sha256').update(readFileSync(f.firstZip)).digest('hex'))
      expect(rows[1].attachment_identity).toBe(createHash('sha256').update(readFileSync(f.secondZip)).digest('hex'))
      for (const [index, row] of rows.entries()) {
        const itemId = output.items[index].item_id
        expect(row.evidence_relative_path).toBe(`evidence/${itemId}/original.zip`)
        expect(row.snapshot_relative_path).toBe(`evidence/${itemId}/messages.json`)
        const snapshot = JSON.parse(readFileSync(join(f.directory, 'data', row.snapshot_relative_path), 'utf8')) as {
          input: { messages: Array<{ content: string }> }
        }
        expect(snapshot.input.messages).toHaveLength(index === 0 ? 3 : 6)
      }
      expect(f.db.prepare('SELECT batch_item_id FROM import_jobs ORDER BY rowid').all()).toEqual([
        { batch_item_id: output.items[0].item_id }, { batch_item_id: output.items[1].item_id }
      ])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('时间交错时仍各自按源数组顺序保存，群名缺失保持空值与未知来源', async () => {
    const f = fixture()
    const a = attachment(f.firstZip, '甲', 2)
    const b = attachment(f.secondZip, '乙', 2)
    a.messages[0].timestamp = '2026-09-26T12:00:00+08:00'
    a.messages[1].timestamp = '2026-09-26T09:00:00+08:00'
    b.messages[0].timestamp = '2026-09-26T11:00:00+08:00'
    b.messages[1].timestamp = '2026-09-26T08:00:00+08:00'
    const result = await ingestWorkBuddyBatch(f.db, f.options, { attachments: [a, b] })
    for (const [index, item] of result.items.entries()) {
      const rows = f.db.prepare(`SELECT content, source_position, conversation_name, conversation_name_source
        FROM messages WHERE source_batch_id = ? ORDER BY source_position`).all(item.source_batch_id) as Array<{
          content: string; source_position: number; conversation_name: string | null; conversation_name_source: string
        }>
      expect(rows.map((row) => [row.content, row.source_position])).toEqual(index === 0
        ? [['甲 原文 0', 0], ['甲 原文 1', 1]] : [['乙 原文 0', 0], ['乙 原文 1', 1]])
      expect(rows.every((row) => row.conversation_name === null && row.conversation_name_source === 'unknown')).toBe(true)
    }
  })

  it('源文本未提供逐条时间时，批量消息时间保持空值与未知来源', async () => {
    const f = fixture()
    const result = await ingestWorkBuddyBatch(f.db, f.options, { attachments: [
      { source_zip_path: f.firstZip, messages: [{ content: '甲无时间' }] },
      { source_zip_path: f.secondZip, messages: [{ content: '乙无时间' }] }
    ] })
    expect(result.status).toBe('success')
    expect(f.db.prepare('SELECT timestamp, timestamp_source FROM messages ORDER BY content').all()).toEqual([
      { timestamp: null, timestamp_source: 'unknown' },
      { timestamp: null, timestamp_source: 'unknown' }
    ])
  })

  it('显式来源位置与数组顺序不一致时先拒绝，不登记会话', async () => {
    const f = fixture()
    const first = attachment(f.firstZip, '甲', 2)
    first.messages[1].source_position = 9
    await expect(ingestWorkBuddyBatch(f.db, f.options, { attachments: [
      first, attachment(f.secondZip, '乙', 1)
    ] })).rejects.toThrow('原始位置与数组顺序不一致')
    expect(count(f.db, 'batch_import_sessions')).toBe(0)
  })

  it.each([0, 1])('附件 %i 路径不存在时先拒绝，不能登记任何会话、附件项或任务', async (missingIndex) => {
    const f = fixture()
    rmSync(missingIndex === 0 ? f.firstZip : f.secondZip)
    await expect(ingestWorkBuddyBatch(f.db, f.options, { attachments: [
      attachment(f.firstZip, '甲', 3), attachment(f.secondZip, '乙', 6)
    ] })).rejects.toThrow('当前附件真实路径不可用')
    expect(count(f.db, 'batch_import_sessions')).toBe(0)
    expect(count(f.db, 'batch_import_items')).toBe(0)
    expect(count(f.db, 'import_jobs')).toBe(0)
    expect(count(f.db, 'messages')).toBe(0)
  })

  it('两路径均存在但第二附件快照保存失败时，保留部分成功会话', async () => {
    const f = fixture()
    const second = attachment(f.secondZip, '乙', 6)
    // 仅在隔离测试中注入无法序列化的值，使故障发生在路径预检与原 ZIP 保存之后。
    Object.assign(second.messages[0], { snapshot_fault: BigInt(1) })
    const result = await ingestWorkBuddyBatch(f.db, f.options, { attachments: [
      attachment(f.firstZip, '甲', 3), second
    ] })
    expect(result).toMatchObject({ status: 'partial_success', summary: {
      attachments_total: 2, attachments_completed: 2, imported_total: 3, failed_attachments: 1
    } })
    expect(result.items[0]).toMatchObject({ outcome: 'success', imported: 3 })
    expect(result.items[1]).toMatchObject({ outcome: 'failed_zero_write', effective_job_id: null, imported: 0 })
    expect(result.items[1].error_summary).toContain('快照保存失败')
    expect(count(f.db, 'batch_import_sessions')).toBe(1)
    expect(count(f.db, 'batch_import_items')).toBe(2)
    expect(count(f.db, 'import_jobs')).toBe(1)
    expect(count(f.db, 'messages')).toBe(3)
  })

  it.each([0, 1, 3])('附件数量 %i 被结构和运行时拒绝，不创建会话', async (number) => {
    const f = fixture()
    const attachments = Array.from({ length: number }, (_, index) => attachment(index % 2 ? f.secondZip : f.firstZip, `项${index}`, 1))
    expect(workBuddyBatchIngestSchema.safeParse({ attachments }).success).toBe(false)
    await expect(ingestWorkBuddyBatch(f.db, f.options, { attachments })).rejects.toThrow()
    expect(count(f.db, 'batch_import_sessions')).toBe(0)
  })

  it('每附件 400 条的请求通过结构校验，不误用单数组 500 条上限', () => {
    const f = fixture()
    const input = { attachments: [attachment(f.firstZip, '甲', 400), attachment(f.secondZip, '乙', 400)] }
    expect(workBuddyBatchIngestSchema.safeParse(input).success).toBe(true)
  })

  it('越界路径和目录路径在会话创建前拒绝', async () => {
    const f = fixture()
    const outside = join(f.directory, 'outside.zip')
    writeZip(outside, 3)
    for (const badPath of [outside, join(f.chatHistoryRoot, '..', 'outside.zip'), f.chatHistoryRoot]) {
      await expect(ingestWorkBuddyBatch(f.db, f.options, { attachments: [
        attachment(f.firstZip, '甲', 1), attachment(badPath, '乙', 1)
      ] })).rejects.toThrow()
      expect(count(f.db, 'batch_import_sessions')).toBe(0)
      expect(count(f.db, 'import_jobs')).toBe(0)
    }
  })

  it('相同 ZIP 内容仍登记两个附件实例，不按 ZIP 哈希合并', async () => {
    const f = fixture()
    writeFileSync(f.secondZip, readFileSync(f.firstZip))
    const result = await ingestWorkBuddyBatch(f.db, f.options, { attachments: [
      attachment(f.firstZip, '甲', 1), attachment(f.secondZip, '乙', 2)
    ] })
    expect(result.items[0].attachment_identity).toBe(result.items[1].attachment_identity)
    expect(result.items[0].item_id).not.toBe(result.items[1].item_id)
    expect(result.items[0].source_batch_id).not.toBe(result.items[1].source_batch_id)
    expect(count(f.db, 'import_jobs')).toBe(2)
  })

  it('同一连接器中的旧单附件 Tool 继续工作且不创建批量会话', async () => {
    const f = fixture()
    const server = createWorkBuddyMcpServer(f.db, undefined, f.options)
    const client = new Client({ name: 'legacy-tool-test', version: '0.1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({ name: 'privateradar_ingest_messages', arguments: {
        messages: [{ content: '旧入口消息' }]
      } })
      expect(result.structuredContent).toMatchObject({ imported_count: 1, status: 'success' })
      expect(count(f.db, 'batch_import_sessions')).toBe(0)
      expect(count(f.db, 'messages')).toBe(1)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('根目录内部符号链接若指向外部，调用前拒绝且不建会话', async () => {
    const f = fixture()
    const outsideDirectory = join(f.directory, 'outside-directory')
    mkdirSync(outsideDirectory)
    const outside = join(outsideDirectory, 'outside.zip')
    writeZip(outside, 4)
    const link = join(f.chatHistoryRoot, 'link-directory')
    symlinkSync(outsideDirectory, link, 'junction')
    await expect(ingestWorkBuddyBatch(f.db, f.options, { attachments: [
      attachment(f.firstZip, '甲', 1), attachment(join(link, 'outside.zip'), '乙', 1)
    ] })).rejects.toThrow('不在允许的')
    expect(count(f.db, 'batch_import_sessions')).toBe(0)
  })
})
