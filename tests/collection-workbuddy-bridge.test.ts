import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createCollection, completeCollection, listCollectionSessions } from '../src/main/collections/service'
import * as batchRepository from '../src/main/batch-import/repository'
import { WindowsPathLease } from '../src/main/batch-import/windows-path-lease'
import { ingestWorkBuddyCurrentContextBatch } from '../src/main/integrations/workbuddy/batch-tool'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'
import type { WorkBuddyBatchResult, WorkBuddyIngestInput } from '../src/main/integrations/workbuddy/validation'

vi.mock('../src/main/batch-import/repository', async (original) => ({ ...await original<typeof batchRepository>() }))

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) {
    expect(resolve(directory)).toBe(directory)
    expect(resolve(directory, '..')).toBe(resolve(tmpdir()))
    expect(basename(directory).startsWith('privateradar-collection-bridge-')).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-collection-bridge-'))
  directories.push(directory)
  const data = join(directory, 'data')
  mkdirSync(data)
  const databasePath = join(data, 'private-radar.db')
  const db = new DatabaseSync(databasePath)
  databases.push(db)
  initializeDatabase(db)
  const chatHistoryRoot = join(directory, 'user', '.workbuddy', 'app', 'tmp', 'chat-history')
  const contexts = ['甲', '乙'].map((label) => {
    const path = join(chatHistoryRoot, label)
    mkdirSync(path, { recursive: true })
    const transcript = Array.from({ length: 6 }, (_, index) =>
      `·隔离发送者${label}\n2026年10月5日 20:0${index}\n合成归集消息${label}${index}`).join('\n\n') + '\n'
    writeFileSync(join(path, '聊天记录.txt'), transcript)
    return { file: `隔离${label}.zip`, extracted_dir_path: path, message_count: 6, transcript }
  })
  return { db, data, options: { databasePath, chatHistoryRoot }, contexts }
}
type Fixture = ReturnType<typeof fixture>

function request(f: Fixture, rawCount = 3, collectionId?: string) {
  const contexts = rawCount === 3 ? [f.contexts[0], { ...f.contexts[0] }, f.contexts[1]]
    : [f.contexts[0], { ...f.contexts[0] }, f.contexts[1], { ...f.contexts[1] }]
  return { mode: 'current_context' as const, contexts,
    ...(collectionId === undefined ? {} : { collection_id: collectionId }) }
}

const protectedTables = ['batch_import_sessions', 'batch_import_items', 'import_jobs', 'messages',
  'messages_fts', 'message_import_batches', 'app_settings', 'collections']
function snapshot(f: Fixture) {
  return protectedTables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
}
function noSideEffects(f: Fixture, before: ReturnType<typeof snapshot>) {
  expect(snapshot(f)).toEqual(before)
  expect(existsSync(join(f.data, 'evidence'))).toBe(false)
  for (const table of protectedTables.slice(0, 6)) {
    expect(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
  }
  expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
}

async function withClient(f: Fixture, operation: (client: Client) => Promise<void>) {
  const server = createWorkBuddyMcpServer(f.db, undefined, f.options)
  const client = new Client({ name: '归集隔离验收', version: '0.1.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(b)
    await client.connect(a)
    await operation(client)
  } finally { await client.close(); await server.close() }
}

describe('显式归集到当前双卡导入桥接', () => {
  it.each([3, 4])('真实 MCP %i 个原始上下文仍归组为两个附件，指定归集在创建会话时已持久化', async (rawCount) => {
    const f = fixture()
    const collection = createCollection(f.db, '明确归集')
    await withClient(f, async (client) => {
      const tools = (await client.listTools()).tools
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'privateradar_ingest_current_context_batch', 'privateradar_ingest_messages'
      ])
      const schema = tools.find((tool) => tool.name === 'privateradar_ingest_current_context_batch')!
      expect(schema.inputSchema.required).not.toContain('collection_id')
      expect(schema.inputSchema.properties?.collection_id).toMatchObject({ type: 'string', format: 'uuid' })
      expect(schema.outputSchema?.required).toEqual(expect.arrayContaining(['collection_id', 'session_id', 'batch_session_id', 'items']))
      const response = await client.callTool({ name: 'privateradar_ingest_current_context_batch',
        arguments: request(f, rawCount, collection.id) })
      expect(response.isError).not.toBe(true)
      const result = response.structuredContent as WorkBuddyBatchResult
      expect(result).toMatchObject({ collection_id: collection.id, session_id: result.batch_session_id,
        status: 'success', summary: { attachments_total: 2, imported_total: 12 } })
      expect(result.items.map((item) => item.imported)).toEqual([6, 6])
      const persisted = f.db.prepare('SELECT id, collection_id FROM batch_import_sessions WHERE id = ?').get(result.session_id)
      expect(persisted).toEqual({ id: result.session_id, collection_id: result.collection_id })
      expect(listCollectionSessions(f.db, collection.id)).toHaveLength(1)
      expect(new Set(result.items.map((item) => item.item_id)).size).toBe(2)
      expect(new Set(result.items.map((item) => item.effective_job_id)).size).toBe(2)
      expect(readdirSync(join(f.data, 'evidence')).sort()).toEqual(result.items.map((item) => item.item_id).sort())
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()).toEqual({ count: 12 })
    })
  }, 60000)

  it('未提供归集时不选择最近记录，旧双卡行为和空归属保持不变', async () => {
    const f = fixture()
    const unrelated = createCollection(f.db, '最近也不能猜测')
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f))
    expect(result).toMatchObject({ collection_id: null, session_id: result.batch_session_id,
      status: 'success', summary: { imported_total: 12 } })
    expect(f.db.prepare('SELECT collection_id FROM batch_import_sessions WHERE id = ?').get(result.session_id))
      .toEqual({ collection_id: null })
    expect(listCollectionSessions(f.db, unrelated.id)).toEqual([])
  }, 60000)

  it.each(['', '不是UUID', 'b3e54cd789d2f9ce23fbc2f09444b4b7e19b6393', '00000000-0000-4000-8000-00000000000',
    ' 00000000-0000-4000-8000-000000000000 ', null, 16])('非法归集身份 %j 最早拒绝，不创建记录、证据或路径租约', async (id) => {
    const f = fixture()
    const before = snapshot(f)
    const changes = f.db.prepare('SELECT total_changes() AS count').get()
    const lock = vi.spyOn(WindowsPathLease.prototype, 'lock')
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, { ...request(f), collection_id: id }))
      .rejects.toThrow('INVALID_COLLECTION_ID')
    expect(lock).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
    noSideEffects(f, before)
  })

  it.each(['不存在', '已完成'])('UUID 合法但归集%s时，真实 MCP 明确失败且不降级普通导入', async (state) => {
    const f = fixture()
    const collectionId = state === '不存在' ? randomUUID() : createCollection(f.db, '已完成归集').id
    if (state === '已完成') completeCollection(f.db, collectionId)
    const before = snapshot(f)
    const changes = f.db.prepare('SELECT total_changes() AS count').get()
    const lock = vi.spyOn(WindowsPathLease.prototype, 'lock')
    await withClient(f, async (client) => {
      const response = await client.callTool({ name: 'privateradar_ingest_current_context_batch',
        arguments: request(f, 3, collectionId) })
      expect(response.isError).toBe(true)
      expect(JSON.stringify(response.content)).toContain(state === '不存在' ? 'COLLECTION_NOT_FOUND' : 'COLLECTION_COMPLETED')
    })
    expect(lock).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
    noSideEffects(f, before)
  })

  it('单卡携带归集身份在真实 MCP 明确拒绝，内部单卡适配器同样不静默忽略', async () => {
    const f = fixture()
    const input = { messages: [{ content: '隔离单卡消息' }], collection_id: createCollection(f.db, '甲').id }
    const before = snapshot(f)
    await withClient(f, async (client) => {
      const response = await client.callTool({ name: 'privateradar_ingest_messages', arguments: input })
      expect(response.isError).toBe(true)
      expect(JSON.stringify(response.content)).toContain('COLLECTION_NOT_SUPPORTED_FOR_SINGLE_IMPORT')
    })
    expect(() => ingestWorkBuddyMessages(f.db, input as unknown as WorkBuddyIngestInput))
      .toThrow('COLLECTION_NOT_SUPPORTED_FOR_SINGLE_IMPORT')
    noSideEffects(f, before)
  })

  it('旧消息单卡入口明确拒绝且没有持久化写入', async () => {
    const f = fixture()
    const before = snapshot(f)
    await withClient(f, async (client) => {
      const response = await client.callTool({ name: 'privateradar_ingest_messages',
        arguments: { messages: [{ content: '隔离单卡原行为' }] } })
      expect(response.isError).toBe(true)
      expect(response.structuredContent).toBeUndefined()
      expect((response.content[0] as { text: string }).text).toContain('RAW_CURRENT_CONTEXT_REQUIRED')
    })
    noSideEffects(f, before)
  })

  it('同一归集多次调用产生独立会话、附件、任务和证据，不引入跨附件去重', async () => {
    const f = fixture()
    const collection = createCollection(f.db, '长期归集')
    const first = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f, 3, collection.id))
    const second = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f, 4, collection.id))
    expect(first.session_id).not.toBe(second.session_id)
    expect([first.collection_id, second.collection_id]).toEqual([collection.id, collection.id])
    const sessions = listCollectionSessions(f.db, collection.id)
    expect(sessions.map((session) => session.id).sort()).toEqual([first.session_id, second.session_id].sort())
    expect(sessions.every((session) => session.collection_id === collection.id)).toBe(true)
    const items = [...first.items, ...second.items]
    for (const key of ['item_id', 'effective_job_id', 'evidence_relative_path', 'source_batch_id'] as const) {
      expect(new Set(items.map((item) => item[key])).size).toBe(4)
    }
    expect(readdirSync(join(f.data, 'evidence')).sort()).toEqual(items.map((item) => item.item_id).sort())
    for (const item of items) {
      expect(existsSync(join(f.data, item.evidence_relative_path!))).toBe(true)
      expect(readFileSync(join(f.data, 'evidence', item.item_id, 'messages.json'), 'utf8')).toContain('合成归集消息')
    }
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 24 })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()).toEqual({ count: 24 })
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }, 60000)

  it('成功结果读取最终持久会话，不依赖创建函数的临时返回对象', async () => {
    const f = fixture()
    const collection = createCollection(f.db, '甲')
    const original = batchRepository.createBatchImportSession
    vi.spyOn(batchRepository, 'createBatchImportSession').mockImplementationOnce((...args) => {
      const session = original(...args)
      // 只在隔离测试中制造错误返回对象，真实持久数据保持指定归属。
      return { ...session, collection_id: null }
    })
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f, 3, collection.id))
    expect(result.collection_id).toBe(collection.id)
    expect(f.db.prepare('SELECT id, collection_id FROM batch_import_sessions WHERE id = ?').get(result.session_id))
      .toEqual({ id: result.session_id, collection_id: result.collection_id })
  }, 60000)

  it('早期预检通过后归集被另一连接完成，创建事务复核拒绝且无孤儿记录', async () => {
    const f = fixture()
    const collection = createCollection(f.db, '竞态归集')
    const other = new DatabaseSync(f.options.databasePath)
    databases.push(other)
    initializeDatabase(other)
    const original = WindowsPathLease.prototype.lock
    vi.spyOn(WindowsPathLease.prototype, 'lock').mockImplementationOnce(async function (this: WindowsPathLease, ...args) {
      completeCollection(other, collection.id)
      return original.apply(this, args)
    })
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f, 3, collection.id)))
      .rejects.toThrow('COLLECTION_COMPLETED')
    for (const table of protectedTables.slice(0, 6)) {
      expect(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    expect(existsSync(join(f.data, 'evidence'))).toBe(false)
    expect(listCollectionSessions(f.db, collection.id)).toEqual([])
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }, 60000)

  it('第二附件登记失败回滚会话和第一附件，不发布证据或创建任务', async () => {
    const f = fixture()
    const collection = createCollection(f.db, '登记失败')
    const before = snapshot(f)
    const original = batchRepository.createBatchImportItem
    vi.spyOn(batchRepository, 'createBatchImportItem').mockImplementationOnce((...args) => original(...args))
      .mockImplementationOnce(() => { throw new Error('隔离第二附件登记失败') })
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f, 3, collection.id)))
      .rejects.toThrow('隔离第二附件登记失败')
    noSideEffects(f, before)
  }, 60000)
})
