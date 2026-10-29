import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { radarFixture, ingestRadarItem, radarMessages, cleanupRadarFixtures } from './keyword-radar-fixture'
import { createKeywordGroup, addKeywordTerm, setKeywordTermEnabled, renameKeywordGroup, setKeywordGroupEnabled, archiveKeywordGroup } from '../src/main/keyword-radar/config'
import { createHistoricalRescanService } from '../src/main/keyword-radar/historical-rescan'
import { listDesktopKeywordGroups } from '../src/main/keyword-radar/desktop'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { initializeDatabase } from '../src/main/schema'

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();cleanupRadarFixtures()})
type Fixture=ReturnType<typeof radarFixture>
function prepared(numbers=[1,2]) {
  const f=radarFixture(),group=createKeywordGroup(f.db,'测试规则'),term=addKeywordTerm(f.db,group.id,'Codex')
  ingestRadarItem(f,0,radarMessages(numbers))
  return {...f,group,term}
}
function card(f:Fixture,id:string){return listDesktopKeywordGroups(f.db).find(group=>group.id===id)!}
async function scan(f:Fixture,id:string) {
  const service=createHistoricalRescanService(f.db),run=service.start(id)
  await service.wait(run.id);return service.status(id)!
}
function allData(db:DatabaseSync) {
  return db.prepare("SELECT name,sql,rootpage FROM sqlite_master WHERE type='table' ORDER BY name").all().map(table=>({...table,
    rows:db.prepare(`SELECT * FROM "${table.name}"`).all().map(row=>JSON.stringify(row,(_key,value)=>value instanceof Uint8Array?Buffer.from(value).toString('hex'):value)).sort()
  }))
}

describe('最近手动历史扫描只读投影',()=>{
  it('从未手动扫描返回空，不把正常导入处理记录当成历史扫描',()=>{
    const f=prepared();processKeywordRadarRun(f.db,f.items[0].id)
    expect(card(f,f.group.id).lastScan).toBeNull()
    expect(card(f,f.group.id).stats?.historicalMatchCount).toBe(2)
  })
  it('成功使用结束时间和真实成功状态，保留规则身份与当前快照标记',async()=>{
    const f=prepared(),run=await scan(f,f.group.id)
    expect(card(f,f.group.id).lastScan).toEqual({id:run.id,lastScanAt:run.finishedAt,lastScanStatus:'complete',timeSource:'finished_at',matchesCurrentRule:true})
  })
  it('运行中显示开始时间，不借用其他任务的完成时间',async()=>{
    const f=prepared(),service=createHistoricalRescanService(f.db),run=service.start(f.group.id)
    expect(card(f,f.group.id).lastScan).toMatchObject({id:run.id,lastScanAt:run.startedAt,lastScanStatus:'running',timeSource:'started_at',matchesCurrentRule:true})
    await service.wait(run.id)
  })
  it('失败读取本次结束时间，不退回更早成功记录',async()=>{
    const f=prepared();await scan(f,f.group.id)
    const service=createHistoricalRescanService(f.db,{onBatch(){throw new Error('隔离失败')}}),run=service.start(f.group.id)
    await service.wait(run.id)
    const finished=service.status(f.group.id)!
    expect(card(f,f.group.id).lastScan).toMatchObject({id:run.id,lastScanAt:finished.finishedAt,lastScanStatus:'failed',timeSource:'finished_at'})
  })
  it('取消沿用原任务状态及结束时间，仍能再次成功扫描',async()=>{
    const f=prepared(),service=createHistoricalRescanService(f.db,{onBatch(state){service.cancel(state.id)}}),run=service.start(f.group.id)
    await service.wait(run.id)
    expect(card(f,f.group.id).lastScan).toMatchObject({id:run.id,lastScanAt:service.status(f.group.id)!.finishedAt,lastScanStatus:'cancelled'})
    const retry=await scan(f,f.group.id)
    expect(card(f,f.group.id).lastScan).toMatchObject({id:retry.id,lastScanStatus:'complete'})
  })
  it('按原服务的运行顺序选择最新记录，时间相同或系统时钟回拨也不选旧记录',async()=>{
    const f=prepared(),first=await scan(f,f.group.id),second=await scan(f,f.group.id)
    f.db.prepare("UPDATE keyword_rescans SET started_at='2099-01-01T00:00:00Z',finished_at='2099-01-02T00:00:00Z' WHERE id=?").run(first.id)
    f.db.prepare("UPDATE keyword_rescans SET started_at='2020-01-01T00:00:00Z',finished_at='2020-01-02T00:00:00Z' WHERE id=?").run(second.id)
    expect(card(f,f.group.id).lastScan).toMatchObject({id:second.id,lastScanAt:'2020-01-02T00:00:00Z'})
  })
  it('多个规则分别返回自己的最新记录，无任务的规则保持为空',async()=>{
    const f=prepared(),b=createKeywordGroup(f.db,'第二组'),c=createKeywordGroup(f.db,'从未扫描组')
    addKeywordTerm(f.db,b.id,'消息')
    const first=await scan(f,f.group.id),second=await scan(f,b.id)
    expect(card(f,f.group.id).lastScan?.id).toBe(first.id)
    expect(card(f,b.id).lastScan?.id).toBe(second.id)
    expect(card(f,c.id).lastScan).toBeNull()
  })
  it('三十条规则和运行记录仍只执行一条批量查询',async()=>{
    const f=prepared(),ids=[f.group.id]
    for(let n=1;n<30;n++){const group=createKeywordGroup(f.db,`规则${n}`);addKeywordTerm(f.db,group.id,'Codex');ids.push(group.id)}
    for(const id of ids)await scan(f,id)
    const query=vi.spyOn(f.db,'prepare'),groups=listDesktopKeywordGroups(f.db)
    expect(query).toHaveBeenCalledTimes(1)
    expect(groups).toHaveLength(30);expect(groups.every(group=>group.lastScan?.lastScanStatus==='complete')).toBe(true)
    expect(new Set(groups.map(group=>group.lastScan?.id)).size).toBe(30)
  })
  it.each(['停词','加词','改名','停组'] as const)('规则%s后旧成功不代表当前规则已扫描',async change=>{
    const f=prepared(),run=await scan(f,f.group.id)
    if(change==='停词')setKeywordTermEnabled(f.db,f.term.id,false)
    if(change==='加词')addKeywordTerm(f.db,f.group.id,'消息')
    if(change==='改名')renameKeywordGroup(f.db,f.group.id,'新组名')
    if(change==='停组')setKeywordGroupEnabled(f.db,f.group.id,false)
    expect(card(f,f.group.id).lastScan).toMatchObject({id:run.id,lastScanStatus:'complete',matchesCurrentRule:false})
  })
  it('修改规则后重新扫描恢复当前成功，统计和最近发现语义不变',async()=>{
    const f=prepared();await scan(f,f.group.id)
    setKeywordTermEnabled(f.db,f.term.id,false);addKeywordTerm(f.db,f.group.id,'不存在的词')
    expect(card(f,f.group.id).lastScan?.matchesCurrentRule).toBe(false)
    const run=await scan(f,f.group.id),group=card(f,f.group.id)
    expect(group.lastScan).toMatchObject({id:run.id,matchesCurrentRule:true,lastScanStatus:'complete'})
    expect(group.stats).toEqual({historicalMatchCount:0,latestDiscoveryAt:null})
  })
  it('已有多词快照按正式稳定顺序比较，不受词的添加顺序影响',async()=>{
    const f=prepared()
    for(const word of ['南京','é','😀','Alpha','消息'])addKeywordTerm(f.db,f.group.id,word)
    await scan(f,f.group.id)
    expect(card(f,f.group.id).lastScan?.matchesCurrentRule).toBe(true)
  })
  it('第二次幂等扫描只更新最近扫描时间，命中数量和最近发现保持',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-29T05:01:00Z'))
    const f=prepared();await scan(f,f.group.id);const before=card(f,f.group.id)
    vi.setSystemTime(new Date('2026-10-29T05:23:00Z'));await scan(f,f.group.id)
    const after=card(f,f.group.id)
    expect(after.stats).toEqual(before.stats)
    expect(after.lastScan?.lastScanAt).toBe('2026-10-29T05:23:00.000Z')
    expect(before.lastScan?.lastScanAt).toBe('2026-10-29T05:01:00.000Z')
  })
  it('重开数据库保留统计和状态，读取与中断识别均不写库',async()=>{
    const f=prepared(),run=await scan(f,f.group.id),before=card(f,f.group.id)
    const reopened=new DatabaseSync(f.path)
    try{initializeDatabase(reopened);expect(listDesktopKeywordGroups(reopened)[0]).toEqual(before)}finally{reopened.close()}
    f.db.prepare("UPDATE keyword_rescans SET status='running',finished_at=NULL WHERE id=?").run(run.id)
    const data=allData(f.db)
    f.db.exec('PRAGMA query_only=ON')
    try{expect(card(f,f.group.id).lastScan).toMatchObject({lastScanStatus:'failed',timeSource:'started_at',lastScanAt:run.startedAt})}
    finally{f.db.exec('PRAGMA query_only=OFF')}
    expect(allData(f.db)).toEqual(data)
    expect(f.db.prepare('PRAGMA database_list').all().filter(row=>row.name==='main')).toHaveLength(1)
  })
  it('无法核对旧快照时安全标记未扫描当前规则，不修改原数据或命中',async()=>{
    const f=prepared(),run=await scan(f,f.group.id)
    f.db.prepare("UPDATE keyword_rescans SET rules_snapshot_json='{}' WHERE id=?").run(run.id)
    const before=allData(f.db)
    expect(card(f,f.group.id).lastScan).toMatchObject({lastScanStatus:'complete',matchesCurrentRule:false})
    expect(allData(f.db)).toEqual(before)
  })
  it('归档后不返回活动扫描状态，不建立孤立缓存或修改现有运行记录',async()=>{
    const f=prepared();await scan(f,f.group.id)
    const runs=f.db.prepare('SELECT * FROM keyword_rescans').all(),version=f.db.prepare('PRAGMA user_version').get()
    archiveKeywordGroup(f.db,f.group.id)
    const groups=listDesktopKeywordGroups(f.db)
    expect(groups.filter(group=>!group.archivedAt)).toEqual([]);expect(groups[0].lastScan).toBeUndefined()
    expect(f.db.prepare('SELECT * FROM keyword_rescans').all()).toEqual(runs)
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual(version)
  })
})
