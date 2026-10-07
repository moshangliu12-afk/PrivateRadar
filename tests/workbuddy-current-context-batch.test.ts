import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createCollection, listCollectionSessions } from '../src/main/collections/service'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'
import { ingestWorkBuddyCurrentContextBatch, prepareWorkBuddyCurrentContextBatch } from '../src/main/integrations/workbuddy/batch-tool'
import { WORKBUDDY_CURRENT_CONTEXT_LIMITS, workBuddyCurrentContextBatchSchema } from '../src/main/integrations/workbuddy/validation'
import { gateWorkBuddyBatchCurrentInput, type WorkBuddyCurrentContextBlock } from '../src/main/import/workbuddy-current-input'
import { createBatchImportItem, createBatchImportSession, listBatchImportItems } from '../src/main/batch-import/repository'
import * as directoryEvidence from '../src/main/batch-import/directory-evidence'
import { loadStructuredSnapshot, saveStructuredSnapshot, verifyBatchEvidence } from '../src/main/batch-import/evidence'
import { importSavedBatchItem } from '../src/main/batch-import/import-item'
import { executeBatchImportSession, resumeInterruptedBatchImportSession } from '../src/main/batch-import/session'
import { WindowsPathLease } from '../src/main/batch-import/windows-path-lease'

vi.mock('../src/main/batch-import/directory-evidence', async (original) => ({
  ...await original<typeof directoryEvidence>()
}))
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof fs>() }))

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function context(path: string, label: string, total: number): WorkBuddyCurrentContextBlock {
  const headers = Array.from({ length: total }, (_, index) => ({
    sender: index === 1 ? '-' : `·${label}${index}`,
    time: `2026年9月${index % 2 ? 25 : 27}日 ${index % 2 ? '09' : '17'}:0${index}`,
    body: `${label}:消息 ${index}\n第二段 😀`
  }))
  return {
    file: `仅展示_${label}.zip`, extracted_dir_path: path, message_count: total,
    first_sender: headers[0].sender, first_message_at: headers[0].time,
    transcript: headers.map((row) => `${row.sender}\n${row.time}\n${row.body}`).join('\n\n') + '\n'
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-current-batch-'))
  directories.push(directory)
  const chatHistoryRoot = join(directory, 'user', '.workbuddy', 'app', 'tmp', 'chat-history')
  const data = join(directory, 'data')
  mkdirSync(data)
  const paths = [join(chatHistoryRoot, '明确目录甲'), join(chatHistoryRoot, '明确目录乙')]
  for (const [index, path] of paths.entries()) {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, '聊天记录.txt'), `证据 TXT ${index} 没有消息时间，不得用它替代 inline`)
  }
  const databasePath = join(data, 'private-radar.db')
  const db = new DatabaseSync(databasePath)
  databases.push(db)
  initializeDatabase(db)
  const contexts = [context(paths[0], '甲', 3), context(paths[1], '乙', 4)]
  const changes = db.prepare('SELECT total_changes() AS count').get()
  return { directory, data, paths, contexts, db, options: { databasePath, chatHistoryRoot }, changes }
}
type Fixture = ReturnType<typeof fixture>
function request(contexts: WorkBuddyCurrentContextBlock[]) { return { mode: 'current_context' as const, contexts } }
function count(f: Fixture, table: 'messages' | 'messages_fts' | 'import_jobs' | 'batch_import_sessions' | 'batch_import_items') {
  return (f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}
function noSideEffects(f: Fixture) {
  for (const table of ['messages', 'messages_fts', 'import_jobs', 'batch_import_sessions', 'batch_import_items'] as const) {
    expect(count(f, table)).toBe(0)
  }
  expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(f.changes)
  expect(existsSync(join(f.data, 'evidence'))).toBe(false)
}
function removeSources(f: Fixture) {
  for (const path of f.paths) rmSync(path, { recursive: true })
  // 删除后访问原源路径立刻失败；证明恢复没有重新使用 WorkBuddy 临时来源。
  for (const key of ['lstat', 'realpath', 'opendir', 'readFile'] as const) {
    const actual = fs[key]
    vi.spyOn(fs, key).mockImplementation(((path: string, ...args: unknown[]) => {
      const resolved = resolve(String(path))
      if (f.paths.some((source) => resolved === source || resolved.startsWith(source + sep))) {
        throw new Error('恢复不应访问已删除的源目录')
      }
      return Reflect.apply(actual, fs, [path, ...args])
    }) as never)
  }
}

describe('当前卡片上下文到目录证据的完整批量链路', () => {
  it('四份序列化中图片记录边界空行不同，仍按原首份正文归集两项并完整保留媒体证据', async () => {
    const f = fixture()
    const collection = createCollection(f.db, '序列化空行隔离归集')
    const first = context(f.paths[0], '普通文本卡', 10)
    const bodies = ['第一条正文', '第二条\n正文内部换行', '第三条\n\n正文内部段落',
      '[图片] 隔离图片一.png', '图片后文本', '[图片] 隔离图片二.png', '最后一条正文']
    const records = bodies.map((body, index) => `·隔离发送人\n2026年10月6日 08:0${index}\n${body}`)
    const second: WorkBuddyCurrentContextBlock = { extracted_dir_path: f.paths[1], file: '隔离图片卡.zip',
      message_count: 7, first_sender: '·隔离发送人', first_message_at: '2026年10月6日 08:00',
      transcript: records.join('\n\n') }
    const mediaRoot = join(f.paths[1], '聊天记录内的图片、视频和文件')
    mkdirSync(mediaRoot)
    // 合成小 PNG 仅用于验证文件字节保全；不包含真实用户图片，也不做内容理解。
    const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7xkAAAAASUVORK5CYII=', 'base64')
    for (const name of ['隔离图片一.png', '隔离图片二.png']) writeFileSync(join(mediaRoot, name), picture)
    const contexts = [first, second, { ...first }, { ...second, transcript: records.join('\n\n\n') }]
    const normalized = gateWorkBuddyBatchCurrentInput(contexts)
    expect(normalized.logical_attachments.map(a => a.context_indexes)).toEqual([[0, 2], [1, 3]])
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, {
      ...request(contexts), collection_id: collection.id
    })
    expect(result).toMatchObject({ status: 'success', collection_id: collection.id, summary: {
      attachments_total: 2, attachments_completed: 2, input_messages_total: 17, imported_total: 17,
      duplicate_total: 0, updated_total: 0, invalid_total: 0
    } })
    expect(result.items.map(item => item.imported)).toEqual([10, 7])
    expect([count(f, 'batch_import_sessions'), count(f, 'batch_import_items'), count(f, 'import_jobs'),
      count(f, 'messages'), count(f, 'messages_fts')]).toEqual([1, 2, 2, 17, 17])
    expect(listCollectionSessions(f.db, collection.id)).toHaveLength(1)
    expect(f.db.prepare('SELECT status FROM collections WHERE id=?').get(collection.id)).toEqual({ status: 'collecting' })
    expect(result.items[0].effective_job_id).not.toBe(result.items[1].effective_job_id)
    const imageItem = result.items[1]
    const evidenceRoot = join(f.data, 'evidence', imageItem.item_id)
    const snapshot = JSON.parse(readFileSync(join(evidenceRoot, 'messages.json'), 'utf8')).input
    expect(snapshot.current_context).toMatchObject({ transcript: second.transcript, context_indexes: [1, 3], raw_context_count: 4 })
    expect(snapshot.messages.map((m: { content: string }) => m.content)).toEqual(bodies)
    const rows = f.db.prepare('SELECT content,source_position FROM messages WHERE source_batch_id=? ORDER BY source_position').all(imageItem.source_batch_id)
    expect(rows).toEqual(bodies.map((content, source_position) => ({ content, source_position })))
    for (const name of ['隔离图片一.png', '隔离图片二.png']) {
      expect(readFileSync(join(evidenceRoot, 'source', '聊天记录内的图片、视频和文件', name))).toEqual(picture)
    }
    const verified = await verifyBatchEvidence(f.db, f.options.databasePath, imageItem.item_id)
    expect(verified.status).toBe('available')
    expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }, 120000)

  it('标准 MCP 接收原始四块上下文，3+4 只形成两项、两套证据、两个任务及七条消息', async () => {
    const f = fixture()
    const server = createWorkBuddyMcpServer(f.db, undefined, f.options)
    const client = new Client({ name: 'current-context-test', version: '0.1.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const tools = (await client.listTools()).tools
      expect(tools.map((tool) => tool.name)).toEqual([
        'privateradar_ingest_messages', 'privateradar_ingest_current_context_batch'
      ])
      expect(tools.map((tool) => tool.name)).not.toContain('privateradar_ingest_batch')
      const schema = tools.find((tool) => tool.name === 'privateradar_ingest_current_context_batch')!.inputSchema
      expect(schema.additionalProperties).toBe(false)
      expect(schema.required).toEqual(expect.arrayContaining(['mode', 'contexts']))
      const fields = schema.properties as Record<string, any>
      expect(fields.contexts).toMatchObject({ minItems: 1, maxItems: 16 })
      expect(fields.contexts.items.additionalProperties).toBe(false)
      expect(fields.contexts.items.required).toEqual(expect.arrayContaining(['extracted_dir_path', 'transcript', 'message_count', 'file']))
      expect(fields.contexts.items.properties.message_count).toMatchObject({ minimum: 1, maximum: 500 })
      expect(fields.contexts.items.properties.transcript.maxLength).toBe(WORKBUDDY_CURRENT_CONTEXT_LIMITS.maxTranscriptCharacters)

      const response = await client.callTool({ name: 'privateradar_ingest_current_context_batch', arguments: request([
        f.contexts[0], { ...f.contexts[0] }, f.contexts[1], { ...f.contexts[1] }
      ]) })
      expect(response.isError).not.toBe(true)
      const result = response.structuredContent as Awaited<ReturnType<typeof ingestWorkBuddyCurrentContextBatch>>
      expect(result).toMatchObject({ status: 'success', summary: {
        attachments_total: 2, attachments_completed: 2, input_messages_total: 7, imported_total: 7,
        duplicate_total: 0, updated_total: 0, invalid_total: 0
      } })
      expect([count(f, 'batch_import_sessions'), count(f, 'batch_import_items'), count(f, 'import_jobs'),
        count(f, 'messages'), count(f, 'messages_fts')]).toEqual([1, 2, 2, 7, 7])
      expect(readdirSync(join(f.data, 'evidence')).sort()).toEqual(result.items.map((item) => item.item_id).sort())
      const expected = gateWorkBuddyBatchCurrentInput(f.contexts).logical_attachments
      for (const [index, item] of result.items.entries()) {
        expect(item.source_batch_id).toBe(`workbuddy:item:${item.item_id}`)
        expect(item.evidence_relative_path).toBe(`evidence/${item.item_id}/manifest.json`)
        const root = join(f.data, 'evidence', item.item_id)
        expect(existsSync(join(root, 'original.zip'))).toBe(false)
        const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
        expect(item.attachment_identity).toBe(manifest.directory_content_identity)
        expect(readFileSync(join(root, 'source', '聊天记录.txt'), 'utf8')).toContain('不得用它替代 inline')
        const snapshot = JSON.parse(readFileSync(join(root, 'messages.json'), 'utf8')).input
        expect(snapshot.messages).toEqual(expected[index].messages)
        expect(snapshot.current_context).toMatchObject({
          transcript: f.contexts[index].transcript, raw_context_count: 4, context_indexes: index ? [2, 3] : [0, 1]
        })
        expect(snapshot.parser.timezone_interpretation).toEqual(expected[index].timezone_interpretation)
        const rows = f.db.prepare(`SELECT content, sender_name, source_position, timestamp, timestamp_source,
          conversation_name, conversation_name_source FROM messages WHERE source_batch_id = ? ORDER BY source_position`).all(item.source_batch_id)
        expect(rows).toEqual(expected[index].messages.map((message) => ({
          content: message.content, sender_name: message.sender_name, source_position: message.source_position,
          timestamp: new Date(message.timestamp).toISOString(), timestamp_source: 'source_native',
          conversation_name: null, conversation_name_source: 'unknown'
        })))
      }
      expect(result.items[0].effective_job_id).not.toBe(result.items[1].effective_job_id)
    } finally { await client.close(); await server.close() }
  }, 120000)

  it.each(['三个独立附件', '同路径正文冲突', '同路径截断标记冲突'])('%s 在任何写入前拒绝', async (kind) => {
    const f = fixture()
    const contexts = kind === '三个独立附件' ? [...f.contexts, { ...f.contexts[0], extracted_dir_path: join(f.options.chatHistoryRoot, '第三个') }]
        : [f.contexts[0], { ...f.contexts[0], transcript: kind === '同路径截断标记冲突'
          ? f.contexts[0].transcript + '[truncated]' : f.contexts[0].transcript.replace('消息', '不同') }, f.contexts[1]]
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(contexts))).rejects.toMatchObject({
      code: kind.includes('冲突') ? 'DUPLICATE_CONTEXT_CONFLICT' : 'LOGICAL_ATTACHMENT_COUNT_MISMATCH'
    })
    noSideEffects(f)
  })

  it.each([0, 1])('附件 %i 目录缺失在创建会话之前拒绝', async (index) => {
    const f = fixture()
    rmSync(f.paths[index], { recursive: true })
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))).rejects.toThrow('路径不可用')
    noSideEffects(f)
  }, 30000)

  it.each(['相对路径', '根目录', '越界目录', '普通文件', '上级路径', '目录链接', '祖先链接'])('%s 不通过入口预检', async (kind) => {
    const f = fixture()
    const outside = join(f.directory, '外部目录')
    mkdirSync(outside)
    let path = kind === '相对路径' ? '明确目录甲'
      : kind === '根目录' ? f.options.chatHistoryRoot
        : kind === '越界目录' ? outside
          : kind === '普通文件' ? join(f.paths[0], '聊天记录.txt')
            : `${f.options.chatHistoryRoot}${sep}..${sep}chat-history${sep}明确目录甲`
    if (kind === '目录链接' || kind === '祖先链接') {
      const link = join(f.options.chatHistoryRoot, '链接')
      symlinkSync(f.paths[0], link, 'junction')
      if (kind === '祖先链接') { mkdirSync(join(f.paths[0], '子目录')); path = join(link, '子目录') }
      else path = link
    }
    f.contexts[0].extracted_dir_path = path
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))).rejects.toThrow()
    noSideEffects(f)
  }, 30000)

  it('原生安全能力不可用时入口预检拒绝，不创建会话或证据', async () => {
    const f = fixture()
    vi.spyOn(WindowsPathLease.prototype, 'lock').mockRejectedValue(new Error('模拟原生能力不可用'))
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))).rejects.toThrow('不可用')
    noSideEffects(f)
  }, 30000)

  it.each([0, 1])('附件 %i Parser 失败时整批零副作用', async (index) => {
    const f = fixture()
    f.contexts[index].message_count += 1
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))).rejects.toMatchObject({ code: 'INVALID_CURRENT_TRANSCRIPT' })
    noSideEffects(f)
  })

  it.each([0, 1])('附件 %i 明确截断时整批拒绝', async (index) => {
    const f = fixture()
    f.contexts[index].truncated = true
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))).rejects.toMatchObject({ code: 'TRUNCATED_CURRENT_CONTEXT' })
    noSideEffects(f)
  })

  it.each(['[truncated]', '[内容已截断]', '[聊天记录已截断]', '<truncated/>'])('独立截断标记 %s 不作为正文导入', async (marker) => {
    const f = fixture()
    f.contexts[1].transcript += marker
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))).rejects.toMatchObject({ code: 'TRUNCATED_CURRENT_CONTEXT' })
    noSideEffects(f)
  })

  it('严格契约拒绝混用字段、自由 messages、超限及错误类型，保留可选字段缺失语义', async () => {
    const f = fixture()
    const base = request(f.contexts)
    expect(workBuddyCurrentContextBatchSchema.safeParse(base).success).toBe(true)
    const bad = [
      { ...base, mode: 'zip' }, { contexts: f.contexts }, { ...base, attachments: [] }, { ...base, messages: [] },
      ...[{ messages: [] }, { source_zip_path: 'C:\\附件.zip' }, { extracted_dir_path: undefined },
        { message_count: 0 }, { message_count: 501 }, { message_count: '3' }, { truncated: 'false' },
        { transcript: 'x'.repeat(WORKBUDDY_CURRENT_CONTEXT_LIMITS.maxTranscriptCharacters + 1) }
      ].map((change) => request([{ ...f.contexts[0], ...change } as WorkBuddyCurrentContextBlock, f.contexts[1]])),
      request(Array(17).fill(f.contexts[0])),
      request(Array(16).fill({ ...f.contexts[0], transcript: '中'.repeat(WORKBUDDY_CURRENT_CONTEXT_LIMITS.maxTranscriptCharacters) }))
    ]
    for (const value of bad) {
      expect(workBuddyCurrentContextBatchSchema.safeParse(value).success).toBe(false)
      await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, value)).rejects.toThrow()
    }
    noSideEffects(f)
  })

  it('相同显示名、正文与目录内容的不同路径仍有独立实例和来源', async () => {
    const f = fixture()
    writeFileSync(join(f.paths[1], '聊天记录.txt'), readFileSync(join(f.paths[0], '聊天记录.txt')))
    f.contexts[1] = { ...f.contexts[0], extracted_dir_path: f.paths[1] }
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))
    const [a, b] = result.items
    expect(result.status).toBe('success')
    expect(a.attachment_identity).toBe(b.attachment_identity)
    expect(a.item_id).not.toBe(b.item_id)
    expect(a.source_batch_id).not.toBe(b.source_batch_id)
    expect(a.evidence_relative_path).not.toBe(b.evidence_relative_path)
    expect(a.effective_job_id).not.toBe(b.effective_job_id)
    expect([count(f, 'batch_import_items'), count(f, 'import_jobs'), count(f, 'messages'), count(f, 'messages_fts')]).toEqual([2, 2, 6, 6])
  }, 120000)

  it('路径预检通过后乙源目录消失，甲仍导入且会话部分成功', async () => {
    const f = fixture()
    const actual = directoryEvidence.saveDirectoryEvidence
    vi.spyOn(directoryEvidence, 'saveDirectoryEvidence').mockImplementation(async (...args) => {
      const item = f.db.prepare('SELECT attachment_identity, evidence_source_kind FROM batch_import_items WHERE id = ?').get(args[2])
      expect(item).toEqual({ attachment_identity: null, evidence_source_kind: 'directory' })
      if (args[3] === f.paths[1]) rmSync(f.paths[1], { recursive: true })
      return actual(...args)
    })
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))
    expect(result).toMatchObject({ status: 'partial_success', summary: { imported_total: 3, failed_attachments: 1 } })
    expect(result.items[0]).toMatchObject({ outcome: 'success', imported: 3 })
    expect(result.items[1]).toMatchObject({ outcome: 'failed_zero_write', attachment_identity: null,
      evidence_relative_path: null, effective_job_id: null })
    expect(count(f, 'import_jobs')).toBe(1)
    expect(count(f, 'messages_fts')).toBe(3)
  }, 120000)

  it('乙导入器运行失败保留甲的提交、乙的真实失败任务和部分成功会话', async () => {
    const f = fixture()
    f.db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON messages
      WHEN NEW.content LIKE '乙:%' BEGIN SELECT RAISE(ABORT, '模拟乙消息写入失败'); END;`)
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))
    expect(result).toMatchObject({ status: 'partial_success', summary: { imported_total: 3, failed_attachments: 1 } })
    expect(result.items[1]).toMatchObject({ outcome: 'failed_zero_write', job_status: 'failed' })
    expect(result.items[1].errors).toContain('模拟乙消息写入失败')
    expect([count(f, 'import_jobs'), count(f, 'messages'), count(f, 'messages_fts')]).toEqual([2, 3, 3])
  }, 120000)

  it('普通重复执行拒绝，显式同项重放分别保持 duplicate-only 和 updated-only 成功语义', async () => {
    const f = fixture()
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))
    const [a, b] = result.items
    const identities = f.db.prepare('SELECT id, source_batch_id, source_position, stable_identity, fingerprint FROM messages ORDER BY rowid').all()
    await expect(importSavedBatchItem(f.db, f.options.databasePath, a.item_id)).rejects.toThrow('terminal')
    expect(count(f, 'import_jobs')).toBe(2)
    const duplicate = await importSavedBatchItem(f.db, f.options.databasePath, a.item_id, 'deterministic_replay')
    expect(duplicate).toMatchObject({ status: 'success', importedCount: 0, duplicateCount: 3, updatedCount: 0 })
    // 仅在隔离库构造待补充元数据，重放使用原有持久快照，不修改证据或身份。
    f.db.prepare("UPDATE messages SET timestamp = NULL, timestamp_source = 'unknown' WHERE source_batch_id = ?").run(b.source_batch_id)
    const updated = await importSavedBatchItem(f.db, f.options.databasePath, b.item_id, 'deterministic_replay')
    expect(updated).toMatchObject({ status: 'success', importedCount: 0, duplicateCount: 0, updatedCount: 4 })
    expect(listBatchImportItems(f.db, result.batch_session_id).map((item) => item.status)).toEqual(['success', 'success'])
    expect(f.db.prepare('SELECT id, source_batch_id, source_position, stable_identity, fingerprint FROM messages ORDER BY rowid').all()).toEqual(identities)
    expect([count(f, 'messages'), count(f, 'messages_fts')]).toEqual([7, 7])
  }, 120000)

  it('两份目录证据就绪后删除源，首次执行及中断恢复只依赖持久快照且不重放成功项', async () => {
    const f = fixture()
    const sessionId = await prepareWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))
    const [a, b] = listBatchImportItems(f.db, sessionId)
    expect(count(f, 'import_jobs')).toBe(0)
    expect(a.attachment_identity).toMatch(/^[0-9a-f]{64}$/)
    removeSources(f)
    for (const item of [a, b]) expect((await verifyBatchEvidence(f.db, f.options.databasePath, item.id)).status).toBe('available')
    const first = await importSavedBatchItem(f.db, f.options.databasePath, a.id)
    f.db.prepare("UPDATE batch_import_sessions SET status = 'in_progress' WHERE id = ?").run(sessionId)
    const resumed = await resumeInterruptedBatchImportSession(f.db, f.options.databasePath, sessionId)
    expect(resumed).toMatchObject({ status: 'success', imported_total: 7 })
    expect(f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').all(a.id)).toEqual([{ id: first.jobId }])
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM import_jobs WHERE batch_item_id = ?').get(b.id)).toEqual({ count: 1 })
    expect([count(f, 'messages'), count(f, 'messages_fts')]).toEqual([7, 7])
  }, 120000)

  it('需关注项不自动重放；含糊的处理中项阻止恢复', async () => {
    const f = fixture()
    const sessionId = await prepareWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))
    const [a, b] = listBatchImportItems(f.db, sessionId)
    f.db.exec(`CREATE TRIGGER fail_first_metadata BEFORE INSERT ON message_import_batches
      WHEN NEW.source_batch_id = 'workbuddy:item:${a.id}' BEGIN SELECT RAISE(ABORT, '模拟元数据失败'); END;`)
    await expect(importSavedBatchItem(f.db, f.options.databasePath, a.id)).rejects.toThrow('模拟元数据失败')
    const jobs = f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').all(a.id)
    f.db.prepare("UPDATE batch_import_sessions SET status = 'in_progress' WHERE id = ?").run(sessionId)
    f.db.prepare("UPDATE batch_import_items SET status = 'in_progress' WHERE id = ?").run(a.id)
    await expect(resumeInterruptedBatchImportSession(f.db, f.options.databasePath, sessionId)).rejects.toThrow('需人工处理')
    expect(count(f, 'import_jobs')).toBe(1)
    // 恢复原有已终结失败状态，验证它不会自动重试，但未开始的乙可以继续。
    f.db.prepare("UPDATE batch_import_items SET status = 'failed' WHERE id = ?").run(a.id)
    removeSources(f)
    const result = await resumeInterruptedBatchImportSession(f.db, f.options.databasePath, sessionId)
    expect(result).toMatchObject({ status: 'partial_success', attention_required_attachments: 1 })
    expect(result.items[0].outcome).toBe('needs_attention')
    expect(result.items[1]).toMatchObject({ item_id: b.id, outcome: 'success' })
    expect(f.db.prepare('SELECT id FROM import_jobs WHERE batch_item_id = ?').all(a.id)).toEqual(jobs)
    expect(count(f, 'messages')).toBe(7)
  }, 120000)

  it('目录证据篡改后重放被拦截，不生成新任务或消息', async () => {
    const f = fixture()
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))
    const item = result.items[0]
    writeFileSync(join(f.data, 'evidence', item.item_id, 'source', '聊天记录.txt'), '被修改')
    await expect(importSavedBatchItem(f.db, f.options.databasePath, item.item_id, 'deterministic_replay')).rejects.toThrow('corrupt')
    expect([count(f, 'import_jobs'), count(f, 'messages'), count(f, 'messages_fts')]).toEqual([2, 7, 7])
  }, 120000)

  it('当前 Parser 无日期输入整批拒绝，不用文件或导入时间补造', async () => {
    const f = fixture()
    f.contexts[1].transcript = '·乙\n没有原始时间\n'
    f.contexts[1].message_count = 1
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))).rejects.toMatchObject({ code: 'INVALID_CURRENT_TRANSCRIPT' })
    noSideEffects(f)
  })

  it('既有目录证据与 importer 接收未知时间快照时仍保存 null / unknown', async () => {
    const f = fixture()
    // 当前 Parser 不支持无时间语法；此项单独验证既有下游时间规则，不伪称为当前 Parser 产出。
    const session = createBatchImportSession(f.db, 'workbuddy')
    const item = createBatchImportItem(f.db, session.id, 0)
    await directoryEvidence.saveDirectoryEvidence(f.db, f.options.databasePath, item.id, f.paths[0])
    await saveStructuredSnapshot(f.db, f.options.databasePath, item.id, {
      messages: [{ content: '未知时间原文', timestamp_source: 'unknown', source_position: 0 }]
    })
    const result = await importSavedBatchItem(f.db, f.options.databasePath, item.id)
    expect(result).toMatchObject({ status: 'success', importedCount: 1 })
    expect(f.db.prepare('SELECT timestamp, timestamp_source FROM messages').get()).toEqual({ timestamp: null, timestamp_source: 'unknown' })
    expect(count(f, 'messages_fts')).toBe(1)
  }, 60000)

  it('已验收七消息原文 fixture 通过新上下文链路且快照保持原文', async () => {
    const f = fixture()
    const transcript = readFileSync(new URL('./fixtures/workbuddy-chat-history/current-inline-seven.txt', import.meta.url), 'utf8')
    f.contexts[0] = { file: '七条原文.zip', extracted_dir_path: f.paths[0], message_count: 7, transcript }
    f.contexts[1] = context(f.paths[1], '乙', 1)
    const sessionId = await prepareWorkBuddyCurrentContextBatch(f.db, f.options, request(f.contexts))
    const first = listBatchImportItems(f.db, sessionId)[0]
    const snapshot = await loadStructuredSnapshot(f.db, f.options.databasePath, first.id)
    expect(snapshot.messages).toEqual(gateWorkBuddyBatchCurrentInput(f.contexts).logical_attachments[0].messages)
    const result = await executeBatchImportSession(f.db, f.options.databasePath, sessionId)
    expect(result).toMatchObject({ status: 'success', imported_total: 8 })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE source_batch_id = ?').get(`workbuddy:item:${first.id}`)).toEqual({ count: 7 })
    expect(count(f, 'messages_fts')).toBe(8)
  }, 120000)
})
