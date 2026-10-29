import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeywordRadarContent, KeywordRadarPage } from '../src/renderer/src/keyword-radar-page'
import { HistoricalKeywordScan } from '../src/renderer/src/historical-keyword-scan'
import type { KeywordGroupView, KeywordHitView, KeywordRadarDesktopApi } from '../src/shared/keyword-radar'
import { radarFixture, ingestRadarItem, radarMessages, cleanupRadarFixtures } from './keyword-radar-fixture'
import { createKeywordGroup, addKeywordTerm } from '../src/main/keyword-radar/config'
import { listDesktopKeywordGroups, listRecentKeywordHits, getKeywordRadarStatus } from '../src/main/keyword-radar/desktop'
import { createHistoricalRescanService } from '../src/main/keyword-radar/historical-rescan'

interface Frame { slots:any[]; cursor:number; effects:Array<()=>void|(()=>void)> }
const hooks=vi.hoisted(()=>({active:null as Frame|null}))
vi.mock('react',async original=>{
  const actual=await original<typeof import('react')>()
  return {...actual,
    useState(initial:unknown) {
      if(!hooks.active)return actual.useState(initial)
      const f=hooks.active,n=f.cursor++
      if(!(n in f.slots))f.slots[n]=typeof initial==='function'?initial():initial
      return [f.slots[n],(next:any)=>{f.slots[n]=typeof next==='function'?next(f.slots[n]):next}]
    },
    useRef(initial:unknown) {
      if(!hooks.active)return actual.useRef(initial)
      const f=hooks.active,n=f.cursor++
      if(!(n in f.slots))f.slots[n]={current:initial}
      return f.slots[n]
    },
    useEffect(effect:()=>void|(()=>void),dependencies:unknown[]) {
      if(hooks.active)hooks.active.effects.push(effect);else actual.useEffect(effect,dependencies)
    }
  }
})
afterEach(()=>{hooks.active=null;vi.restoreAllMocks();cleanupRadarFixtures()})
function host() {
  const frame:Frame={slots:[],cursor:0,effects:[]}
  return {frame,render<T>(component:(props:T)=>ReactNode,props:T) {
    frame.cursor=0;frame.effects=[];hooks.active=frame
    try{return component(props)}finally{hooks.active=null}
  }}
}
function elements(node:ReactNode):Array<ReactElement<any>> {
  if(Array.isArray(node))return node.flatMap(elements)
  if(!isValidElement(node))return []
  const value=node as ReactElement<any>
  return [value,...elements(value.props.children)]
}
async function flush(){for(let n=0;n<12;n++)await Promise.resolve()}
const group:KeywordGroupView={id:'规则',name:'项目关注',enabled:true,archivedAt:null,terms:[],stats:{historicalMatchCount:0,latestDiscoveryAt:null}}
function content(groups:KeywordGroupView[],hits:KeywordHitView[]=[]) {
  return createElement(KeywordRadarContent,{groups,hits,status:{pending:0,failed:0},api:{} as KeywordRadarDesktopApi,refreshGroups:async()=>{},retry:()=>{},retrying:false})
}

describe('规则卡片统计展示与刷新',()=>{
  it('零命中显示零和暂无，维持现有页面和轻量卡片',()=>{
    const html=renderToStaticMarkup(content([group]))
    expect(html).toContain('历史命中：<strong>0</strong> 条')
    expect(html).toContain('最近发现：暂无')
    expect(html.match(/<section /g)).toHaveLength(2)
    expect(html).not.toMatch(/Invalid Date|统计详情|趋势图|排行榜/)
  })
  it('有命中显示真实数量，发现时间直接复用原命中卡片的时间格式',()=>{
    const date='2026-10-29T05:18:00.000Z'
    const hit:KeywordHitView={id:'命中',groupId:'规则',groupName:'项目关注',matchedTerms:['Codex'],matchedAt:date,batchItemId:null,sourcePosition:null,messageId:'消息',body:'正文',senderName:null,chatTimestamp:null,timestampSource:'unknown',conversationName:null,source:{batchItemId:null,attachmentName:null,ordinal:null,evidenceKind:null,evidenceStatus:'missing',evidenceRecorded:false}}
    const html=renderToStaticMarkup(content([{...group,stats:{historicalMatchCount:38,latestDiscoveryAt:date}}],[hit]))
    expect(html).toContain('历史命中：<strong>38</strong> 条')
    expect(html.match(/最近发现：([^<]+)/)?.[1]).toBe(html.match(/发现时间：([^<]+)/)?.[1])
  })
  it('异常时间安全显示暂无，旧接口 fixture 不出现空值字符串',()=>{
    const html=renderToStaticMarkup(content([{...group,stats:{historicalMatchCount:1,latestDiscoveryAt:'无效日期'}},{...group,id:'兼容组',stats:undefined}]))
    expect(html.match(/最近发现：暂无/g)).toHaveLength(2)
    expect(html).not.toMatch(/Invalid Date|null|undefined/)
  })
  it('归档记录沿用折叠展示但不显示活动统计，停用组仍显示历史值',()=>{
    const archived=renderToStaticMarkup(content([{...group,archivedAt:'2026-10-29',enabled:false,stats:undefined}]))
    expect(archived).toContain('已归档关键词组（1）');expect(archived).not.toContain('class="keyword-rule-stats"')
    expect(renderToStaticMarkup(content([{...group,enabled:false,stats:{historicalMatchCount:2,latestDiscoveryAt:null}}]))).toContain('历史命中：<strong>2</strong> 条')
  })
  it('真实扫描完成经现有回调刷新卡片，无需重进页面或新增订阅',async()=>{
    const f=radarFixture();ingestRadarItem(f,0,radarMessages([1]))
    const created=createKeywordGroup(f.db,'真实规则');addKeywordTerm(f.db,created.id,'Codex')
    const service=createHistoricalRescanService(f.db)
    let lastRun=''
    const client={
      listGroups:vi.fn(async()=>({ok:true as const,value:listDesktopKeywordGroups(f.db)})),
      listRecentHits:async()=>({ok:true as const,value:listRecentKeywordHits(f.db)}),
      getStatusCounts:async()=>({ok:true as const,value:getKeywordRadarStatus(f.db)}),
      historicalRescan:{start:vi.fn(async(id:string)=>{const state=service.start(id);lastRun=state.id;return {ok:true as const,value:state}}),
        status:async(id:string)=>({ok:true as const,value:service.status(id)}),cancel:async(id:string)=>{service.cancel(id);return {ok:true as const,value:null}}}
    } as unknown as KeywordRadarDesktopApi
    const page=host(),props={api:client}
    page.render(KeywordRadarPage,props);const cleanup=page.frame.effects[0]();await flush()
    let tree=page.render(KeywordRadarPage,props),section=elements(tree).find(e=>e.type===KeywordRadarContent)!
    expect(renderToStaticMarkup(section)).toContain('历史命中：<strong>0</strong> 条')
    const sectionHost=host(),sectionTree=sectionHost.render(KeywordRadarContent,section.props)
    const card=elements(sectionTree).find(e=>typeof e.type==='function'&&e.props.group?.id===created.id)!
    const cardTree=host().render(card.type as (props:any)=>ReactNode,card.props)
    const scanner=elements(cardTree).find(e=>e.type===HistoricalKeywordScan)!,scanHost=host()
    let scanTree=scanHost.render(HistoricalKeywordScan,scanner.props)
    const stopInitial=scanHost.frame.effects[0]();await flush()
    expect(client.historicalRescan!.start).not.toHaveBeenCalled()
    if(typeof stopInitial==='function')stopInitial()
    elements(scanTree).find(e=>e.type==='button'&&e.props.children==='扫描历史聊天')!.props.onClick();await flush()
    await service.wait(lastRun)
    scanTree=scanHost.render(HistoricalKeywordScan,scanner.props)
    const stopFinal=scanHost.frame.effects[0]();await flush()
    tree=page.render(KeywordRadarPage,props);section=elements(tree).find(e=>e.type===KeywordRadarContent)!
    expect(renderToStaticMarkup(section)).toContain('历史命中：<strong>1</strong> 条')
    expect(renderToStaticMarkup(section)).not.toContain('最近发现：暂无')
    expect(client.listGroups).toHaveBeenCalledTimes(3)
    if(typeof stopFinal==='function')stopFinal();if(typeof cleanup==='function')cleanup()
  })
})
