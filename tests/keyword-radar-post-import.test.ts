import { sharedCoreState, sharedCount, sharedRows, drainSharedDerived } from './shared-core-fixture'
import { sharedJsonFixture, importSharedJson, sharedEvidenceBytes } from './shared-json-evidence-fixture'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeywordGroup, addKeywordTerm } from '../src/main/keyword-radar/config'
import * as matcher from '../src/main/keyword-radar/matcher'
import * as recovery from '../src/main/keyword-radar/recovery'
import { ingestWorkBuddyBatch, ingestWorkBuddyCurrentContextBatch } from '../src/main/integrations/workbuddy/batch-tool'
import { radarFixture, radarMessages, radarCount, cleanupRadarFixtures } from './keyword-radar-fixture'

afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
function prepared() {
  const f = radarFixture()
  const root = join(f.directory, 'user', '.workbuddy', 'app', 'tmp', 'chat-history')
  mkdirSync(root, { recursive: true })
  addKeywordTerm(f.db, createKeywordGroup(f.db, '工具').id, 'Codex')
  const attachments = [0, 1].map(index => {
    const path = join(root, `隔离卡片${index}.zip`)
    const bytes = Buffer.alloc(22)
    bytes.write('PK\u0005\u0006', 0, 'binary')
    bytes[8] = index + 1
    writeFileSync(path, bytes)
    return { source_zip_path: path, messages: radarMessages([index + 100]) }
  })
  return { ...f, root, attachments, options: { databasePath: f.path, chatHistoryRoot: root } }
}
function coreState(f: ReturnType<typeof prepared>) {
  return f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'keyword_%' AND name NOT LIKE 'commitment_%' ORDER BY name")
    .all().map(row => String(row.name))
    .map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort()])
}
function evidenceState(root: string): Array<[string, string]> {
  const values: Array<[string, string]> = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) values.push(...evidenceState(path))
    else values.push([path, createHash('sha256').update(readFileSync(path)).digest('hex')])
  }
  return values.sort((a, b) => a[0].localeCompare(b[0]))
}
async function flushCallbacks() {
  for (let tick = 0; tick < 10; tick++) await new Promise<void>(resolve => setImmediate(resolve))
}
describe('批量导入后派生失败隔离', () => {
  it.skipIf(process.platform !== 'win32').each([false, true])('核心成功结果在派生匹配失败后保持，包括部分成功=%s', async partial => {
    const f = prepared()
    if (partial) f.attachments[0].messages.push({ ...radarMessages([999])[0], content: undefined })
    vi.spyOn(matcher, 'matchKeywordSnapshot').mockImplementation(() => { throw new Error('秘密聊天不能出现在日志') })
    const output = await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    expect(output.status).toBe(partial ? 'partial_success' : 'success')
    expect(output.summary.imported_total).toBe(2)
    const beforeCore = coreState(f), beforeEvidence = evidenceState(join(f.directory, 'evidence'))
    const beforeOutput = JSON.stringify(output)
    await flushCallbacks()
    expect(JSON.stringify(output)).toBe(beforeOutput)
    expect(coreState(f)).toEqual(beforeCore)
    expect(evidenceState(join(f.directory, 'evidence'))).toEqual(beforeEvidence)
    expect(f.db.prepare("SELECT count(*) AS n FROM keyword_radar_runs WHERE status='failed'").get()!.n).toBe(2)
    expect(radarCount(f.db, 'keyword_hits')).toBe(0)
  })
  it.skipIf(process.platform !== 'win32')('派生触发自身抛错不改变核心结果，Run 安全保留 pending', async () => {
    const f = prepared()
    vi.spyOn(recovery, 'schedulePendingKeywordRadarRuns').mockImplementation(() => { throw new Error('秘密') })
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const output = await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    expect(output).toMatchObject({ status: 'success', summary: { imported_total: 2 } })
    expect(log.mock.calls).toEqual([['[关键词雷达] RECOVERY_FAILED']])
    expect(f.db.prepare("SELECT count(*) AS n FROM keyword_radar_runs WHERE status='pending'").get()!.n).toBe(2)
  })
  it.skipIf(process.platform !== 'win32')('正式当前上下文入口完成后按两个 Item 触发；三份原始上下文不重复生成 Hit', async () => {
    const f = prepared()
    const contexts = [0, 1].map(index => {
      const path = join(f.root, `明确目录${index}`)
      mkdirSync(path)
      writeFileSync(join(path, '聊天记录.txt'), `隔离证据${index}`)
      return { file: `隔离卡片${index}.zip`, extracted_dir_path: path, message_count: 1,
        transcript: `·隔离发送人${index}\n2026年10月6日 09:00\nCodex 隔离正文${index}` }
    })
    const spy = vi.spyOn(recovery, 'schedulePendingKeywordRadarRuns')
    const output = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, {
      mode: 'current_context', contexts: [contexts[0], { ...contexts[0] }, contexts[1]]
    })
    expect(output).toMatchObject({ status: 'success', summary: { imported_total: 2 } })
    expect(spy).toHaveBeenCalledWith(f.db, output.items.map(item => item.item_id))
    await flushCallbacks()
    expect(radarCount(f.db, 'keyword_hits')).toBe(2)
    expect(f.db.prepare("SELECT count(*) AS n FROM keyword_radar_runs WHERE status='complete'").get()!.n).toBe(2)
  })
  it.skipIf(process.platform !== 'win32')('零 canonical 新增的批次依旧触发两个新 Item 的独立 Hit', async () => {
    const f = prepared()
    await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    await flushCallbacks()
    const output = await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    expect(output.summary).toMatchObject({ imported_total: 0, duplicate_total: 2 })
    await flushCallbacks()
    expect(radarCount(f.db, 'messages')).toBe(2)
    expect(radarCount(f.db, 'keyword_radar_runs')).toBe(4)
    expect(radarCount(f.db, 'keyword_hits')).toBe(4)
    for (const item of output.items) {
      expect(f.db.prepare('SELECT count(*) AS n FROM keyword_hits WHERE batch_item_id=?').get(item.item_id)!.n).toBe(1)
    }
  })
})

describe('共享关键词派生失败：真实 JSON 入口',()=>{
  function prepareJson() { const f=sharedJsonFixture();addKeywordTerm(f.db,createKeywordGroup(f.db,'共享词').id,'Codex');return f }
  // 复锁：54、55。
  it.each([false,true])('matcher 失败保留核心与 Raw：partial=%s',async partial=>{
    const f=prepareJson(),input=radarMessages([1,2])
    vi.spyOn(matcher,'matchKeywordSnapshot').mockImplementation(()=>{throw new Error('秘密路径和正文')})
    const entry=await importSharedJson(f,partial?[...input,{sender_name:'缺正文'}]:input)
    expect(entry.result.status).toBe(partial?'partial':'success')
    const before=sharedCoreState(f.db),raw=sharedEvidenceBytes(f,entry.item.id),result=JSON.stringify(entry.result)
    await drainSharedDerived()
    expect(f.db.prepare('SELECT status,attempt_count FROM keyword_radar_runs WHERE batch_item_id=?').get(entry.item.id)).toEqual({status:'failed',attempt_count:1})
    expect(sharedCount(f.db,'keyword_hits')).toBe(0)
    expect(sharedCoreState(f.db)).toEqual(before);expect(sharedEvidenceBytes(f,entry.item.id)).toEqual(raw);expect(JSON.stringify(entry.result)).toBe(result)
  })
  // 复锁：56。
  it('scheduler 抛错保留真实 pending Run 与成功 Item',async()=>{
    const f=prepareJson()
    vi.spyOn(recovery,'schedulePendingKeywordRadarRuns').mockImplementation(()=>{throw new Error('秘密')})
    const entry=await importSharedJson(f,radarMessages()),before=sharedCoreState(f.db),raw=sharedEvidenceBytes(f,entry.item.id)
    expect(entry.result.status).toBe('success');await drainSharedDerived()
    expect(f.db.prepare('SELECT status,attempt_count FROM keyword_radar_runs WHERE batch_item_id=?').get(entry.item.id)).toEqual({status:'pending',attempt_count:0})
    expect(sharedCount(f.db,'keyword_hits')).toBe(0);expect(sharedCoreState(f.db)).toEqual(before);expect(sharedEvidenceBytes(f,entry.item.id)).toEqual(raw)
  })
  // 复锁：58。
  it('强重复零新增仍为每个新来源冻结规则配置和生成 Hit',async()=>{
    const f=prepareJson(),a=await importSharedJson(f,radarMessages(),'甲.json');await drainSharedDerived()
    const old=sharedRows(f.db,'keyword_hits'),b=await importSharedJson(f,radarMessages(),'乙.json')
    expect(b.result).toMatchObject({status:'success',importedCount:0,duplicateCount:2});await drainSharedDerived()
    expect(sharedCount(f.db,'messages')).toBe(2);expect(sharedCount(f.db,'keyword_radar_runs')).toBe(2);expect(sharedCount(f.db,'keyword_hits')).toBe(4)
    expect(f.db.prepare('SELECT * FROM keyword_hits WHERE batch_item_id=? ORDER BY rowid').all(a.item.id)).toEqual(old)
  })
})
