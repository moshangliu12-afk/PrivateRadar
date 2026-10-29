import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeywordRadarContent, KeywordRadarPage } from '../src/renderer/src/keyword-radar-page'
import { HistoricalKeywordScan } from '../src/renderer/src/historical-keyword-scan'
import type { KeywordGroupView, KeywordRadarDesktopApi } from '../src/shared/keyword-radar'
import type { HistoricalRescanState } from '../src/shared/historical-keyword-rescan'
import { radarFixture, ingestRadarItem, radarMessages, cleanupRadarFixtures } from './keyword-radar-fixture'
import { createKeywordGroup, addKeywordTerm } from '../src/main/keyword-radar/config'
import { listDesktopKeywordGroups, listRecentKeywordHits, getKeywordRadarStatus } from '../src/main/keyword-radar/desktop'
import { createHistoricalRescanService } from '../src/main/keyword-radar/historical-rescan'

interface Frame { slots:any[];cursor:number;effects:Array<()=>void|(()=>void)> }
const hooks=vi.hoisted(()=>({active:null as Frame|null}))
vi.mock('react',async original=>{
  const actual=await original<typeof import('react')>()
  return {...actual,
    useState(initial:unknown){if(!hooks.active)return actual.useState(initial);const f=hooks.active,n=f.cursor++;if(!(n in f.slots))f.slots[n]=typeof initial==='function'?initial():initial;return [f.slots[n],(next:any)=>{f.slots[n]=typeof next==='function'?next(f.slots[n]):next}]},
    useRef(initial:unknown){if(!hooks.active)return actual.useRef(initial);const f=hooks.active,n=f.cursor++;if(!(n in f.slots))f.slots[n]={current:initial};return f.slots[n]},
    useEffect(effect:()=>void|(()=>void),deps:unknown[]){if(hooks.active)hooks.active.effects.push(effect);else actual.useEffect(effect,deps)}
  }
})
afterEach(()=>{hooks.active=null;vi.restoreAllMocks();cleanupRadarFixtures()})
function host(){const frame:Frame={slots:[],cursor:0,effects:[]};return {frame,render<T>(component:(props:T)=>ReactNode,props:T){frame.cursor=0;frame.effects=[];hooks.active=frame;try{return component(props)}finally{hooks.active=null}}}}
function elements(node:ReactNode):Array<ReactElement<any>>{if(Array.isArray(node))return node.flatMap(elements);if(!isValidElement(node))return [];const e=node as ReactElement<any>;return [e,...elements(e.props.children)]}
async function flush(){for(let n=0;n<16;n++)await Promise.resolve()}
const base:KeywordGroupView={id:'规则',name:'项目关注',enabled:true,archivedAt:null,terms:[],stats:{historicalMatchCount:0,latestDiscoveryAt:null},lastScan:null}
const last={id:'任务',lastScanAt:'2026-10-29T05:23:00.000Z',lastScanStatus:'complete',timeSource:'finished_at' as const,matchesCurrentRule:true}
function html(group:KeywordGroupView){return renderToStaticMarkup(createElement(KeywordRadarContent,{groups:[group],hits:[],status:{pending:0,failed:0},api:{} as KeywordRadarDesktopApi,refreshGroups:async()=>{},retry:()=>{},retrying:false}))}
function plain(value:string){return value.replace(/<!--.*?-->/g,'').replace(/<[^>]*>/g,'')}

describe('最近扫描卡片与统一统计交互',()=>{
  it('从未扫描同时展示零、暂无和尚未扫描，不新增页面',()=>{
    const markup=html(base),text=plain(markup)
    for(const value of ['命中：0 条','最近发现：暂无','最近扫描：尚未扫描'])expect(text).toContain(value)
    expect(markup.match(/<section /g)).toHaveLength(2)
  })
  it.each([['complete','成功'],['running','扫描中'],['failed','失败'],['cancelled','已取消']])('真实状态 %s 映射为中文 %s，复用既有日期格式', (status,label)=>{
    const text=plain(html({...base,stats:{historicalMatchCount:1,latestDiscoveryAt:last.lastScanAt},lastScan:{...last,lastScanStatus:status}}))
    expect(text).toContain(' · '+label)
    const discovery=text.match(/最近发现：(.*?)最近扫描：/)?.[1],scanTime=text.match(/最近扫描：(.*?) · /)?.[1]
    expect(scanTime).toBe(discovery);expect(text).not.toContain(status)
  })
  it.each(['constructor','future-status'])('未知状态 %s 和非法时间安全回退',status=>{
    const text=plain(html({...base,lastScan:{...last,lastScanAt:'非法时间',lastScanStatus:status}}))
    expect(text).toContain('最近扫描：时间未知 · 状态未知');expect(text).not.toMatch(/Invalid Date|undefined|null|future-status|constructor/)
  })
  it('旧规则成功明确标记尚未扫描当前规则，归档记录不显示活动状态',()=>{
    expect(plain(html({...base,lastScan:{...last,matchesCurrentRule:false}}))).toContain('成功（尚未扫描当前规则）')
    expect(html({...base,archivedAt:'2026-10-29',enabled:false,lastScan:undefined})).not.toContain('keyword-last-scan')
  })
  it.each(['complete','failed','cancelled'] as const)('真实任务从开始到 %s 自动刷新扫描状态与原卡片统计',async outcome=>{
    const f=radarFixture();ingestRadarItem(f,0,radarMessages([1]));const group=createKeywordGroup(f.db,'真实规则');addKeywordTerm(f.db,group.id,'Codex')
    const service=createHistoricalRescanService(f.db,{onBatch(state){if(outcome==='failed')throw new Error('隔离失败');if(outcome==='cancelled')service.cancel(state.id)}})
    let runId=''
    const client={listGroups:vi.fn(async()=>({ok:true as const,value:listDesktopKeywordGroups(f.db)})),listRecentHits:async()=>({ok:true as const,value:listRecentKeywordHits(f.db)}),getStatusCounts:async()=>({ok:true as const,value:getKeywordRadarStatus(f.db)}),historicalRescan:{start:vi.fn(async(id:string)=>{const state=service.start(id);runId=state.id;return {ok:true as const,value:state}}),status:async(id:string)=>({ok:true as const,value:service.status(id)}),cancel:async(id:string)=>{service.cancel(id);return {ok:true as const,value:null}}}} as unknown as KeywordRadarDesktopApi
    const page=host(),props={api:client};page.render(KeywordRadarPage,props);const cleanup=page.frame.effects[0]();await flush()
    let section=elements(page.render(KeywordRadarPage,props)).find(e=>e.type===KeywordRadarContent)!
    const contentTree=host().render(KeywordRadarContent,section.props),card=elements(contentTree).find(e=>typeof e.type==='function'&&e.props.group?.id===group.id)!
    const scanner=elements(host().render(card.type as (props:any)=>ReactNode,card.props)).find(e=>e.type===HistoricalKeywordScan)!,scanHost=host()
    const initial=scanHost.render(HistoricalKeywordScan,scanner.props),stopInitial=scanHost.frame.effects[0]();await flush()
    expect(client.historicalRescan!.start).not.toHaveBeenCalled();if(typeof stopInitial==='function')stopInitial()
    elements(initial).find(e=>e.type==='button'&&e.props.children==='扫描历史聊天')!.props.onClick();await flush()
    section=elements(page.render(KeywordRadarPage,props)).find(e=>e.type===KeywordRadarContent)!
    expect(plain(renderToStaticMarkup(section))).toContain(' · 扫描中')
    await service.wait(runId)
    scanHost.render(HistoricalKeywordScan,scanner.props);const stopFinal=scanHost.frame.effects[0]();await flush()
    section=elements(page.render(KeywordRadarPage,props)).find(e=>e.type===KeywordRadarContent)!
    const text=plain(renderToStaticMarkup(section))
    expect(text).toContain('命中：1 条');expect(text).toContain(' · '+({complete:'成功',failed:'失败',cancelled:'已取消'}[outcome]))
    expect(text).not.toContain('尚未扫描当前规则');expect(client.listGroups).toHaveBeenCalledTimes(3)
    if(typeof stopFinal==='function')stopFinal();if(typeof cleanup==='function')cleanup()
  })
  it('页面载入已知运行任务后，首次轮询即终态也会触发刷新',async()=>{
    const h=host(),done=vi.fn(async()=>{}),state:HistoricalRescanState={id:'任务',groupId:'规则',status:'complete',scannedMessages:1,totalMessages:1,matchedHits:1,newHits:1,existingHits:0,removedHits:0,startedAt:'2026-10-29',finishedAt:'2026-10-29',error:null}
    const props={groupId:'规则',enabled:true,initialRunId:'任务',onComplete:done,api:{start:vi.fn(async()=>({ok:true as const,value:state})),status:async()=>({ok:true as const,value:state}),cancel:async()=>({ok:true as const,value:null})}}
    h.render(HistoricalKeywordScan,props);const cleanup=h.frame.effects[0]();await flush()
    expect(done).toHaveBeenCalledTimes(1);expect(props.api.start).not.toHaveBeenCalled();if(typeof cleanup==='function')cleanup()
  })
  it('开始后的卡片读取失败只提示刷新问题，不谎报扫描未启动',async()=>{
    const h=host(),state:HistoricalRescanState={id:'任务',groupId:'规则',status:'running',scannedMessages:0,totalMessages:1,matchedHits:0,newHits:0,existingHits:0,removedHits:0,startedAt:'2026-10-29',finishedAt:null,error:null}
    const props={groupId:'规则',enabled:true,onComplete:async()=>{},onStarted:async()=>{throw new Error('隔离读取失败')},api:{start:async()=>({ok:true as const,value:state}),status:async()=>({ok:true as const,value:null}),cancel:async()=>({ok:true as const,value:null})}}
    elements(h.render(HistoricalKeywordScan,props)).find(e=>e.type==='button')!.props.onClick();await flush()
    const text=plain(renderToStaticMarkup(h.render(HistoricalKeywordScan,props)))
    expect(text).toContain('扫描已开始，卡片信息暂未刷新');expect(text).not.toContain('扫描未能开始')
  })
})
