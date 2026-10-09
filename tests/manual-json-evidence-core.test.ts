import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { importChatContent, importChatFile } from '../src/main/import/importer'
import type { ImportResult } from '../src/shared/models'
import * as evidence from '../src/main/batch-import/evidence'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { listItemMessageSources } from '../src/main/batch-import/message-sources'
import { claimBatchItemForFirstImport } from '../src/main/batch-import/import-item'
import { addKeywordTerm, createKeywordGroup } from '../src/main/keyword-radar/config'
import { getKeywordRadarRun, listFailedKeywordRadarRuns, listPendingKeywordRadarRuns } from '../src/main/keyword-radar/runs'
import { retryKeywordRadarRun } from '../src/main/keyword-radar/processor'
import * as keywordMatcher from '../src/main/keyword-radar/matcher'
import * as keywordRecovery from '../src/main/keyword-radar/recovery'
import * as commitmentRecovery from '../src/main/commitment/recovery'
import { processPendingCommitmentExtractorRuns } from '../src/main/commitment/recovery'
import { confirmCommitmentCandidate, ignoreCommitmentCandidate, getCommitmentCandidateContext, listCommitmentCandidates } from '../src/main/commitment/desktop'
import { getKeywordHitContext, listRecentKeywordHits } from '../src/main/keyword-radar/desktop'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { workBuddyIngestSchema } from '../src/main/integrations/workbuddy/validation'
import { parseSourcePositionsSnapshot } from '../src/main/keyword-radar/contracts'

type 文件结果 = ImportResult & { batchSessionId: string; batchItemId: string; rawSourceIdentity: string }
const fixtures: Array<{ db: DatabaseSync; directory: string; path: string }> = []
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
async function flush() {
  for (let tick = 0; tick < 12; tick++) await new Promise<void>(resolve => setImmediate(resolve))
}
afterEach(async () => {
  await flush()
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    if (f.db.isOpen) f.db.close()
    expect(dirname(resolve(f.directory))).toBe(resolve(tmpdir()))
    expect(basename(f.directory).startsWith('privateradar-manual-json-')).toBe(true)
    rmSync(f.directory, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-manual-json-'))
  const path = join(directory, 'private-radar.db'), db = new DatabaseSync(path)
  initializeDatabase(db)
  addKeywordTerm(db, createKeywordGroup(db, '文件').id, '文件')
  const f = { db, directory, path }
  fixtures.push(f)
  return f
}
function message(index = 0, content = '我会把文件' + index + '整理好发给你') {
  return { platform: 'manual-test', conversation_name: '隔离聊天', sender_name: '隔离发送人',
    timestamp: '2026-10-01T01:00:00.000Z', content, message_id: '隔离消息-' + index }
}
function rows(db: DatabaseSync, table: string) { return db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all() }
function count(db: DatabaseSync, table: string) { return Number(db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n) }
function state(db: DatabaseSync) {
  return ['messages', 'messages_fts_data', 'conversations', 'participants', 'message_links'].map(table => [table, rows(db, table)])
}
function item(f: ReturnType<typeof fixture>, result: 文件结果) {
  return f.db.prepare('SELECT * FROM batch_import_items WHERE id=?').get(result.batchItemId)!
}
async function importBytes(f: ReturnType<typeof fixture>, bytes: Buffer, name = '中文 原始材料.json') {
  const source = join(f.directory, name)
  writeFileSync(source, bytes)
  return await importChatFile(f.db, source, f.path) as 文件结果
}
async function importRows(f: ReturnType<typeof fixture>, values: unknown[]) {
  return importBytes(f, Buffer.from(JSON.stringify(values)))
}
function sourceBytes(f: ReturnType<typeof fixture>, result: 文件结果): Buffer {
  const stored = item(f, result), zip = readFileSync(join(f.directory, String(stored.evidence_relative_path)))
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  expect(zip.readUInt16LE(end + 10)).toBe(1)
  const directory = zip.readUInt32LE(end + 16)
  expect(zip.readUInt32LE(directory)).toBe(0x02014b50)
  expect(zip.readUInt16LE(directory + 10)).toBe(0)
  const nameLength = zip.readUInt16LE(directory + 28)
  expect(zip.subarray(directory + 46, directory + 46 + nameLength).toString()).toBe('source.json')
  const local = zip.readUInt32LE(directory + 42)
  expect(zip.readUInt32LE(local)).toBe(0x04034b50)
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
  const bytes = zip.subarray(start, start + zip.readUInt32LE(directory + 24))
  expect(crc32(bytes)).toBe(zip.readUInt32LE(directory + 16))
  expect(hash(zip)).toBe(stored.attachment_identity)
  expect(hash(bytes)).toBe(result.rawSourceIdentity)
  return bytes
}
async function failedItem(f: ReturnType<typeof fixture>, result: 文件结果, reason: string) {
  await flush()
  expect(result).toMatchObject({ status: 'failed', importedCount: 0, duplicateCount: 0, updatedCount: 0 })
  const stored = item(f, result)
  expect(stored).toMatchObject({ status: 'failed', evidence_status: 'available', effective_job_id: result.jobId })
  expect(String(stored.error_summary)).toContain(reason)
  expect(f.db.prepare('SELECT status FROM batch_import_sessions WHERE id=?').get(result.batchSessionId)!.status).toBe('failed')
  expect(f.db.prepare('SELECT status FROM import_jobs WHERE id=?').get(result.jobId)!.status).toBe('failed')
  expect(listItemMessageSources(f.db, result.batchItemId)).toEqual([])
  for (const table of ['keyword_radar_runs', 'commitment_extractor_runs', 'keyword_hits', 'commitment_candidates']) {
    expect(f.db.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE batch_item_id=?').get(result.batchItemId)!.n).toBe(0)
  }
  expect((await evidence.verifyBatchEvidence(f.db, f.path, result.batchItemId)).source.status).toBe('available')
}
describe('共享手动 JSON 原始证据来源链', () => {
  it('相同指纹不同正文明确失败，canonical 不变且 Raw 保留', async () => {
    const f = fixture(), { message_id: _id, ...old } = message(0, '报价  更新')
    importChatContent(f.db, '旧来源.json', 'JSON', JSON.stringify([old]))
    const before = state(f.db), bytes = Buffer.from(JSON.stringify([{ ...old, content: '报价 更新' }]))
    const result = await importBytes(f, bytes)
    await failedItem(f, result, 'SOURCE_CONTENT_CONFLICT')
    expect(state(f.db)).toEqual(before)
    expect(result.errors.join('')).toMatch(/本来源未导入.*归一化指纹相同.*原文不同/)
    expect(result.errors.join('')).toMatch(/未绑定.*未覆盖.*修改/)
    expect(sourceBytes(f, result)).toEqual(bytes)
  })
  it('第 31 条冲突回滚前 30 条新增、复用、引用和 FTS', async () => {
    const f = fixture()
    importChatContent(f.db, '旧来源.json', 'JSON', JSON.stringify([message(0), message(30, '报价  更新')]))
    const before = state(f.db)
    const values = Array.from({ length: 100 }, (_, i) => message(i, i === 30 ? '报价 更新' : '我会把文件' + i + '发给你'))
    values[0] = message(0)
    const result = await importRows(f, values)
    await failedItem(f, result, 'SOURCE_CONTENT_CONFLICT')
    expect(result.errors.join('')).toContain('source_position=30')
    expect(state(f.db)).toEqual(before)
  })
  it('相同正文只增加来源，可靠元数据不能补全 canonical', async () => {
    const f = fixture(), value = { ...message(), sender_name_source: 'inferred', conversation_name_source: 'inferred', timestamp_source: 'inferred' }
    importChatContent(f.db, '旧来源.json', 'JSON', JSON.stringify([value]))
    const before = state(f.db)
    const result = await importRows(f, [{ ...value, sender_name: '新的发送人', conversation_name: '新的会话',
      timestamp: '2026-10-02T01:00:00.000Z', sender_name_source: 'source_native',
      conversation_name_source: 'source_native', timestamp_source: 'source_native' }])
    expect(result).toMatchObject({ status: 'success', importedCount: 0, updatedCount: 0, duplicateCount: 1 })
    expect(state(f.db)).toEqual(before)
    expect(listItemMessageSources(f.db, result.batchItemId)[0]).toMatchObject({ source_sender_name: '新的发送人',
      source_conversation_name: '新的会话', source_timestamp: '2026-10-02T01:00:00.000Z' })
  })
  it.each([confirmCommitmentCandidate, ignoreCommitmentCandidate])('重选文件形成独立来源及候选项，旧审核保持不变：%s', async review => {
    const f = fixture(), bytes = Buffer.from(JSON.stringify([message()]))
    const first = await importBytes(f, bytes)
    await flush()
    const old = listCommitmentCandidates(f.db)[0]
    review(f.db, old.id)
    const reviewed = rows(f.db, 'commitment_candidates')[0]
    const second = await importBytes(f, bytes)
    await flush()
    expect(second.batchItemId).not.toBe(first.batchItemId)
    expect(second.batchSessionId).not.toBe(first.batchSessionId)
    expect(second.rawSourceIdentity).toBe(first.rawSourceIdentity)
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 1, updatedCount: 0 })
    expect(item(f, second).evidence_relative_path).not.toBe(item(f, first).evidence_relative_path)
    expect(count(f.db, 'messages')).toBe(1)
    expect(count(f.db, 'batch_item_message_sources')).toBe(2)
    expect(count(f.db, 'keyword_hits')).toBe(2)
    expect(count(f.db, 'commitment_candidates')).toBe(2)
    expect(rows(f.db, 'commitment_candidates').find(row => row.id === old.id)).toEqual(reviewed)
    expect(listCommitmentCandidates(f.db).every(row => row.chatTimestamp === message().timestamp)).toBe(true)
  })
  it('原始字节、固定 ZIP 条目、原始哈希和独立快照可验证', async () => {
    const f = fixture(), bytes = Buffer.from('\ufeff' + JSON.stringify({ messages: [message()] }, null, 2).replace(/\n/g, '\r\n') + '\r\n')
    const result = await importBytes(f, bytes)
    expect(sourceBytes(f, result)).toEqual(bytes)
    expect(f.db.prepare('SELECT source FROM batch_import_sessions WHERE id=?').get(result.batchSessionId)!.source).toBe('file')
    expect((await evidence.verifyBatchEvidence(f.db, f.path, result.batchItemId)).status).toBe('available')
    const stored = item(f, result), snapshot = JSON.parse(readFileSync(join(f.directory, String(stored.snapshot_relative_path)), 'utf8'))
    expect(snapshot.input.messages[0]).toMatchObject({ source_position: 0, valid: true, value: message() })
    expect(snapshot.input.raw_source_sha256).toBe(hash(bytes))
    expect(snapshot.input.raw_source_bytes).toBe(bytes.length)
    expect(stored.snapshot_relative_path).not.toBe(stored.evidence_relative_path)
  })
  it('旧手动数据不回填、不重写、不重跑，数据库结构不变', async () => {
    const f = fixture(), legacy = importChatContent(f.db, '历史.json', 'JSON', JSON.stringify([message(900, '历史记录')]))
    const oldMessage = rows(f.db, 'messages')[0], oldJob = rows(f.db, 'import_jobs')[0]
    const schema = f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()
    const version = f.db.prepare('PRAGMA user_version').get()
    const result = await importRows(f, [message()])
    await flush()
    expect(result.status).toBe('success')
    expect(rows(f.db, 'messages').find(row => row.id === oldMessage.id)).toEqual(oldMessage)
    expect(rows(f.db, 'import_jobs').find(row => row.id === legacy.jobId)).toEqual(oldJob)
    expect(f.db.prepare('SELECT * FROM batch_item_message_sources WHERE message_id=?').all(oldMessage.id)).toEqual([])
    expect(f.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schema)
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual(version)
    expect(count(f.db, 'keyword_radar_runs')).toBe(1)
    expect(count(f.db, 'commitment_extractor_runs')).toBe(1)
  })
  it.each([500, 501])('手动 JSON %i 条通过快照、Run、处理及失败重试', async n => {
    const f = fixture()
    const matcher = vi.spyOn(keywordMatcher, 'matchKeywordSnapshot').mockImplementation(() => { throw new Error('受控派生失败') })
    const result = await importRows(f, Array.from({ length: n }, (_, i) => message(i)))
    expect(result).toMatchObject({ status: 'success', importedCount: n })
    expect(listPendingKeywordRadarRuns(f.db)).toHaveLength(1)
    expect(JSON.parse(getKeywordRadarRun(f.db, result.batchItemId)!.source_positions_snapshot_json)).toHaveLength(n)
    expect((await evidence.verifyBatchEvidence(f.db, f.path, result.batchItemId)).status).toBe('available')
    await flush()
    expect(listFailedKeywordRadarRuns(f.db)).toHaveLength(1)
    matcher.mockRestore()
    expect(retryKeywordRadarRun(f.db, result.batchItemId).status).toBe('complete')
    expect(count(f.db, 'keyword_hits')).toBe(n)
    expect(count(f.db, 'commitment_candidates')).toBe(n)
    expect(item(f, result).status).toBe('success')
  }, 20000)
  it('WorkBuddy 500/501 契约和可信来源隔离保持原样', () => {
    const f = fixture(), values = Array.from({ length: 501 }, (_, i) => ({ content: '文件' + i }))
    expect(workBuddyIngestSchema.safeParse({ messages: values.slice(0, 500) }).success).toBe(true)
    expect(workBuddyIngestSchema.safeParse({ messages: values }).success).toBe(false)
    const session = createBatchImportSession(f.db, 'workbuddy'), stored = createBatchImportItem(f.db, session.id, 0)
    f.db.prepare('UPDATE batch_import_items SET source_batch_id=? WHERE id=?').run('file:json:item:' + stored.id, stored.id)
    const result = ingestWorkBuddyMessages(f.db, { messages: values.slice(0, 500) }, 0, {
      batchItemId: stored.id, sourceBatchId: 'file:json:item:' + stored.id })
    expect(result.status).toBe('success')
    expect(ingestWorkBuddyMessages(f.db, { messages: values }, 0, { batchItemId: stored.id }).status).toBe('failed')
    expect(() => parseSourcePositionsSnapshot(JSON.stringify(Array.from({ length: 501 }, (_, i) => i)))).toThrow()
  })
  it.each([{ values: [] }, { values: [null, {}, { content: '缺少元数据' }] }])('零有效消息保留 Raw 并失败：%j', async ({ values }) => {
    const f = fixture(), bytes = Buffer.from(JSON.stringify(values)), result = await importBytes(f, bytes)
    await failedItem(f, result, 'NO_VALID_MESSAGES')
    expect(sourceBytes(f, result)).toEqual(bytes)
    expect(count(f.db, 'messages')).toBe(0)
  })
  it('90 有效、10 无效部分成功，快照和两个 Run 保留原位置', async () => {
    const f = fixture(), values = Array.from({ length: 100 }, (_, i) => i % 10 === 1 ? null : message(i))
    const result = await importRows(f, values)
    await flush()
    const positions = values.flatMap((row, i) => row ? [i] : [])
    expect(result).toMatchObject({ status: 'partial', importedCount: 90, invalidCount: 10 })
    expect(item(f, result).status).toBe('partial_success')
    expect(listItemMessageSources(f.db, result.batchItemId).map(row => row.source_position)).toEqual(positions)
    const snapshot = JSON.parse(readFileSync(join(f.directory, String(item(f, result).snapshot_relative_path)), 'utf8'))
    expect(snapshot.input.messages.map((row: { source_position: number }) => row.source_position)).toEqual(Array.from({ length: 100 }, (_, i) => i))
    expect(snapshot.input.messages[1]).toMatchObject({ source_position: 1, valid: false, value: null })
    expect(JSON.parse(getKeywordRadarRun(f.db, result.batchItemId)!.source_positions_snapshot_json)).toEqual(positions)
    expect(JSON.parse(f.db.prepare('SELECT source_positions_snapshot_json FROM commitment_extractor_runs WHERE batch_item_id=?').get(result.batchItemId)!.source_positions_snapshot_json as string)).toEqual(positions)
    const hit = listRecentKeywordHits(f.db).find(hit => hit.batchItemId === result.batchItemId)!
    const hitContext = getKeywordHitContext(f.db, hit.id)
    expect(hitContext.batchItemId).toBe(result.batchItemId)
    expect(hitContext.entries.length).toBeGreaterThan(0)
    expect(hitContext.entries.every(row => row.batchItemId === result.batchItemId && positions.includes(row.sourcePosition) &&
      row.chatTimestamp === message().timestamp && row.senderName === '隔离发送人')).toBe(true)
    const candidate = listCommitmentCandidates(f.db).find(candidate => candidate.batchItemId === result.batchItemId)!
    const candidateContext = getCommitmentCandidateContext(f.db, candidate.id)
    expect(candidateContext.batchItemId).toBe(result.batchItemId)
    expect(candidateContext.entries.length).toBeGreaterThan(0)
    expect(candidateContext.entries.every(row => row.batchItemId === result.batchItemId && positions.includes(row.sourcePosition) &&
      row.chatTimestamp === message().timestamp)).toBe(true)
  })
  it.each([[' 报价 更新 ', '报价 更新'], ['报价\t更新', '报价 更新'], ['报价\r\n更新', '报价\n更新'],
    ['报价 Ａ', '报价 A']])('空白、换行和 Unicode 差异必须失败：%j', async (old, incoming) => {
    const f = fixture()
    importChatContent(f.db, '历史.json', 'JSON', JSON.stringify([message(0, old)]))
    // 历史路径会 trim；此隔离 fixture 验证已有原字符串与新正文的严格比较。
    if (old.trim() !== old) f.db.prepare('UPDATE messages SET content=?').run(old)
    const before = state(f.db), result = await importRows(f, [message(0, incoming)])
    await failedItem(f, result, 'SOURCE_CONTENT_CONFLICT')
    expect(state(f.db)).toEqual(before)
  })
  it('新插入的字符串正文也不 trim', async () => {
    const f = fixture(), body = '  我会把文件发给你\r\n', result = await importRows(f, [message(0, body)])
    expect(result.status).toBe('success')
    expect(rows(f.db, 'messages')[0].content).toBe(body)
  })
  it('失败信息与普通日志不包含聊天正文', async () => {
    const f = fixture(), secret = '私密聊天正文  不得进入日志'
    importChatContent(f.db, '历史.json', 'JSON', JSON.stringify([message(0, secret)]))
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {})]
    const result = await importRows(f, [message(0, secret.replace('  ', ' '))])
    await failedItem(f, result, 'SOURCE_CONTENT_CONFLICT')
    const diagnostics = JSON.stringify([result.errors, item(f, result).error_summary,
      f.db.prepare('SELECT error_details_json FROM import_jobs WHERE id=?').get(result.jobId), spies.flatMap(spy => spy.mock.calls)])
    expect(diagnostics).not.toContain(secret)
    expect(diagnostics).not.toContain(secret.replace('  ', ' '))
  })
  it('派生失败不改变已提交来源、canonical、Raw 和终态', async () => {
    const f = fixture()
    vi.spyOn(keywordMatcher, 'matchKeywordSnapshot').mockImplementation(() => { throw new Error('敏感异常正文') })
    const result = await importRows(f, [message()]), before = state(f.db), stored = item(f, result), bytes = sourceBytes(f, result)
    await flush()
    expect(result.status).toBe('success')
    expect(state(f.db)).toEqual(before)
    expect(item(f, result)).toEqual(stored)
    expect(sourceBytes(f, result)).toEqual(bytes)
    expect(getKeywordRadarRun(f.db, result.batchItemId)!.status).toBe('failed')
    expect(count(f.db, 'commitment_candidates')).toBe(1)
  })
  it('COMMIT 后诊断异常不能伪报核心失败或零写入', async () => {
    const f = fixture(), prepare = f.db.prepare.bind(f.db)
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (!f.db.isTransaction && sql.includes('WHERE m.import_job_id = ?')) throw new Error('受控诊断异常')
      return prepare(sql)
    })
    const result = await importRows(f, [message()])
    expect(result).toMatchObject({ status: 'success', importedCount: 1 })
    expect(result.errors.join('')).toContain('POST_COMMIT')
    expect(item(f, result).status).toBe('success')
    expect(rows(f.db, 'import_jobs')[0].status).toBe('success')
    expect(count(f.db, 'messages')).toBe(1)
    expect(listItemMessageSources(f.db, result.batchItemId)).toHaveLength(1)
  })
  it.each([500, 501])('%i 条两个 Run 的 pending 重启后处理，不回扫旧手动数据', async n => {
    const f = fixture()
    importChatContent(f.db, '历史.json', 'JSON', JSON.stringify([message(9999)]))
    const scheduler = vi.spyOn(keywordRecovery, 'schedulePendingKeywordRadarRuns').mockImplementation(() => {})
    const commitmentScheduler = vi.spyOn(commitmentRecovery, 'schedulePendingCommitmentExtractorRuns').mockImplementation(() => {})
    const result = await importRows(f, Array.from({ length: n }, (_, i) => message(i)))
    await flush()
    f.db.close()
    f.db = new DatabaseSync(f.path)
    initializeDatabase(f.db)
    scheduler.mockRestore()
    commitmentScheduler.mockRestore()
    expect(listPendingKeywordRadarRuns(f.db)).toHaveLength(1)
    expect(f.db.prepare('SELECT status FROM commitment_extractor_runs WHERE batch_item_id=?').get(result.batchItemId)!.status).toBe('pending')
    expect((await keywordRecovery.processPendingKeywordRadarRuns(f.db))[0].status).toBe('complete')
    await processPendingCommitmentExtractorRuns(f.db)
    expect(count(f.db, 'keyword_hits')).toBe(n)
    expect(count(f.db, 'commitment_candidates')).toBe(n)
    expect(count(f.db, 'batch_item_message_sources')).toBe(n)
    expect((await evidence.verifyBatchEvidence(f.db, f.path, result.batchItemId)).status).toBe('available')
    expect(claimBatchItemForFirstImport(f.db, result.batchItemId)).toBe('terminal')
  }, 20000)
  it('同一新 Item 内第二条指纹冲突也回滚整项', async () => {
    const f = fixture(), before = state(f.db)
    const result = await importRows(f, [message(0, '报价  更新'), message(1, '报价 更新')])
    await failedItem(f, result, 'SOURCE_CONTENT_CONFLICT')
    expect(state(f.db)).toEqual(before)
  })
  it('强身份复用不能绕过独立指纹冲突检查', async () => {
    const f = fixture(), first = { ...message(0, '报价 更新'), sender_name: '甲' }, second = { ...message(1, '报价  更新'), sender_name: '乙' }
    expect(importChatContent(f.db, '历史.json', 'JSON', JSON.stringify([first, second])).importedCount).toBe(2)
    const before = state(f.db), result = await importRows(f, [{ ...first, sender_name: '乙' }])
    await failedItem(f, result, 'SOURCE_CONTENT_CONFLICT')
    expect(state(f.db)).toEqual(before)
  })
  it('捕获后原路径改变，证据和导入仍消费同一份捕获字节', async () => {
    const f = fixture(), bytes = Buffer.from(JSON.stringify([message()])), original = evidence.saveCapturedJsonEvidence
    vi.spyOn(evidence, 'saveCapturedJsonEvidence').mockImplementationOnce(async (...args) => {
      writeFileSync(join(f.directory, '中文 原始材料.json'), JSON.stringify([message(99, '捕获后替换内容')]))
      return original(...args)
    })
    const result = await importBytes(f, bytes)
    expect(result).toMatchObject({ status: 'success', importedCount: 1 })
    expect(sourceBytes(f, result)).toEqual(bytes)
    expect(rows(f.db, 'messages')[0].content).toBe(message().content)
  })
  it('快照失败保留已封存 Raw，失败状态无核心写入且诊断不泄露异常正文', async () => {
    const f = fixture(), bytes = Buffer.from(JSON.stringify([message()]))
    vi.spyOn(evidence, 'saveStructuredSnapshot').mockRejectedValueOnce(new Error('秘密异常全文'))
    const result = await importBytes(f, bytes)
    await failedItem(f, result, 'MANUAL_JSON_PREPARATION_FAILED')
    expect(sourceBytes(f, result)).toEqual(bytes)
    expect(item(f, result).snapshot_relative_path).toBeNull()
    expect(result.errors.join('')).not.toContain('秘密异常全文')
    expect(count(f.db, 'messages')).toBe(0)
  })
  it('已有 Raw 目标不得覆盖或接管，也不进入核心事务', async () => {
    const f = fixture(), original = evidence.saveCapturedJsonEvidence, orphan = Buffer.from('已有孤立证据')
    let target = ''
    vi.spyOn(evidence, 'saveCapturedJsonEvidence').mockImplementationOnce(async (...args) => {
      const directory = join(f.directory, 'evidence', args[2])
      mkdirSync(directory, { recursive: true })
      target = join(directory, 'original.zip')
      writeFileSync(target, orphan)
      return original(...args)
    })
    const result = await importRows(f, [message()])
    expect(result.status).toBe('failed')
    expect(item(f, result)).toMatchObject({ status: 'failed', effective_job_id: result.jobId, evidence_relative_path: null })
    expect(readFileSync(target)).toEqual(orphan)
    expect(count(f.db, 'messages')).toBe(0)
    expect(count(f.db, 'keyword_radar_runs')).toBe(0)
    expect(count(f.db, 'commitment_extractor_runs')).toBe(0)
  })
  it('Item 终态保存失败会回滚 canonical、FTS、来源和两个 Run', async () => {
    const f = fixture(), before = state(f.db)
    f.db.exec("CREATE TRIGGER 隔离终态失败 BEFORE UPDATE OF status ON batch_import_items WHEN NEW.status='success' BEGIN SELECT RAISE(ABORT,'受控终态失败'); END")
    const result = await importRows(f, [message()])
    await failedItem(f, result, 'MANUAL_JSON_CORE_FAILED')
    expect(state(f.db)).toEqual(before)
  })
  it('一个派生调度器异常不阻断另一个，待处理 Run 可恢复', async () => {
    const f = fixture()
    vi.spyOn(keywordRecovery, 'schedulePendingKeywordRadarRuns').mockImplementation(() => { throw new Error('秘密调度异常') })
    const result = await importRows(f, [message()])
    await flush()
    expect(result).toMatchObject({ status: 'success', importedCount: 1 })
    expect(item(f, result).status).toBe('success')
    expect(result.errors.join('')).toContain('POST_COMMIT_DERIVED_SCHEDULE_FAILED')
    expect(result.errors.join('')).not.toContain('秘密调度异常')
    expect(count(f.db, 'commitment_candidates')).toBe(1)
    expect(listPendingKeywordRadarRuns(f.db)).toHaveLength(1)
    expect((await keywordRecovery.processPendingKeywordRadarRuns(f.db))[0].status).toBe('complete')
    expect(count(f.db, 'keyword_hits')).toBe(1)
  })
  it('50 MiB 文件容量边界仍在捕获前拒绝，不创建 Session 或 job', async () => {
    const f = fixture(), source = join(f.directory, '超限.json')
    writeFileSync(source, '')
    truncateSync(source, 50 * 1024 * 1024 + 1)
    await expect(importChatFile(f.db, source, f.path)).rejects.toThrow('文件超过 50 MB')
    expect(count(f.db, 'batch_import_sessions')).toBe(0)
    expect(count(f.db, 'import_jobs')).toBe(0)
  })
  it.each(['csv', 'txt'])('文件入口保留 %s 的 legacy 路径', async type => {
    const f = fixture(), body = type === 'csv'
      ? 'timestamp,conversation_name,sender_name,content\n2026-10-01 09:00:00,隔离聊天,甲,我会把文件发给你'
      : '2026-10-01 09:00:00\t隔离聊天\t甲\t我会把文件发给你'
    const source = join(f.directory, '旧格式.' + type)
    writeFileSync(source, body)
    const first = await importChatFile(f.db, source, f.path), second = await importChatFile(f.db, source, f.path)
    expect(first).toMatchObject({ status: 'success', importedCount: 1 })
    expect(second).toMatchObject({ status: 'success', duplicateCount: 1 })
    expect(count(f.db, 'batch_import_items')).toBe(0)
    expect(count(f.db, 'batch_import_sessions')).toBe(0)
    expect(count(f.db, 'batch_item_message_sources')).toBe(0)
    expect(count(f.db, 'keyword_radar_runs')).toBe(0)
  })
})
