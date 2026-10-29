import { sharedCoreItems, ingestSharedCore, sharedRows, drainSharedDerived } from './shared-core-fixture'
import { sharedJsonFixture, importSharedJson, sharedEvidenceBytes } from './shared-json-evidence-fixture'
import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeywordGroup, addKeywordTerm, renameKeywordGroup, archiveKeywordGroup, setKeywordTermEnabled } from '../src/main/keyword-radar/config'
import { listDesktopKeywordGroups, addDesktopKeywordTerm, listRecentKeywordHits, getKeywordHitContext, getKeywordHitSource, getKeywordRadarStatus, retryFailedDesktopKeywordRuns, registerKeywordRadarIpc, safeKeywordRadarAction } from '../src/main/keyword-radar/desktop'
import { openKeywordHitEvidence } from '../src/main/keyword-radar/evidence-navigation'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { saveOriginalZip, saveStructuredSnapshot } from '../src/main/batch-import/evidence'
import { createBatchImportItem } from '../src/main/batch-import/repository'
import { markKeywordRadarAttemptStarted, markKeywordRadarFailed } from '../src/main/keyword-radar/runs'
import { radarFixture, radarMessages, ingestRadarItem, radarCount, cleanupRadarFixtures } from './keyword-radar-fixture'

type Fixture = ReturnType<typeof radarFixture>
afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
function prepared(numbers = [1]) {
  const f = radarFixture(), group = createKeywordGroup(f.db, '历史工具组')
  addKeywordTerm(f.db, group.id, 'Codex'); addKeywordTerm(f.db, group.id, '隔离关键词')
  ingestRadarItem(f, 0, radarMessages(numbers)); processKeywordRadarRun(f.db, f.items[0].id)
  return { ...f, group }
}
function ipc(f: Fixture) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>()
  const open = vi.fn(async () => ({ batchItemId: f.items[0].id, opened: true as const }))
  registerKeywordRadarIpc({ handle: (name, callback) => { handlers.set(name, (...args) => callback(null, ...args) as Promise<any>) } }, f.db, open)
  return { call: (name: string, ...args: unknown[]) => handlers.get('keyword-radar:' + name)!(...args), handlers, open }
}
function fingerprint(f: Pick<Fixture, 'db'>) {
  return createHash('sha256').update(JSON.stringify(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'keyword_%' ORDER BY name").all().map(row => {
    const name = String(row.name); return [name, f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(value => JSON.stringify(value)).sort()]
  }))).digest('hex')
}
function failed(f: Fixture, index: number) {
  const attempt = markKeywordRadarAttemptStarted(f.db, f.items[index].id)!
  markKeywordRadarFailed(f.db, f.items[index].id, attempt, 'PROCESSING_FAILED')
}
function replaceFixtureSources(f: Fixture, index: number, changes: Record<string, any>, positions?: number[]) {
  // 只构造隔离展示 fixture：保留生产不可变触发器，不更新已登记来源。
  const itemId = f.items[index].id
  const sources = f.db.prepare('SELECT * FROM batch_item_message_sources WHERE batch_item_id=? ORDER BY source_position').all(itemId)
  const hits = f.db.prepare('SELECT * FROM keyword_hits WHERE batch_item_id=?').all(itemId)
  f.db.prepare('DELETE FROM keyword_hits WHERE batch_item_id=?').run(itemId)
  f.db.prepare('DELETE FROM batch_item_message_sources WHERE batch_item_id=?').run(itemId)
  const positionMap = new Map<number, number>()
  for (const [i, source] of sources.entries()) {
    const next = { ...source, ...changes, source_position: positions?.[i] ?? source.source_position }
    positionMap.set(Number(source.source_position), Number(next.source_position))
    const columns = Object.keys(next)
    f.db.prepare(`INSERT INTO batch_item_message_sources (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(next))
  }
  for (const hit of hits) {
    const next = { ...hit, source_position: positionMap.get(Number(hit.source_position))! }, columns = Object.keys(next)
    f.db.prepare(`INSERT INTO keyword_hits (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(next))
  }
}
describe('关键词配置桌面动作与输入边界', () => {
  it('创建、中文词、重复提示和重新启用保留同一编号', async () => {
    const f = radarFixture(), api = ipc(f)
    const group = await api.call('create-group', '  拼车  ')
    expect(group.ok).toBe(true)
    const chinese = await api.call('add-term', group.value, '南京')
    expect(chinese.value.outcome).toBe('created')
    const a = await api.call('add-term', group.value, 'Codex')
    const b = await api.call('add-term', group.value, 'codex')
    expect(b.value).toEqual({ id: a.value.id, outcome: 'exists' })
    await api.call('term-enabled', a.value.id, false)
    expect(listDesktopKeywordGroups(f.db)[0].terms.find(term => term.id === a.value.id)!.enabled).toBe(false)
    const c = await api.call('add-term', group.value, 'CODEX')
    expect(c.value).toEqual({ id: a.value.id, outcome: 'reenabled' })
    await api.call('term-enabled', chinese.value.id, false); await api.call('term-enabled', chinese.value.id, true)
    expect(radarCount(f.db, 'keyword_terms')).toBe(2)
    const finalGroup = listDesktopKeywordGroups(f.db)[0]
    expect(finalGroup.name).toBe('拼车')
    expect(finalGroup.terms).toHaveLength(2)
    expect(finalGroup.terms.find(term => term.term === '南京')).toMatchObject({ id: chinese.value.id, enabled: true })
    expect(finalGroup.terms.find(term => term.term === 'Codex')).toMatchObject({ id: a.value.id, enabled: true })
  })
  it('组启停、改名、归档只改变配置，归档组保留并拒绝后续编辑', async () => {
    const f = prepared(), api = ipc(f), before = listRecentKeywordHits(f.db)
    await api.call('group-enabled', f.group.id, false)
    expect(listDesktopKeywordGroups(f.db)[0].enabled).toBe(false)
    await api.call('group-enabled', f.group.id, true)
    expect(listDesktopKeywordGroups(f.db)[0].enabled).toBe(true)
    await api.call('rename-group', f.group.id, '新组名')
    expect(listDesktopKeywordGroups(f.db)[0].name).toBe('新组名')
    await api.call('archive-group', f.group.id)
    const groups = listDesktopKeywordGroups(f.db)
    expect(groups.filter(group => !group.archivedAt)).toEqual([])
    expect(groups[0].archivedAt).not.toBeNull()
    for (const [action, args] of [['rename-group', [f.group.id, '再改']], ['group-enabled', [f.group.id, true]], ['add-term', [f.group.id, '新词']]] as const)
      expect(await api.call(action, ...args)).toMatchObject({ ok: false, error: { code: 'CONFIG_UNAVAILABLE' } })
    expect(listRecentKeywordHits(f.db)).toEqual(before)
  })
  it.each(['', '   ', null, 1, '组'.repeat(201)])('拒绝无效名称 %s', async name => {
    const f = radarFixture()
    expect(await ipc(f).call('create-group', name)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(radarCount(f.db, 'keyword_groups')).toBe(0)
  })
  it.each(['', ' '.repeat(2), null, '词'.repeat(201)])('拒绝无效词 %s', async term => {
    const f = radarFixture(), group = createKeywordGroup(f.db, '配置')
    expect(await ipc(f).call('add-term', group.id, term)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  })
  it('编号、布尔值、上限严格校验，开放通道无 SQL 或任意路径能力', async () => {
    const f = prepared(), api = ipc(f), before = fingerprint(f)
    expect(api.handlers.size).toBe(16)
    for (const name of ['archive-group', 'context', 'source', 'open-evidence', 'rescan-start', 'rescan-status', 'rescan-cancel']) {
      expect(await api.call(name, "' OR 1=1 --")).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(api.open).not.toHaveBeenCalled()
    expect(await api.call('group-enabled', f.group.id, 'false')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    for (const limit of [0, 101, -1, 1.2, '100', null]) expect(await api.call('hits', limit)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await api.call('hits', 1)).toMatchObject({ ok: true })
    expect([...api.handlers.keys()].join(' ')).not.toMatch(/sql|markComplete|markFailed|snapshot|matcher|readPath/)
    expect(fingerprint(f)).toBe(before)
  })
  it('所有未知异常使用固定错误，不暴露正文、路径、SQLite 堆栈', async () => {
    const response = await safeKeywordRadarAction(() => { throw new Error('SQLite 私聊正文 C:\\秘密路径 堆栈') })
    expect(response).toEqual({ ok: false, error: { code: 'OPERATION_FAILED', message: '关键词雷达操作未完成，请稍后重试。' } })
  })
})
describe('历史命中、来源事实与上下文', () => {
  it('旧组名和全部词来自历史快照，正文只读取 canonical body', () => {
    const f = prepared(), old = listRecentKeywordHits(f.db)[0]
    renameKeywordGroup(f.db, f.group.id, '之后改名')
    for (const term of listDesktopKeywordGroups(f.db)[0].terms) setKeywordTermEnabled(f.db, term.id, false)
    archiveKeywordGroup(f.db, f.group.id)
    const hit = listRecentKeywordHits(f.db)[0]
    expect(hit).toEqual(old)
    expect(hit.groupName).toBe('历史工具组')
    expect([...hit.matchedTerms].sort()).toEqual(['Codex', '隔离关键词'].sort())
    expect(hit.body).toBe(radarMessages()[0].content)
  })
  it('强重复 B 命中只展示 B 的 sender/time/conversation/Evidence，不回退 A', () => {
    const f = prepared()
    expect(ingestRadarItem(f, 1, radarMessages([1]).map(message => ({ ...message, sender_name: '来源乙',
      timestamp: '2026-10-06T02:20:00.000Z', timestamp_source: 'user_supplied' as const, conversation_name: '乙群' }))).importedCount).toBe(0)
    processKeywordRadarRun(f.db, f.items[1].id)
    const hit = listRecentKeywordHits(f.db).find(hit => hit.batchItemId === f.items[1].id)!
    expect(hit).toMatchObject({ body: radarMessages()[0].content, senderName: '来源乙', chatTimestamp: '2026-10-06T02:20:00.000Z', conversationName: '乙群' })
    expect(getKeywordHitSource(f.db, hit.id).batchItemId).toBe(f.items[1].id)
    expect(getKeywordHitContext(f.db, hit.id).entries[0]).toMatchObject({ senderName: '来源乙', conversationName: '乙群', isCurrent: true })
    expect(radarCount(f.db, 'messages')).toBe(1)
    expect(f.db.prepare('SELECT sender_name FROM messages').get()!.sender_name).toBe('隔离发送人')
  })
  it('NULL occurrence 不借用 canonical sender/time/conversation；发现时间不充当聊天时间', () => {
    const f = prepared()
    replaceFixtureSources(f, 0, { source_sender_name: null, source_timestamp: null, source_timestamp_source: 'unknown', source_conversation_name: null })
    expect(listRecentKeywordHits(f.db)[0]).toMatchObject({ senderName: null, chatTimestamp: null, conversationName: null })
    expect(getKeywordHitContext(f.db, listRecentKeywordHits(f.db)[0].id).entries[0].chatTimestamp).toBeNull()
  })
  it.each([['2026-10-06T02:20:00Z', 'unknown'], ['2026-10-06T02:20:00Z', 'inferred'], ['坏时间', 'source_native'], ['2026-02-30T02:20:00Z', 'source_native']])('不可靠或非法 occurrence 时间显示未知 %s %s', (time, source) => {
    const f = prepared()
    replaceFixtureSources(f, 0, { source_timestamp: time, source_timestamp_source: source })
    expect(listRecentKeywordHits(f.db)[0].chatTimestamp).toBeNull()
  })
  it('上下文中心位置 5，读取同一 Item 前后两条真实 occurrence', () => {
    const f = prepared([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const hit = listRecentKeywordHits(f.db).find(hit => hit.sourcePosition === 5)!
    const context = getKeywordHitContext(f.db, hit.id)
    expect(context.entries.map(entry => entry.sourcePosition)).toEqual([3, 4, 5, 6, 7])
    expect(context.entries.filter(entry => entry.isCurrent).map(entry => entry.sourcePosition)).toEqual([5])
    expect(context.entries.every(entry => entry.batchItemId === hit.batchItemId)).toBe(true)
  })
  it('关键词雷达上下文只读取同一附件同来源会话，不串入相邻会话', () => {
    const f = radarFixture(), group = createKeywordGroup(f.db, '来源会话')
    addKeywordTerm(f.db, group.id, 'Codex')
    ingestRadarItem(f, 0, radarMessages([1, 2, 3, 4, 5]).map((message, index) => ({
      ...message, conversation_name: index % 2 ? '乙会话' : '甲会话', conversation_name_source: 'source_native'
    })))
    processKeywordRadarRun(f.db, f.items[0].id)
    const hit = listRecentKeywordHits(f.db).find(hit => hit.sourcePosition === 2)!
    expect(getKeywordHitContext(f.db, hit.id).entries.map(entry => entry.sourcePosition)).toEqual([0, 2, 4])
  })
  it('关键词雷达来源会话 unknown 时即使保留名称也只读中心', () => {
    const f = prepared([1, 2, 3])
    replaceFixtureSources(f, 0, { source_conversation_name_source: 'unknown' })
    const hit = listRecentKeywordHits(f.db).find(hit => hit.sourcePosition === 1)!
    expect(getKeywordHitContext(f.db, hit.id).entries.map(entry => entry.sourcePosition)).toEqual([1])
  })
  it('不连续位置 0/2/5 原样保留，不伪造连续序号', () => {
    const f = radarFixture(), group = createKeywordGroup(f.db, '词')
    addKeywordTerm(f.db, group.id, 'Codex')
    ingestRadarItem(f, 0, radarMessages([1, 2, 3]).map((message, index) => ({ ...message, source_position: [0, 2, 5][index] })))
    processKeywordRadarRun(f.db, f.items[0].id)
    replaceFixtureSources(f, 0, {}, [0, 2, 5])
    const hit = listRecentKeywordHits(f.db).find(hit => hit.sourcePosition === 2)!
    expect(getKeywordHitContext(f.db, hit.id).entries.map(entry => entry.sourcePosition)).toEqual([0, 2, 5])
  })
  it('按发现时间降序，默认最多 100 条，不按聊天时间排序', () => {
    const f = prepared(Array.from({ length: 105 }, (_, i) => i + 1))
    for (const hit of listRecentKeywordHits(f.db)) {
      if (hit.sourcePosition === null) throw new Error('本夹具必须保留真实来源位置')
      f.db.prepare('UPDATE keyword_hits SET matched_at=? WHERE id=?').run(`2026-10-06T${String(Math.floor(hit.sourcePosition / 60)).padStart(2, '0')}:${String(hit.sourcePosition % 60).padStart(2, '0')}:00.000Z`, hit.id)
    }
    const hits = listRecentKeywordHits(f.db)
    expect(hits).toHaveLength(100)
    expect(hits.map(hit => hit.matchedAt)).toEqual(hits.map(hit => hit.matchedAt).sort().reverse())
    expect(listRecentKeywordHits(f.db, 2)).toHaveLength(2)
  })
  it('规则变更不追溯旧消息或重冻旧 Run，只匹配之后新导入', () => {
    const f = radarFixture(), group = createKeywordGroup(f.db, '工具')
    addDesktopKeywordTerm(f.db, group.id, 'Codex')
    ingestRadarItem(f, 0, [{ ...radarMessages([1])[0], content: 'Codex MCP' }])
    processKeywordRadarRun(f.db, f.items[0].id)
    const before = listRecentKeywordHits(f.db), frozen = f.db.prepare('SELECT rules_snapshot_json FROM keyword_radar_runs').get()
    addDesktopKeywordTerm(f.db, group.id, 'MCP')
    expect(listRecentKeywordHits(f.db)).toEqual(before)
    expect(f.db.prepare('SELECT rules_snapshot_json FROM keyword_radar_runs').get()).toEqual(frozen)
    ingestRadarItem(f, 1, [{ ...radarMessages([2])[0], content: 'MCP' }]); processKeywordRadarRun(f.db, f.items[1].id)
    expect(listRecentKeywordHits(f.db).find(hit => hit.batchItemId === f.items[1].id)!.matchedTerms).toEqual(['MCP'])
    expect(listRecentKeywordHits(f.db).find(hit => hit.batchItemId === f.items[0].id)!.matchedTerms).toEqual(['Codex'])
  })
})
describe('状态只读与显式失败重试', () => {
  it('进入页面只读状态；只重试 failed，pending/complete 与核心数据和证据不变', async () => {
    const f = prepared()
    for (let i = 2; i < 6; i++) f.items.push(createBatchImportItem(f.db, f.session.id, i))
    for (let i = 1; i < 6; i++) ingestRadarItem(f, i, radarMessages([i + 2]))
    for (let i = 1; i < 4; i++) failed(f, i)
    expect(getKeywordRadarStatus(f.db)).toEqual({ pending: 2, failed: 3 })
    const before = fingerprint(f), complete = f.db.prepare('SELECT * FROM keyword_radar_runs WHERE batch_item_id=?').get(f.items[0].id)
    const pending = f.db.prepare("SELECT * FROM keyword_radar_runs WHERE status='pending' ORDER BY batch_item_id").all()
    const path = join(f.directory, '隔离证据.txt'); writeFileSync(path, '证据不可改'); const bytes = readFileSync(path)
    listDesktopKeywordGroups(f.db); listRecentKeywordHits(f.db); getKeywordRadarStatus(f.db)
    expect(getKeywordRadarStatus(f.db)).toEqual({ pending: 2, failed: 3 })
    const result = await retryFailedDesktopKeywordRuns(f.db)
    expect(result).toEqual({ attempted: 3, completed: 3, status: { pending: 2, failed: 0 } })
    expect(f.db.prepare('SELECT * FROM keyword_radar_runs WHERE batch_item_id=?').get(f.items[0].id)).toEqual(complete)
    expect(f.db.prepare("SELECT * FROM keyword_radar_runs WHERE status='pending' ORDER BY batch_item_id").all()).toEqual(pending)
    expect(fingerprint(f)).toBe(before); expect(readFileSync(path)).toEqual(bytes)
  })
  it('仍失败或坏快照保留失败提示；一个坏 Run 不阻塞其他失败 Run', async () => {
    const f = prepared(); ingestRadarItem(f, 1, radarMessages([2])); failed(f, 1)
    f.db.exec(`CREATE TEMP TRIGGER reject_hit BEFORE INSERT ON keyword_hits BEGIN SELECT RAISE(ABORT,'隔离失败'); END`)
    expect(await retryFailedDesktopKeywordRuns(f.db)).toMatchObject({ completed: 0, status: { failed: 1 } })
    f.db.exec('DROP TRIGGER reject_hit')
    const old = f.db.prepare('SELECT * FROM keyword_radar_runs WHERE batch_item_id=?').get(f.items[1].id)!
    f.db.prepare('DELETE FROM keyword_radar_runs WHERE batch_item_id=?').run(f.items[1].id)
    f.db.prepare(`INSERT INTO keyword_radar_runs(batch_item_id,core_import_job_id,status,rules_snapshot_json,source_positions_snapshot_json,created_at) VALUES (?,?,'failed','{}',?,?)`).run(f.items[1].id, old.core_import_job_id, old.source_positions_snapshot_json, old.created_at)
    expect(await retryFailedDesktopKeywordRuns(f.db)).toMatchObject({ attempted: 1, completed: 0, status: { failed: 1 } })
  })
})
describe('证据导航只针对命中所属 Item', () => {
  async function evidence(f: Fixture, index: number) {
    const source = join(f.directory, `源${index}.zip`); writeFileSync(source, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))
    await saveOriginalZip(f.db, f.path, f.items[index].id, source)
    await saveStructuredSnapshot(f.db, f.path, f.items[index].id, { messages: radarMessages([1]) })
  }
  it.skipIf(process.platform !== 'win32')('A/B 同正文打开 B 固定目录，不改登记或证据；不执行 ZIP', async () => {
    const f = prepared(); ingestRadarItem(f, 1, radarMessages([1])); processKeywordRadarRun(f.db, f.items[1].id)
    await evidence(f, 0); await evidence(f, 1)
    const hit = listRecentKeywordHits(f.db).find(hit => hit.batchItemId === f.items[1].id)!, before = fingerprint(f)
    const open = vi.fn(async () => '')
    expect(await openKeywordHitEvidence(f.db, f.path, hit.id, open)).toEqual({ batchItemId: f.items[1].id, opened: true })
    expect(open).toHaveBeenCalledExactlyOnceWith(join(f.directory, 'evidence', f.items[1].id))
    expect(fingerprint(f)).toBe(before)
  }, 15000)
  it.skipIf(process.platform !== 'win32')('未登记、缺失、被改写或路径逃逸时 fail closed，不开其他来源', async () => {
    const f = prepared(), hit = listRecentKeywordHits(f.db)[0], open = vi.fn(async () => '')
    expect(await safeKeywordRadarAction(() => openKeywordHitEvidence(f.db, f.path, hit.id, open))).toMatchObject({ ok: false, error: { code: 'EVIDENCE_UNAVAILABLE' } })
    await evidence(f, 0)
    writeFileSync(join(f.directory, 'evidence', f.items[0].id, 'original.zip'), '被改写')
    expect(await safeKeywordRadarAction(() => openKeywordHitEvidence(f.db, f.path, hit.id, open))).toMatchObject({ ok: false })
    f.db.prepare("UPDATE batch_import_items SET evidence_relative_path='../其他来源.zip' WHERE id=?").run(f.items[0].id)
    expect(await safeKeywordRadarAction(() => openKeywordHitEvidence(f.db, f.path, hit.id, open))).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  }, 15000)
  it.skipIf(process.platform !== 'win32')('系统导航错误使用固定安全结果，不回传系统路径', async () => {
    const f = prepared(); await evidence(f, 0)
    const result = await safeKeywordRadarAction(() => openKeywordHitEvidence(f.db, f.path, listRecentKeywordHits(f.db)[0].id, async () => 'C:\\私有路径 错误'))
    expect(result).toEqual({ ok: false, error: { code: 'EVIDENCE_UNAVAILABLE', message: '该附件的证据暂不可用，未打开其他来源。' } })
  }, 15000)
})

describe('共享关键词 occurrence 与真实 JSON 回源',()=>{
  async function pair() {
    const f=sharedJsonFixture();addKeywordTerm(f.db,createKeywordGroup(f.db,'共享关键词').id,'Codex')
    const a=await importSharedJson(f,radarMessages([1]),'甲.json')
    const b=await importSharedJson(f,radarMessages([1]).map(m=>({...m,sender_name:'来源乙',conversation_name:'乙群',timestamp:'2026-10-06T02:20:00.000Z'})),'乙.json')
    await drainSharedDerived()
    const hit=listRecentKeywordHits(f.db).find(h=>h.batchItemId===b.item.id)!
    return {f,a,b,hit}
  }
  // 复锁：51。
  it('B Hit 与 Context 使用 B source facts，导航只打开 B 受控目录',async()=>{
    const {f,a,b,hit}=await pair(),before=fingerprint(f),open=vi.fn(async()=>''),raw=[sharedEvidenceBytes(f,a.item.id),sharedEvidenceBytes(f,b.item.id)]
    expect(hit).toMatchObject({senderName:'来源乙',conversationName:'乙群',chatTimestamp:'2026-10-06T02:20:00.000Z'})
    expect(getKeywordHitContext(f.db,hit.id).entries[0]).toMatchObject({batchItemId:b.item.id,senderName:'来源乙',isCurrent:true})
    expect(await openKeywordHitEvidence(f.db,f.path,hit.id,open)).toEqual({batchItemId:b.item.id,opened:true})
    expect(open).toHaveBeenCalledExactlyOnceWith(join(f.directory,'evidence',b.item.id))
    expect(fingerprint(f)).toBe(before);expect([sharedEvidenceBytes(f,a.item.id),sharedEvidenceBytes(f,b.item.id)]).toEqual(raw)
  })
  // 复锁：52 的未登记状态由真实核心创建。
  it('未登记 B 的 Hit 保留，不借用 A 的合法 Evidence',async()=>{
    const f=sharedJsonFixture();addKeywordTerm(f.db,createKeywordGroup(f.db,'共享词').id,'Codex')
    await importSharedJson(f,radarMessages([1]));await drainSharedDerived()
    const core=sharedCoreItems(f,1);ingestSharedCore(core,0,radarMessages([1]));processKeywordRadarRun(f.db,core.items[0].id)
    const hit=listRecentKeywordHits(f.db).find(h=>h.batchItemId===core.items[0].id)!,before=fingerprint(f),open=vi.fn(async()=>'')
    expect(await safeKeywordRadarAction(()=>openKeywordHitEvidence(f.db,f.path,hit.id,open))).toMatchObject({ok:false,error:{code:'EVIDENCE_UNAVAILABLE'}})
    expect(open).not.toHaveBeenCalled();expect(listRecentKeywordHits(f.db).find(h=>h.id===hit.id)).toEqual(hit);expect(fingerprint(f)).toBe(before)
  })
  // 复锁：52 的缺失、篡改、路径逃逸各分支。
  it.each(['缺失','改写','逃逸'])('B Raw %s 不改 Hit 或 DB，不回退 A',async kind=>{
    const {f,b,hit}=await pair()
    if(kind==='缺失') {const {unlinkSync}=await import('node:fs');unlinkSync(join(f.directory,b.item.evidence_relative_path!))}
    else if(kind==='改写') writeFileSync(join(f.directory,b.item.evidence_relative_path!),'被改写')
    else f.db.prepare("UPDATE batch_import_items SET evidence_relative_path='../其他来源.zip' WHERE id=?").run(b.item.id)
    const before=fingerprint(f),open=vi.fn(async()=>'')
    expect(await safeKeywordRadarAction(()=>openKeywordHitEvidence(f.db,f.path,hit.id,open))).toMatchObject({ok:false,error:{code:'EVIDENCE_UNAVAILABLE'}})
    expect(open).not.toHaveBeenCalled();expect(listRecentKeywordHits(f.db).find(h=>h.id===hit.id)).toEqual(hit);expect(fingerprint(f)).toBe(before)
  })
  // 复锁：53。
  it('导航回调错误使用固定安全说明，不泄露系统路径',async()=>{
    const {f,b,hit}=await pair(),before=fingerprint(f),raw=sharedEvidenceBytes(f,b.item.id)
    expect(await safeKeywordRadarAction(()=>openKeywordHitEvidence(f.db,f.path,hit.id,async()=>'秘密路径'))).toEqual({ok:false,error:{code:'EVIDENCE_UNAVAILABLE',message:'该附件的证据暂不可用，未打开其他来源。'}})
    expect(fingerprint(f)).toBe(before);expect(sharedEvidenceBytes(f,b.item.id)).toEqual(raw)
  })
})
