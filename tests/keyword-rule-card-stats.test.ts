import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { radarFixture, cleanupRadarFixtures, ingestRadarItem, radarMessages } from './keyword-radar-fixture'
import { createKeywordGroup, addKeywordTerm, setKeywordTermEnabled, setKeywordGroupEnabled, archiveKeywordGroup } from '../src/main/keyword-radar/config'
import { listDesktopKeywordGroups, listRecentKeywordHits, registerKeywordRadarIpc } from '../src/main/keyword-radar/desktop'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { createHistoricalRescanService } from '../src/main/keyword-radar/historical-rescan'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'

afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
type Fixture = ReturnType<typeof radarFixture>
function rule(f: Fixture, word = 'Codex', name = '工具') {
  const group = createKeywordGroup(f.db, name), term = addKeywordTerm(f.db, group.id, word)
  return { group, term }
}
function stats(f: Fixture, id: string) { return listDesktopKeywordGroups(f.db).find(group => group.id === id)!.stats! }
async function scan(f: Fixture, id: string) {
  const service = createHistoricalRescanService(f.db), run = service.start(id)
  await service.wait(run.id)
  expect(service.status(id)?.status).toBe('complete')
  return service.status(id)!
}
function allData(db: DatabaseSync) {
  return db.prepare("SELECT name,sql,rootpage FROM sqlite_master WHERE type='table' ORDER BY name").all().map(table => ({ ...table,
    rows: db.prepare(`SELECT * FROM "${table.name}"`).all().map(row => JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value)).sort()
  }))
}

describe('规则卡片只读批量统计', () => {
  it('没有规则时为空，无命中规则明确返回零和空时间', () => {
    const f = radarFixture(); expect(listDesktopKeywordGroups(f.db)).toEqual([])
    const { group } = rule(f)
    expect(stats(f, group.id)).toEqual({ historicalMatchCount: 0, latestDiscoveryAt: null })
  })
  it('一条 live 命中读取其 matched_at，不使用聊天时间或规则创建时间', () => {
    const f = radarFixture(), { group } = rule(f)
    ingestRadarItem(f, 0, radarMessages([1]).map(message => ({ ...message, timestamp: '2099-01-01T00:00:00Z' })))
    processKeywordRadarRun(f.db, f.items[0].id)
    f.db.prepare("UPDATE keyword_hits SET matched_at='2020-01-02T03:04:00.000Z'").run()
    expect(stats(f, group.id)).toEqual({ historicalMatchCount: 1, latestDiscoveryAt: '2020-01-02T03:04:00.000Z' })
  })
  it('多条有效命中取最大发现时间，关键词数量不会乘大计数', () => {
    const f = radarFixture(), { group } = rule(f)
    addKeywordTerm(f.db, group.id, '隔离关键词')
    ingestRadarItem(f, 0, radarMessages([1, 2, 3])); processKeywordRadarRun(f.db, f.items[0].id)
    for (const [position, date] of ['2026-10-20','2026-10-22','2026-10-21'].entries())
      f.db.prepare('UPDATE keyword_hits SET matched_at=? WHERE source_position=?').run(date+'T00:00:00.000Z', position)
    expect(stats(f, group.id)).toEqual({ historicalMatchCount: 3, latestDiscoveryAt: '2026-10-22T00:00:00.000Z' })
  })
  it('不同规则、中英文匹配、零命中组分别聚合', () => {
    const f = radarFixture(), chinese = rule(f, '南京', '中文'), english = rule(f, 'Codex', '英文'), empty = rule(f, '未出现', '空组')
    ingestRadarItem(f, 0, radarMessages([1,2,3]).map((message, n) => ({ ...message, content: ['南京 CODEX','南京','无关'][n] })))
    processKeywordRadarRun(f.db, f.items[0].id)
    expect(stats(f, chinese.group.id).historicalMatchCount).toBe(2)
    expect(stats(f, english.group.id).historicalMatchCount).toBe(1)
    expect(stats(f, empty.group.id)).toEqual({ historicalMatchCount: 0, latestDiscoveryAt: null })
  })
  it('同一消息多个真实来源只计一次，同文不同消息身份分别计数', async () => {
    const f = radarFixture(), { group } = rule(f)
    const messages = radarMessages([1,2]).map(message => ({ ...message, content: 'Codex 相同正文' }))
    ingestRadarItem(f, 0, messages); processKeywordRadarRun(f.db, f.items[0].id)
    ingestRadarItem(f, 1, [messages[0]]); processKeywordRadarRun(f.db, f.items[1].id)
    expect(listRecentKeywordHits(f.db)).toHaveLength(3)
    expect(stats(f, group.id).historicalMatchCount).toBe(2)
    await scan(f, group.id)
    expect(stats(f, group.id).historicalMatchCount).toBe(2)
  })
  it('历史扫描与 live 使用同一份统计，再次幂等扫描不增加或刷新时间', async () => {
    const f = radarFixture(); ingestRadarItem(f, 0, radarMessages([1])); const { group } = rule(f)
    expect(stats(f, group.id).historicalMatchCount).toBe(0)
    const first = await scan(f, group.id)
    expect(stats(f, group.id)).toEqual({ historicalMatchCount: 1, latestDiscoveryAt: first.startedAt })
    ingestRadarItem(f, 1, radarMessages([2])); processKeywordRadarRun(f.db, f.items[1].id)
    const before = stats(f, group.id)
    expect(before.historicalMatchCount).toBe(2)
    const second = await scan(f, group.id)
    expect(second.newHits).toBe(0); expect(stats(f, group.id)).toEqual(before)
  })
  it('无附件旧消息也统计，获得真实来源后不重复且不借用隐藏旧时间', async () => {
    const f = radarFixture(), messages = radarMessages([1])
    ingestWorkBuddyMessages(f.db, { messages })
    const { group } = rule(f), first = await scan(f, group.id)
    expect(stats(f, group.id)).toEqual({ historicalMatchCount: 1, latestDiscoveryAt: first.startedAt })
    ingestRadarItem(f, 0, messages); processKeywordRadarRun(f.db, f.items[0].id)
    const before = stats(f, group.id)
    // 隔离构造已被真实来源取代的旧投影，统计必须与现有列表的排除条件相同。
    const snapshot = f.db.prepare('SELECT matched_terms_snapshot FROM keyword_hits LIMIT 1').get()!.matched_terms_snapshot!
    f.db.prepare("UPDATE keyword_rescan_coverage SET matched_terms_snapshot=?,matched_at='2099-01-01T00:00:00.000Z' WHERE batch_item_id IS NULL").run(snapshot)
    expect(listRecentKeywordHits(f.db)).toHaveLength(1)
    expect(stats(f, group.id)).toEqual(before)
  })
  it('规则修改并重扫移除旧失效命中，最近时间来自剩余有效结果', async () => {
    const f = radarFixture(), a = rule(f, 'Claude', '修改组'), b = rule(f, 'Claude', '保持组')
    ingestRadarItem(f, 0, radarMessages([1,2]).map((message, n) => ({ ...message, content: n ? 'Claude Code' : 'Claude' })))
    processKeywordRadarRun(f.db, f.items[0].id)
    f.db.prepare("UPDATE keyword_hits SET matched_at='2099-01-01T00:00:00.000Z' WHERE group_id=? AND source_position=0").run(a.group.id)
    const other = stats(f, b.group.id)
    setKeywordTermEnabled(f.db, a.term.id, false); addKeywordTerm(f.db, a.group.id, 'Claude Code')
    const run = await scan(f, a.group.id)
    expect(stats(f, a.group.id)).toEqual({ historicalMatchCount: 1, latestDiscoveryAt: run.startedAt })
    expect(stats(f, b.group.id)).toEqual(other)
  })
  it('重扫全部失效后归零，最近发现为空', async () => {
    const f = radarFixture(), { group, term } = rule(f)
    ingestRadarItem(f); processKeywordRadarRun(f.db, f.items[0].id)
    setKeywordTermEnabled(f.db, term.id, false); await scan(f, group.id)
    expect(stats(f, group.id)).toEqual({ historicalMatchCount: 0, latestDiscoveryAt: null })
  })
  it('统计全部持久结果，不受最近一百条列表限制', () => {
    const f = radarFixture(), { group } = rule(f)
    ingestRadarItem(f, 0, radarMessages(Array.from({length:125}, (_,n)=>n+1))); processKeywordRadarRun(f.db, f.items[0].id)
    expect(listRecentKeywordHits(f.db)).toHaveLength(100)
    expect(stats(f, group.id).historicalMatchCount).toBe(125)
  })
  it('三十条规则仍然一次聚合，不产生逐卡查询', () => {
    const f = radarFixture()
    for (let n=0;n<30;n++) rule(f, 'Codex', `组${n}`)
    ingestRadarItem(f); processKeywordRadarRun(f.db, f.items[0].id)
    const prepare = vi.spyOn(f.db, 'prepare')
    const groups = listDesktopKeywordGroups(f.db)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(groups).toHaveLength(30)
    expect(groups.every(group => group.stats?.historicalMatchCount === 2)).toBe(true)
  })
  it('停用组保留已有统计，归档组不再返回活动统计或产生缓存', () => {
    const f = radarFixture(), { group } = rule(f)
    ingestRadarItem(f); processKeywordRadarRun(f.db, f.items[0].id)
    const before = stats(f, group.id), tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    setKeywordGroupEnabled(f.db, group.id, false); expect(stats(f, group.id)).toEqual(before)
    archiveKeywordGroup(f.db, group.id)
    const groups = listDesktopKeywordGroups(f.db)
    expect(groups.filter(group => !group.archivedAt)).toEqual([])
    expect(groups[0].stats).toBeUndefined()
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(tables)
  })
  it('读取统计零写入、零迁移，所有原数据和关系及 FTS 保持', () => {
    const f = radarFixture(), { group } = rule(f)
    ingestRadarItem(f); processKeywordRadarRun(f.db, f.items[0].id)
    const before = allData(f.db), version = f.db.prepare('PRAGMA user_version').get()
    f.db.exec('PRAGMA query_only=ON')
    try { expect(stats(f, group.id).historicalMatchCount).toBe(2) }
    finally { f.db.exec('PRAGMA query_only=OFF') }
    expect(allData(f.db)).toEqual(before); expect(f.db.prepare('PRAGMA user_version').get()).toEqual(version)
    expect(f.db.prepare('PRAGMA database_list').all().filter(row => row.name === 'main')).toHaveLength(1)
  })
  it('沿用现有规则列表 IPC，一次返回所有统计，不增加通道或历史任务', async () => {
    const f = radarFixture(), { group } = rule(f), handlers = new Map<string, (...args:any[])=>any>()
    registerKeywordRadarIpc({handle(name,handler) { handlers.set(name,handler) }},f.db,async()=>({batchItemId:'',opened:true}))
    const result = await handlers.get('keyword-radar:groups')!(null)
    expect(result).toMatchObject({ok:true,value:[{id:group.id,stats:{historicalMatchCount:0,latestDiscoveryAt:null}}]})
    expect(handlers.size).toBe(16)
    expect(f.db.prepare('SELECT count(*) AS n FROM keyword_rescans').get()!.n).toBe(0)
  })
})
