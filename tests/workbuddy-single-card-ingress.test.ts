import { sharedCoreFixture, sharedCoreItems, ingestSharedCore, sharedRows, sharedCount, sharedCoreState, drainSharedDerived } from './shared-core-fixture'
import { schedulePendingCommitmentExtractorRuns } from '../src/main/commitment/recovery'
import { schedulePendingKeywordRadarRuns } from '../src/main/keyword-radar/recovery'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'
import { ingestWorkBuddyCurrentContextBatch } from '../src/main/integrations/workbuddy/batch-tool'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { workBuddyBatchResultSchema } from '../src/main/integrations/workbuddy/validation'
import { gateWorkBuddyBatchCurrentInput, type WorkBuddyCurrentContextBlock } from '../src/main/import/workbuddy-current-input'
import { verifyBatchEvidence } from '../src/main/batch-import/evidence'
import { addKeywordTerm, createKeywordGroup } from '../src/main/keyword-radar/config'
import { createCollection } from '../src/main/collections/service'
import * as matcher from '../src/main/commitment/matcher'
import * as processor from '../src/main/commitment/processor'
import * as runs from '../src/main/commitment/runs'

vi.mock('../src/main/commitment/matcher', async original => ({ ...await original<typeof matcher>() }))
vi.mock('../src/main/commitment/processor', async original => ({ ...await original<typeof processor>() }))
vi.mock('../src/main/commitment/runs', async original => ({ ...await original<typeof runs>() }))

const fixtures: Array<{ db: DatabaseSync; directory: string }> = []
const 原文 = ['我会把文件整理好发给你', '这个问题我来处理', '我已经发给你了', '我尽量处理一下']
async function flushDerived() {
  for (let tick = 0; tick < 12; tick++) await new Promise<void>(resolve => setImmediate(resolve))
}
afterEach(async () => {
  await flushDerived()
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    const target = resolve(fixture.directory)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('privateradar-single-card-'))
      throw new Error('隔离目录清理目标越界')
    rmSync(target, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-single-card-'))
  const data = join(directory, 'data'), root = join(directory, 'user', '.workbuddy', 'app', 'tmp', 'chat-history')
  mkdirSync(data); mkdirSync(root, { recursive: true })
  const databasePath = join(data, 'private-radar.db'), db = new DatabaseSync(databasePath)
  fixtures.push({ db, directory })
  initializeDatabase(db)
  addKeywordTerm(db, createKeywordGroup(db, '隔离来源关键词').id, '处理')
  const contexts = ['甲', '乙', '丙'].map(label => {
    const extracted_dir_path = join(root, `明确当前来源${label}`)
    mkdirSync(extracted_dir_path)
    const transcript = 原文.map(body => `·隔离发送人${label}\n2026年10月7日 22:30\n${body}`).join('\n\n') + '\n'
    writeFileSync(join(extracted_dir_path, '聊天记录.txt'), transcript, 'utf8')
    return { file: `当前附件${label}.zip`, extracted_dir_path, message_count: 4,
      first_sender: `·隔离发送人${label}`, first_message_at: '2026年10月7日 22:30', transcript } satisfies WorkBuddyCurrentContextBlock
  })
  return { directory, data, root, databasePath, db, contexts, options: { databasePath, chatHistoryRoot: root } }
}
type Fixture = ReturnType<typeof fixture>
function request(contexts: WorkBuddyCurrentContextBlock[]) { return { mode: 'current_context' as const, contexts } }
function count(f: Fixture, table: string): number {
  return Number(f.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n)
}
function productState(f: Fixture, excludeDerived = false): string {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .filter(row => !excludeDerived || !/^(?:keyword_|commitment_)/.test(String(row.name)))
  return JSON.stringify(tables.map(row => {
    const name = String(row.name)
    return [name, f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .map(value => JSON.stringify(value, (_key, entry) => entry instanceof Uint8Array ? Buffer.from(entry).toString('hex') : entry)).sort()]
  }))
}
function evidenceState(root: string): Array<[string, string]> {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? evidenceState(path) : [[path, createHash('sha256').update(readFileSync(path)).digest('hex')] as [string, string]]
  }).sort((a, b) => a[0].localeCompare(b[0]))
}
function coreSuccess(f: Fixture, itemId: string, jobId: string) {
  expect(f.db.prepare('SELECT status,effective_job_id FROM batch_import_items WHERE id=?').get(itemId))
    .toEqual({ status: 'success', effective_job_id: jobId })
  expect(f.db.prepare('SELECT status,batch_item_id FROM import_jobs WHERE id=?').get(jobId))
    .toEqual({ status: 'success', batch_item_id: itemId })
}
async function withClient<T>(f: Fixture, action: (client: Client) => Promise<T>, log?: (event: string, detail?: string) => void): Promise<T> {
  const server = createWorkBuddyMcpServer(f.db, log, f.options)
  const client = new Client({ name: 'single-card-test', version: '0.1.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try { return await action(client) } finally { await client.close(); await server.close() }
}

describe('单卡真实当前输入与既有来源链路', () => {
  it.skipIf(process.platform !== 'win32')('同路径两份原始上下文只生成一项证据、四个来源、一份冻结任务和两条候选项', async () => {
    const f = fixture(), first = f.contexts[0]
    const input = request([first, { ...first, transcript: first.transcript + '\n' }])
    const expected = gateWorkBuddyBatchCurrentInput(input.contexts).logical_attachments[0]
    const beforeMessages = count(f, 'messages')
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, input)
    expect(result).toMatchObject({ status: 'success', summary: { attachments_total: 1, attachments_completed: 1,
      input_messages_total: 4, invalid_total: 0, failed_attachments: 0 } })
    expect(result.items).toHaveLength(1)
    expect([count(f, 'batch_import_sessions'), count(f, 'batch_import_items'), count(f, 'import_jobs')]).toEqual([1, 1, 1])
    // 规范消息增量只核对统计；验收依赖真实来源与候选项，不将增量作为入口门禁。
    expect(result.summary.imported_total).toBe(count(f, 'messages') - beforeMessages)
    const item = result.items[0], itemId = item.item_id
    coreSuccess(f, itemId, item.effective_job_id!)
    expect(f.db.prepare('SELECT evidence_source_kind FROM batch_import_items WHERE id=?').get(itemId)).toEqual({ evidence_source_kind: 'directory' })
    const sources = f.db.prepare(`SELECT s.source_position,s.source_sender_name,s.source_timestamp_source,m.content
      FROM batch_item_message_sources s JOIN messages m ON m.id=s.message_id WHERE s.batch_item_id=? ORDER BY s.source_position`).all(itemId)
    expect(sources.map(source => source.source_position)).toEqual([0, 1, 2, 3])
    expect(sources.map(source => source.content)).toEqual(expected.messages.map(message => message.content))
    expect(sources.every(source => source.source_sender_name === first.first_sender && source.source_timestamp_source === 'source_native')).toBe(true)
    expect(count(f, 'commitment_extractor_runs')).toBe(1)
    expect(runs.getCommitmentExtractorRun(f.db, itemId, matcher.COMMITMENT_RULE_VERSION))
      .toMatchObject({ core_import_job_id: item.effective_job_id, source_positions_snapshot_json: '[0,1,2,3]', status: 'pending', attempt_count: 0 })
    expect(count(f, 'commitment_candidates')).toBe(0)
    const evidence = join(f.data, 'evidence', itemId)
    expect(readdirSync(join(f.data, 'evidence'))).toEqual([itemId])
    expect(existsSync(join(evidence, 'original.zip'))).toBe(false)
    expect(readFileSync(join(evidence, 'source', '聊天记录.txt'), 'utf8')).toBe(first.transcript)
    const snapshot = JSON.parse(readFileSync(join(evidence, 'messages.json'), 'utf8')).input
    expect(snapshot.messages).toEqual(expected.messages)
    expect(snapshot.current_context).toMatchObject({ transcript: first.transcript, context_indexes: [0, 1], raw_context_count: 2 })
    expect(snapshot.messages.every((message: Record<string, unknown>) => message.source_message_id === undefined)).toBe(true)
    const beforeCore = productState(f, true), beforeEvidence = evidenceState(join(f.data, 'evidence'))
    await flushDerived()
    expect(f.db.prepare('SELECT source_position,status,rule_id FROM commitment_candidates ORDER BY source_position').all()).toEqual([
      { source_position: 0, status: 'pending', rule_id: 'self_will_action' },
      { source_position: 1, status: 'pending', rule_id: 'self_take_action' }
    ])
    expect(runs.getCommitmentExtractorRun(f.db, itemId, matcher.COMMITMENT_RULE_VERSION)!.status).toBe('complete')
    expect(f.db.prepare('SELECT source_position FROM keyword_hits ORDER BY source_position').all()).toEqual([{ source_position: 1 }, { source_position: 3 }])
    expect(productState(f, true)).toBe(beforeCore)
    expect(evidenceState(join(f.data, 'evidence'))).toEqual(beforeEvidence)
    expect((await verifyBatchEvidence(f.db, f.databasePath, itemId)).status).toBe('available')
    console.info('隔离四原文样本统计：' + JSON.stringify({ CONTROLLED_SAMPLE_CANONICAL_ADDED: result.summary.imported_total, CONTROLLED_SAMPLE_OCCURRENCES: count(f, 'batch_item_message_sources'), CONTROLLED_SAMPLE_CANDIDATES: count(f, 'commitment_candidates') }))
  }, 120000)

  it.skipIf(process.platform !== 'win32')('公开原始上下文工具接受单卡，标准协议回包校验与产品结果校验均通过', async () => {
    const f = fixture()
    const result = await withClient(f, async client => {
      const response = await client.callTool({ name: 'privateradar_ingest_current_context_batch', arguments: request([f.contexts[0]]) })
      expect(response.isError).not.toBe(true)
      return workBuddyBatchResultSchema.parse(response.structuredContent)
    })
    expect(result.items).toHaveLength(1)
    expect(result).toMatchObject({ status: 'success', summary: { attachments_total: 1, attachments_completed: 1, input_messages_total: 4 } })
    coreSuccess(f, result.items[0].item_id, result.items[0].effective_job_id!)
    await flushDerived()
    expect(count(f, 'batch_item_message_sources')).toBe(4)
    expect(count(f, 'commitment_extractor_runs')).toBe(1)
    expect(count(f, 'commitment_candidates')).toBe(2)
  }, 120000)

  it.skipIf(process.platform !== 'win32')('原双卡两份来源仍形成独立会话项、证据、来源、冻结任务和候选项', async () => {
    const f = fixture(), beforeMessages = count(f, 'messages')
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request([
      f.contexts[0], { ...f.contexts[0] }, f.contexts[1], { ...f.contexts[1] }
    ]))
    expect(workBuddyBatchResultSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({ status: 'success', summary: { attachments_total: 2, attachments_completed: 2, input_messages_total: 8 } })
    expect(result.items).toHaveLength(2)
    expect([count(f, 'batch_import_sessions'), count(f, 'batch_import_items'), count(f, 'import_jobs')]).toEqual([1, 2, 2])
    expect(result.items[0].source_batch_id).not.toBe(result.items[1].source_batch_id)
    expect(result.items[0].effective_job_id).not.toBe(result.items[1].effective_job_id)
    expect(result.summary.imported_total).toBe(count(f, 'messages') - beforeMessages)
    for (const item of result.items) {
      expect(f.db.prepare('SELECT source_position FROM batch_item_message_sources WHERE batch_item_id=? ORDER BY source_position').all(item.item_id))
        .toEqual([0, 1, 2, 3].map(source_position => ({ source_position })))
      expect(runs.getCommitmentExtractorRun(f.db, item.item_id, matcher.COMMITMENT_RULE_VERSION))
        .toMatchObject({ core_import_job_id: item.effective_job_id, source_positions_snapshot_json: '[0,1,2,3]' })
      expect(readFileSync(join(f.data, 'evidence', item.item_id, 'source', '聊天记录.txt'), 'utf8'))
        .toBe(f.contexts[item.ordinal].transcript)
    }
    expect(readdirSync(join(f.data, 'evidence')).sort()).toEqual(result.items.map(item => item.item_id).sort())
    await flushDerived()
    expect(count(f, 'commitment_extractor_runs')).toBe(2)
    expect(count(f, 'commitment_candidates')).toBe(4)
    expect(count(f, 'keyword_hits')).toBe(4)
  }, 120000)
})

describe('仅原始当前输入可进入公开导入链路', () => {
  it.skipIf(process.platform !== 'win32')('旧公开自由消息入口稳定拒绝，全部产品表及已有证据字节零修改', async () => {
    const f = fixture(), imported = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request([f.contexts[0]]))
    await flushDerived()
    const before = productState(f), evidence = evidenceState(join(f.data, 'evidence')), source = evidenceState(f.root), log = vi.fn()
    await withClient(f, async client => {
      const response = await client.callTool({ name: 'privateradar_ingest_messages', arguments: {
        import_mode: 'quick', source_batch_id: '不得写入的自由消息批次', messages: 原文.map((content, source_position) => ({ content, source_position }))
      } })
      expect(response.isError).toBe(true)
      expect(response.structuredContent).toBeUndefined()
      expect(response.content).toEqual([{ type: 'text', text: expect.stringMatching(/^RAW_CURRENT_CONTEXT_REQUIRED:/) }])
    }, log)
    expect(log).not.toHaveBeenCalled()
    expect(productState(f)).toBe(before)
    expect(evidenceState(join(f.data, 'evidence'))).toEqual(evidence)
    expect(evidenceState(f.root)).toEqual(source)
    expect(count(f, 'import_jobs')).toBe(1)
    coreSuccess(f, imported.items[0].item_id, imported.items[0].effective_job_id!)
  }, 120000)

  it.each(['没有明确路径', '路径为空', '源目录不存在', '属性明确截断', '正文明确截断',
    '没有原始时间', '声明消息数不符', '零份上下文', '三个独立附件'])('%s 先拒绝，全部产品表和证据均零修改', async kind => {
    const f = fixture(), first = f.contexts[0]
    let input: unknown = request([first])
    if (kind === '没有明确路径') input = request([{ ...first, extracted_dir_path: undefined } as unknown as WorkBuddyCurrentContextBlock])
    if (kind === '路径为空') input = request([{ ...first, extracted_dir_path: '' }])
    if (kind === '源目录不存在') input = request([{ ...first, extracted_dir_path: join(f.root, '不存在的明确来源') }])
    if (kind === '属性明确截断') input = request([{ ...first, truncated: true }])
    if (kind === '正文明确截断') input = request([{ ...first, transcript: first.transcript + '[truncated]\n' }])
    if (kind === '没有原始时间') input = request([{ ...first, message_count: 1, transcript: '·隔离发送人\n我会处理这个问题\n' }])
    if (kind === '声明消息数不符') input = request([{ ...first, message_count: 5 }])
    if (kind === '零份上下文') input = request([])
    if (kind === '三个独立附件') input = request(f.contexts)
    const before = productState(f), source = evidenceState(f.root)
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, input)).rejects.toThrow()
    expect(productState(f)).toBe(before)
    expect(evidenceState(f.root)).toEqual(source)
    expect(existsSync(join(f.data, 'evidence'))).toBe(false)
    expect([count(f, 'batch_import_sessions'), count(f, 'batch_import_items'), count(f, 'import_jobs'), count(f, 'batch_item_message_sources'),
      count(f, 'commitment_extractor_runs'), count(f, 'commitment_candidates')]).toEqual([0, 0, 0, 0, 0, 0])
  }, 30000)

  it('单卡即使带有效归集身份也在来源持久化前拒绝，双卡归集契约不被放宽', async () => {
    const f = fixture(), collection = createCollection(f.db, '单卡不可归集')
    const before = productState(f)
    await expect(ingestWorkBuddyCurrentContextBatch(f.db, f.options, {
      ...request([f.contexts[0]]), collection_id: collection.id
    })).rejects.toThrow('COLLECTION_NOT_SUPPORTED_FOR_SINGLE_IMPORT')
    expect(productState(f)).toBe(before)
    expect(existsSync(join(f.data, 'evidence'))).toBe(false)
  })
})

describe('单卡派生处理的事务及历史边界', () => {
  it.skipIf(process.platform !== 'win32')('真实来源绑定在核心事务内冻结运行记录，提交后才进入独立处理器', async () => {
    const f = fixture(), registered: boolean[] = [], processed: boolean[] = []
    const actualRegister = runs.registerCommitmentExtractorRun, actualProcess = processor.processCommitmentExtractorRun
    vi.spyOn(runs, 'registerCommitmentExtractorRun').mockImplementation((db, itemId, jobId, version, positions, createdAt) => {
      registered.push(db.isTransaction)
      expect(count(f, 'commitment_candidates')).toBe(0)
      expect(positions).toEqual([0, 1, 2, 3])
      expect(f.db.prepare('SELECT source_position FROM batch_item_message_sources WHERE batch_item_id=? ORDER BY source_position').all(itemId))
        .toEqual(positions.map(source_position => ({ source_position })))
      return actualRegister(db, itemId, jobId, version, positions, createdAt)
    })
    vi.spyOn(processor, 'processCommitmentExtractorRun').mockImplementation((db, itemId, version) => {
      processed.push(db.isTransaction)
      const run = runs.getCommitmentExtractorRun(db, itemId, version ?? matcher.COMMITMENT_RULE_VERSION)!
      coreSuccess(f, itemId, run.core_import_job_id)
      return actualProcess(db, itemId, version)
    })
    await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request([f.contexts[0]]))
    expect(registered).toEqual([true])
    expect(processed).toEqual([])
    await flushDerived()
    expect(processed).toEqual([false])
    expect(count(f, 'commitment_candidates')).toBe(2)
  }, 120000)

  it.skipIf(process.platform !== 'win32')('派生匹配失败只落受控失败状态，核心任务和附件成功、证据字节及关键词结果保持', async () => {
    const f = fixture()
    vi.spyOn(matcher, 'matchCommitmentBody').mockImplementation(() => { throw new Error('秘密原文、绝对证据路径和堆栈') })
    const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request([f.contexts[0]])), item = result.items[0]
    expect(result.status).toBe('success')
    coreSuccess(f, item.item_id, item.effective_job_id!)
    const core = productState(f, true), evidence = evidenceState(join(f.data, 'evidence'))
    await flushDerived()
    const run = runs.getCommitmentExtractorRun(f.db, item.item_id, matcher.COMMITMENT_RULE_VERSION)!
    expect(run).toMatchObject({ status: 'failed', attempt_count: 1 })
    expect(run.error_summary).not.toMatch(/秘密|证据路径|堆栈/)
    expect(count(f, 'commitment_candidates')).toBe(0)
    expect(count(f, 'keyword_hits')).toBe(2)
    expect(f.db.prepare('SELECT status FROM keyword_radar_runs WHERE batch_item_id=?').get(item.item_id)).toEqual({ status: 'complete' })
    coreSuccess(f, item.item_id, item.effective_job_id!)
    expect(productState(f, true)).toBe(core)
    expect(evidenceState(join(f.data, 'evidence'))).toEqual(evidence)
  }, 120000)

  it.skipIf(process.platform !== 'win32')('旧无证据消息不补来源或派生任务，只处理本次明确原始来源及新增关键词来源', async () => {
    const f = fixture()
    const old = ingestWorkBuddyMessages(f.db, { source_batch_id: '旧无证据历史', messages: 原文.map((content, source_position) => ({ content, source_position })) })
    expect(old.status).toBe('success')
    const oldMessages = f.db.prepare('SELECT * FROM messages WHERE import_job_id=? ORDER BY id').all(old.jobId)
    expect(oldMessages).toHaveLength(4)
    expect(f.db.prepare('SELECT batch_item_id FROM import_jobs WHERE id=?').get(old.jobId)).toEqual({ batch_item_id: null })
    expect([count(f, 'batch_item_message_sources'), count(f, 'commitment_extractor_runs'), count(f, 'commitment_candidates'), count(f, 'keyword_hits')]).toEqual([0, 0, 0, 0])
    const beforeMessages = count(f, 'messages'), result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, request([f.contexts[0]]))
    expect(result.summary.imported_total).toBe(count(f, 'messages') - beforeMessages)
    await flushDerived()
    const itemId = result.items[0].item_id
    expect([count(f, 'batch_import_sessions'), count(f, 'batch_import_items'), count(f, 'batch_item_message_sources'),
      count(f, 'commitment_extractor_runs'), count(f, 'commitment_candidates'), count(f, 'keyword_hits')]).toEqual([1, 1, 4, 1, 2, 2])
    expect(f.db.prepare('SELECT * FROM messages WHERE import_job_id=? ORDER BY id').all(old.jobId)).toEqual(oldMessages)
    for (const table of ['batch_item_message_sources', 'commitment_extractor_runs', 'commitment_candidates', 'keyword_hits'])
      expect(f.db.prepare(`SELECT DISTINCT batch_item_id FROM ${table}`).all()).toEqual([{ batch_item_id: itemId }])
    expect(existsSync(join(f.data, 'evidence', old.jobId))).toBe(false)
  }, 120000)
})

describe('共享四锁定原文的真实核心与派生边界',()=>{
  function shared(total=1) {
    const f=sharedCoreItems(sharedCoreFixture(),total)
    addKeywordTerm(f.db,createKeywordGroup(f.db,'隔离来源关键词').id,'处理')
    const inputs=Array.from({length:total},(_,i)=>gateWorkBuddyBatchCurrentInput([{file:'当前附件'+i+'.zip',extracted_dir_path:join(f.directory,String(i)),message_count:4,
      first_sender:'·隔离发送人'+i,first_message_at:'2026年10月7日 22:30',transcript:原文.map(body=>'·隔离发送人'+i+'\n2026年10月7日 22:30\n'+body).join('\n\n')+'\n'}]).logical_attachments[0].messages)
    return {...f,inputs}
  }
  function schedule(f:ReturnType<typeof shared>) {const ids=f.items.map(i=>i.id);schedulePendingCommitmentExtractorRuns(f.db,ids);schedulePendingKeywordRadarRuns(f.db,ids)}
  // 漏跳：139、140、141；复锁37的额外四原文和每 Item 关联目标。
  it.each([1,2])('%s 个真实核心 Item 分别冻结原四位置，生成两 Candidate/两 KeywordHit',async total=>{
    const f=shared(total),results=f.inputs.map((messages,i)=>ingestSharedCore(f,i,messages))
    expect(sharedCount(f.db,'commitment_candidates')).toBe(0)
    for(const [i,item] of f.items.entries()) {
      expect(runs.getCommitmentExtractorRun(f.db,item.id,matcher.COMMITMENT_RULE_VERSION)).toMatchObject({core_import_job_id:results[i].jobId,source_positions_snapshot_json:'[0,1,2,3]',status:'pending',attempt_count:0})
      expect(f.db.prepare('SELECT source_position,source_conversation_name,source_conversation_name_source FROM batch_item_message_sources WHERE batch_item_id=? ORDER BY source_position').all(item.id))
        .toEqual([0,1,2,3].map(source_position=>({source_position,source_conversation_name:null,source_conversation_name_source:'unknown'})))
    }
    const before=sharedCoreState(f.db);schedule(f);await drainSharedDerived()
    expect(sharedCoreState(f.db)).toEqual(before)
    for(const item of f.items) {
      expect(f.db.prepare('SELECT source_position,status,rule_id FROM commitment_candidates WHERE batch_item_id=? ORDER BY source_position').all(item.id)).toEqual([
        {source_position:0,status:'pending',rule_id:'self_will_action'},{source_position:1,status:'pending',rule_id:'self_take_action'}])
      expect(f.db.prepare('SELECT source_position FROM keyword_hits WHERE batch_item_id=? ORDER BY source_position').all(item.id)).toEqual([{source_position:1},{source_position:3}])
    }
    expect(sharedCount(f.db,'commitment_candidates')).toBe(total*2);expect(sharedCount(f.db,'keyword_hits')).toBe(total*2)
    expect(sharedCount(f.db,'batch_item_message_sources')).toBe(total*4)
  })
  // 漏跳：143。观察真实 register/processor，不能 mock 整个导入链。
  it('source 已在核心事务内绑定时冻结 Run，提交返回后才独立处理',async()=>{
    const f=shared(),registered:boolean[]=[],processed:boolean[]=[],register=runs.registerCommitmentExtractorRun,processRun=processor.processCommitmentExtractorRun
    vi.spyOn(runs,'registerCommitmentExtractorRun').mockImplementation((db,itemId,jobId,version,positions,createdAt)=>{
      registered.push(db.isTransaction);expect(positions).toEqual([0,1,2,3])
      expect(db.prepare('SELECT source_position FROM batch_item_message_sources WHERE batch_item_id=? ORDER BY source_position').all(itemId)).toEqual(positions.map(source_position=>({source_position})))
      expect(sharedCount(db,'commitment_candidates')).toBe(0)
      return register(db,itemId,jobId,version,positions,createdAt)
    })
    vi.spyOn(processor,'processCommitmentExtractorRun').mockImplementation((db,itemId,version)=>{processed.push(db.isTransaction);return processRun(db,itemId,version)})
    expect(ingestSharedCore(f,0,f.inputs[0]).status).toBe('success')
    expect(registered).toEqual([true]);expect(processed).toEqual([]);expect(sharedCount(f.db,'commitment_candidates')).toBe(0)
    schedule(f);await drainSharedDerived()
    expect(processed).toEqual([false]);expect(sharedCount(f.db,'commitment_candidates')).toBe(2)
  })
  // 漏跳：144 的四原文派生失败与关键词独立；真实 Raw 保全复用 JSON post-import 单位。
  it('四原文 matcher 失败只标记派生失败，核心 Job 成功且 Keyword 两 Hit 完成',async()=>{
    const f=shared();vi.spyOn(matcher,'matchCommitmentBody').mockImplementation(()=>{throw new Error('秘密原文、证据路径和堆栈')})
    const result=ingestSharedCore(f,0,f.inputs[0]),before=sharedCoreState(f.db)
    schedule(f);await drainSharedDerived()
    const run=runs.getCommitmentExtractorRun(f.db,f.items[0].id,matcher.COMMITMENT_RULE_VERSION)!
    expect(run).toMatchObject({status:'failed',attempt_count:1});expect(run.error_summary).not.toMatch(/秘密|证据路径|堆栈/)
    expect(sharedCount(f.db,'commitment_candidates')).toBe(0);expect(sharedCount(f.db,'keyword_hits')).toBe(2)
    expect(f.db.prepare('SELECT status FROM keyword_radar_runs WHERE batch_item_id=?').get(f.items[0].id)).toEqual({status:'complete'})
    expect(f.db.prepare('SELECT status,batch_item_id FROM import_jobs WHERE id=?').get(result.jobId)).toEqual({status:'success',batch_item_id:f.items[0].id})
    expect(sharedCoreState(f.db)).toEqual(before)
  })
  // 漏跳：145；原旧四正文无任何来源或派生，保留所有 unknown。
  it('旧无证据四消息不补来源/任务，只处理本次 Item 的原四 occurrence',async()=>{
    const f=shared(),old=ingestWorkBuddyMessages(f.db,{source_batch_id:'旧无证据历史',messages:原文.map((content,source_position)=>({content,source_position}))})
    const oldRows=f.db.prepare('SELECT * FROM messages WHERE import_job_id=? ORDER BY id').all(old.jobId)
    expect(oldRows).toHaveLength(4)
    expect(f.db.prepare('SELECT batch_item_id FROM import_jobs WHERE id=?').get(old.jobId)).toEqual({batch_item_id:null})
    for(const table of ['batch_item_message_sources','commitment_extractor_runs','commitment_candidates','keyword_hits']) expect(sharedCount(f.db,table)).toBe(0)
    expect(oldRows.every(m=>m.timestamp===null&&m.timestamp_source==='unknown'&&m.sender_name===null&&m.conversation_name===null)).toBe(true)
    expect(ingestSharedCore(f,0,f.inputs[0]).status).toBe('success');schedule(f);await drainSharedDerived()
    expect(f.db.prepare('SELECT * FROM messages WHERE import_job_id=? ORDER BY id').all(old.jobId)).toEqual(oldRows)
    for(const table of ['batch_item_message_sources','commitment_extractor_runs','commitment_candidates','keyword_hits'])
      expect(f.db.prepare('SELECT DISTINCT batch_item_id FROM '+table).all()).toEqual([{batch_item_id:f.items[0].id}])
    expect(sharedCount(f.db,'batch_item_message_sources')).toBe(4);expect(sharedCount(f.db,'commitment_candidates')).toBe(2);expect(sharedCount(f.db,'keyword_hits')).toBe(2)
  })
})
