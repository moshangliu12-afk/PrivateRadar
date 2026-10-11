import { sharedCoreFixture, sharedCoreItems, ingestSharedCore, sharedRows, sharedCount, sharedCoreState, drainSharedDerived } from './shared-core-fixture'
import { sharedJsonFixture, importSharedJson, sharedEvidenceBytes } from './shared-json-evidence-fixture'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTodayKeywordInterest, registerTodayKeywordInterestIpc } from '../src/main/intelligence/daily/keyword-interest'
import { createKeywordGroup, addKeywordTerm, setKeywordGroupEnabled, archiveKeywordGroup, setKeywordTermEnabled } from '../src/main/keyword-radar/config'
import { getKeywordHitContext, listRecentKeywordHits, safeKeywordRadarAction } from '../src/main/keyword-radar/desktop'
import { openKeywordHitEvidence } from '../src/main/keyword-radar/evidence-navigation'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { cleanupRadarFixtures, ingestRadarItem, radarFixture, radarCount } from './keyword-radar-fixture'
import { interestFixture, interestMessages, todayClock, replaceInterestSources, interestDatabaseFingerprint,
  interestEvidence, interestEvidenceFingerprint } from './today-keyword-interest-fixture'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); cleanupRadarFixtures() })
const query = (f: ReturnType<typeof radarFixture>) => getTodayKeywordInterest(f.db, todayClock())

describe('关注词今天归属与来源时间', () => {
  it.each(['source_native', 'user_supplied'] as const)('展示可靠 %s 本地今日已有命中', timestamp_source => {
    const f = interestFixture(interestMessages().map(message => ({ ...message, timestamp_source })))
    expect(query(f)).toMatchObject({ todayDate: '2026-10-08', items: [{
      batchItemId: f.items[0].id, sourcePosition: 0, body: interestMessages()[0].content, timestampSource: timestamp_source
    }] })
  })
  it('今天导入、发现的昨天与旧月聊天留在雷达，不进入今天，也不回退导入时间', () => {
    const f = interestFixture(interestMessages([1, 2]).map((message, index) => ({
      ...message, timestamp: new Date(2026, index ? 8 : 9, index ? 1 : 7, 9).toISOString()
    })))
    f.db.prepare('UPDATE keyword_hits SET matched_at=?').run(todayClock().toISOString())
    const before = interestDatabaseFingerprint(f)
    expect(listRecentKeywordHits(f.db)).toHaveLength(2)
    expect(query(f).items).toEqual([])
    expect(interestDatabaseFingerprint(f)).toEqual(before)
  })
  it.each([
    { source_timestamp_source: 'unknown', source_timestamp: todayClock().toISOString() },
    { source_timestamp_source: 'inferred', source_timestamp: todayClock().toISOString() },
    { source_timestamp_source: 'source_native', source_timestamp: '无效时间' },
    { source_timestamp_source: 'source_native', source_timestamp: '2026-02-30T09:00:00Z' },
    { source_timestamp_source: 'user_supplied', source_timestamp: null }
  ])('排除未知、推断、无效或缺失时间：%j', changes => {
    const f = interestFixture()
    replaceInterestSources(f, 0, () => changes)
    f.db.prepare('UPDATE keyword_hits SET matched_at=?').run(todayClock().toISOString())
    expect(listRecentKeywordHits(f.db)).toHaveLength(1)
    expect(query(f).items).toEqual([])
  })
  it('相同 canonical 的昨天与今天来源只依据 occurrence 时间', () => {
    const f = interestFixture(interestMessages().map(message => ({ ...message, timestamp: new Date(2026, 9, 7, 9).toISOString() })))
    ingestRadarItem(f, 1, interestMessages()); processKeywordRadarRun(f.db, f.items[1].id)
    const hits = listRecentKeywordHits(f.db)
    expect(new Set(hits.map(hit => hit.messageId)).size).toBe(1)
    expect(hits).toHaveLength(2)
    expect(query(f).items.map(item => item.batchItemId)).toEqual([f.items[1].id])
  })
  it('超过最近一百条的今天命中仍可展示，不由发现时间截断', () => {
    const messages = interestMessages(Array.from({ length: 105 }, (_, index) => index + 1)).map((message, index) => ({
      ...message, timestamp: new Date(2026, 9, index === 0 ? 8 : 7, 9).toISOString()
    }))
    const f = interestFixture(messages)
    f.db.prepare('UPDATE keyword_hits SET matched_at=?').run('2040-01-01T00:00:00Z')
    f.db.prepare('UPDATE keyword_hits SET matched_at=? WHERE source_position=0').run('2000-01-01T00:00:00Z')
    expect(listRecentKeywordHits(f.db)).toHaveLength(100)
    expect(listRecentKeywordHits(f.db).some(hit => hit.sourcePosition === 0)).toBe(false)
    expect(query(f).items.map(item => item.sourcePosition)).toEqual([0])
  })
  it.each(['Asia/Shanghai', 'America/Los_Angeles'])('可控系统时区 %s 的本地午夜前后重新判断，忽略 UTC 日期与旧缓存日期', timezone => {
    vi.stubEnv('TZ', timezone); vi.useFakeTimers()
    const boundary = new Date(2026, 9, 8, 0)
    const f = interestFixture(interestMessages().map(message => ({ ...message, timestamp: boundary.toISOString() })))
    expect(boundary.getTimezoneOffset()).toBe(timezone === 'Asia/Shanghai' ? -480 : 420)
    vi.setSystemTime(new Date(boundary.getTime() - 1))
    expect(getTodayKeywordInterest(f.db)).toMatchObject({ todayDate: '2026-10-07', items: [] })
    vi.setSystemTime(boundary)
    expect(getTodayKeywordInterest(f.db)).toMatchObject({ todayDate: '2026-10-08', items: [{ sourcePosition: 0 }] })
    vi.setSystemTime(new Date(2026, 9, 9, 0))
    expect(getTodayKeywordInterest(f.db)).toEqual({ todayDate: '2026-10-09', items: [] })
  })
})

describe('当前配置、occurrence 聚合和排序', () => {
  it('同组多词、跨组同词去重，但保留全部 Hit / group / term 编号，聚合后全区取三条', () => {
    const f = radarFixture(), groupA = createKeywordGroup(f.db, '甲'), groupB = createKeywordGroup(f.db, '乙')
    const terms = [addKeywordTerm(f.db, groupA.id, 'Codex'), addKeywordTerm(f.db, groupA.id, '隔离关键词'),
      addKeywordTerm(f.db, groupB.id, 'Codex'), addKeywordTerm(f.db, groupB.id, '消息')]
    ingestRadarItem(f, 0, interestMessages([1, 2, 3, 4, 5])); processKeywordRadarRun(f.db, f.items[0].id)
    const result = query(f)
    expect(result.items.map(item => item.sourcePosition)).toEqual([0, 1, 2])
    for (const item of result.items) {
      expect(item.matchedTerms).toEqual(['Codex', '消息', '隔离关键词'])
      expect(item.matches).toHaveLength(4)
      expect(new Set(item.matches.map(match => match.termId))).toEqual(new Set(terms.map(term => term.id)))
      expect(new Set(item.matches.map(match => match.groupId))).toEqual(new Set([groupA.id, groupB.id]))
      expect(item.representativeHitId).toBe([...new Set(item.matches.map(match => match.hitId))].sort()[0])
    }
    expect(query(f)).toEqual(result)
    expect(radarCount(f.db, 'keyword_hits')).toBe(10)
  })
  it('时间倒序，同时间按附件编号及数值来源位置排序，重复读取稳定', () => {
    const f = interestFixture(interestMessages([1, 2, 3]).map((message, index) => ({
      ...message, timestamp: new Date(2026, 9, 8, index === 2 ? 10 : 9).toISOString()
    })))
    ingestRadarItem(f, 1, interestMessages([4, 5])); processKeywordRadarRun(f.db, f.items[1].id)
    const ordered = [
      [f.items[0].id, 2],
      ...[f.items[0].id, f.items[1].id].sort().flatMap(id => [[id, 0], [id, 1]])
    ].slice(0, 3)
    expect(query(f).items.map(item => [item.batchItemId, item.sourcePosition])).toEqual(ordered)
    expect(query(f)).toEqual(query(f))
  })
  it.each(['disabled', 'archived'])('历史 Hit 保留但当前组 %s 立即排除，不依赖 import revision', state => {
    const f = interestFixture(), hits = listRecentKeywordHits(f.db)
    expect(query(f).items).toHaveLength(1)
    if (state === 'disabled') setKeywordGroupEnabled(f.db, f.group.id, false)
    else archiveKeywordGroup(f.db, f.group.id)
    expect(query(f).items).toEqual([])
    expect(listRecentKeywordHits(f.db)).toEqual(hits)
  })
  it('部分停用只解释 active snapshot 词；全部停用排除；新词没有历史匹配不得补入', () => {
    const f = radarFixture(), group = createKeywordGroup(f.db, '词条过滤')
    const first = addKeywordTerm(f.db, group.id, 'Codex'), second = addKeywordTerm(f.db, group.id, '消息')
    ingestRadarItem(f, 0, interestMessages()); processKeywordRadarRun(f.db, f.items[0].id)
    const hits = listRecentKeywordHits(f.db)
    setKeywordTermEnabled(f.db, first.id, false)
    addKeywordTerm(f.db, group.id, '隔离关键词')
    expect(query(f).items[0].matchedTerms).toEqual(['消息'])
    setKeywordTermEnabled(f.db, second.id, false)
    expect(query(f).items).toEqual([])
    expect(listRecentKeywordHits(f.db)).toEqual(hits)
  })
})

describe('上下文、证据、只读通信', () => {
  it('原 Keyword Radar 与新 Today 代表命中只读当前附件当前来源会话，不拼 canonical 或其他附件', () => {
    const f = interestFixture(interestMessages([1, 2, 3, 4, 5]).map((message, index) => ({
      ...message, timestamp: new Date(2026, 9, 8, index === 2 ? 10 : 9).toISOString()
    })))
    replaceInterestSources(f, 0, position => ({
      source_conversation_name: position % 2 ? '乙会话' : '甲会话', source_conversation_name_source: 'source_native'
    }))
    ingestRadarItem(f, 1, interestMessages([1])); processKeywordRadarRun(f.db, f.items[1].id)
    const hit = listRecentKeywordHits(f.db).find(hit => hit.batchItemId === f.items[0].id && hit.sourcePosition === 2)!
    const item = query(f).items.find(item => item.batchItemId === f.items[0].id && item.sourcePosition === 2)!
    for (const id of [hit.id, item.representativeHitId]) {
      const context = getKeywordHitContext(f.db, id)
      expect(context.entries.map(entry => entry.sourcePosition)).toEqual([0, 2, 4])
      expect(context.entries.every(entry => entry.batchItemId === f.items[0].id && entry.conversationName === '甲会话')).toBe(true)
    }
  })
  it.each(['unknown', 'inferred'])('来源会话标记 %s 即使有名称也只保留中心', source => {
    const f = interestFixture(interestMessages([1, 2, 3]))
    replaceInterestSources(f, 0, () => ({ source_conversation_name: '隔离群', source_conversation_name_source: source }))
    for (const hit of listRecentKeywordHits(f.db))
      expect(getKeywordHitContext(f.db, hit.id).entries.map(entry => entry.sourcePosition)).toEqual([hit.sourcePosition])
    for (const item of query(f).items)
      expect(getKeywordHitContext(f.db, item.representativeHitId).entries).toHaveLength(1)
  })
  it('来源会话缺失时只保留中心，不借用 canonical 会话', () => {
    const f = interestFixture(interestMessages([1, 2, 3]))
    replaceInterestSources(f, 0, () => ({ source_conversation_name: null, source_conversation_name_source: 'unknown' }))
    for (const item of query(f).items)
      expect(getKeywordHitContext(f.db, item.representativeHitId).entries.map(entry => entry.sourcePosition)).toEqual([item.sourcePosition])
  })
  it('只有已有 Hit 才展示，打开、重复刷新和 Context 不写任何表或 schema，并可连接只读数据库', () => {
    const f = interestFixture(); ingestRadarItem(f, 1, interestMessages([2]))
    const before = interestDatabaseFingerprint(f)
    for (let index = 0; index < 3; index++) {
      const value = query(f)
      expect(value.items).toHaveLength(1)
      getKeywordHitContext(f.db, value.items[0].representativeHitId)
    }
    const readonly = new DatabaseSync(f.path, { readOnly: true })
    try { expect(getTodayKeywordInterest(readonly, todayClock())).toEqual(query(f)) } finally { readonly.close() }
    expect(interestDatabaseFingerprint(f)).toEqual(before)
    expect(radarCount(f.db, 'keyword_radar_runs')).toBe(2)
    expect(radarCount(f.db, 'keyword_hits')).toBe(1)
  })
  it.skipIf(process.platform !== 'win32')('共享 canonical 的 B occurrence 打开 B 的注册 Evidence；查询、Context 和 Evidence 全链零写入', async () => {
    const f = interestFixture(interestMessages().map(message => ({ ...message, timestamp: new Date(2026, 9, 7, 9).toISOString() })))
    ingestRadarItem(f, 1, interestMessages()); processKeywordRadarRun(f.db, f.items[1].id)
    await interestEvidence(f, 0); await interestEvidence(f, 1)
    const before = interestDatabaseFingerprint(f), evidence = interestEvidenceFingerprint(f), open = vi.fn(async () => '')
    const item = query(f).items[0]
    getKeywordHitContext(f.db, item.representativeHitId)
    expect(await openKeywordHitEvidence(f.db, f.path, item.representativeHitId, open)).toEqual({ batchItemId: f.items[1].id, opened: true })
    expect(open).toHaveBeenCalledExactlyOnceWith(join(f.directory, 'evidence', f.items[1].id))
    expect(interestDatabaseFingerprint(f)).toEqual(before)
    expect(interestEvidenceFingerprint(f)).toEqual(evidence)
  }, 15000)
  it.skipIf(process.platform !== 'win32')('未登记及被改写的 Evidence 不 fallback，命中卡片仍保留，校验不写状态', async () => {
    const f = interestFixture(), open = vi.fn(async () => '')
    const item = query(f).items[0]
    expect(item.source.evidenceRecorded).toBe(false)
    expect(await safeKeywordRadarAction(() => openKeywordHitEvidence(f.db, f.path, item.representativeHitId, open))).toMatchObject({ ok: false })
    await interestEvidence(f, 0)
    writeFileSync(join(f.directory, 'evidence', f.items[0].id, 'original.zip'), '隔离改写')
    const before = interestDatabaseFingerprint(f), evidence = interestEvidenceFingerprint(f)
    expect(await safeKeywordRadarAction(() => openKeywordHitEvidence(f.db, f.path, item.representativeHitId, open))).toMatchObject({ ok: false })
    expect(query(f).items).toHaveLength(1)
    expect(open).not.toHaveBeenCalled()
    expect(interestDatabaseFingerprint(f)).toEqual(before)
    expect(interestEvidenceFingerprint(f)).toEqual(evidence)
  }, 15000)
  it('唯一窄 IPC 返回自己的本地今天及固定安全错误，不泄露路径或正文', async () => {
    const f = interestFixture(), handlers = new Map<string, (event: unknown) => unknown>()
    registerTodayKeywordInterestIpc({ handle: (name, callback) => { handlers.set(name, callback) } }, f.db)
    expect([...handlers.keys()]).toEqual(['dashboard:keyword-interest'])
    vi.useFakeTimers(); vi.setSystemTime(todayClock())
    const read = handlers.get('dashboard:keyword-interest')!
    expect(await read(null)).toEqual({ ok: true, value: query(f) })
    const spy = vi.spyOn(f.db, 'prepare').mockImplementation(() => { throw new Error('私有正文 C:/私有路径') })
    expect(await read(null)).toEqual({ ok: false, error: { code: 'OPERATION_FAILED', message: '关键词雷达操作未完成，请稍后重试。' } })
    spy.mockRestore()
  })
})

describe('共享今日关注词的真实来源回源',()=>{
  // 复锁：77。
  it('今日代表 B occurrence，Query/Context/真实 JSON 回源均只读且使用 B 事实',async()=>{
    const base=sharedJsonFixture();addKeywordTerm(base.db,createKeywordGroup(base.db,'关注词隔离组').id,'Codex')
    const a=await importSharedJson(base,interestMessages().map(m=>({...m,timestamp:new Date(2026,9,7,9).toISOString()})),'甲.json')
    const b=await importSharedJson(base,interestMessages().map(m=>({...m,sender_name:'来源乙',conversation_name:'乙群'})),'乙.json');await drainSharedDerived()
    const f={...base,session:b.session,items:[a.item,b.item]},before=interestDatabaseFingerprint(f),raw=[sharedEvidenceBytes(f,a.item.id),sharedEvidenceBytes(f,b.item.id)],open=vi.fn(async()=>'')
    const result=getTodayKeywordInterest(f.db,todayClock()),item=result.items[0]
    expect(item.batchItemId).toBe(b.item.id);expect(item).toMatchObject({senderName:'来源乙',conversationName:'乙群'})
    expect(getKeywordHitContext(f.db,item.representativeHitId).entries[0]).toMatchObject({batchItemId:b.item.id,senderName:'来源乙',isCurrent:true})
    expect(await openKeywordHitEvidence(f.db,f.path,item.representativeHitId,open)).toEqual({batchItemId:b.item.id,opened:true})
    expect(open).toHaveBeenCalledExactlyOnceWith(join(f.directory,'evidence',b.item.id))
    expect(interestDatabaseFingerprint(f)).toEqual(before);expect([sharedEvidenceBytes(f,a.item.id),sharedEvidenceBytes(f,b.item.id)]).toEqual(raw)
  })
  // 复锁：78 的未登记状态；真实核心 B 不借合法 A。
  it('未登记 B 的今日卡片保留，导航 fail closed，不 fallback A',async()=>{
    const f=sharedCoreItems(sharedJsonFixture(),1);addKeywordTerm(f.db,createKeywordGroup(f.db,'关注词隔离组').id,'Codex')
    await importSharedJson(f,interestMessages().map(m=>({...m,timestamp:new Date(2026,9,7,9).toISOString()})));await drainSharedDerived()
    ingestSharedCore(f,0,interestMessages());processKeywordRadarRun(f.db,f.items[0].id)
    const item=getTodayKeywordInterest(f.db,todayClock()).items[0],before=interestDatabaseFingerprint(f),open=vi.fn(async()=>'')
    expect(item.batchItemId).toBe(f.items[0].id)
    expect(await safeKeywordRadarAction(()=>openKeywordHitEvidence(f.db,f.path,item.representativeHitId,open))).toMatchObject({ok:false,error:{code:'EVIDENCE_UNAVAILABLE'}})
    expect(open).not.toHaveBeenCalled();expect(getTodayKeywordInterest(f.db,todayClock()).items).toEqual([item]);expect(interestDatabaseFingerprint(f)).toEqual(before)
  })
  // 复锁：78 的 Raw 改写；保留卡片且校验零写入。
  it('真实 JSON Raw 改写后保留今日 Hit 卡片，不修复或写状态',async()=>{
    const base=sharedJsonFixture();addKeywordTerm(base.db,createKeywordGroup(base.db,'关注词隔离组').id,'Codex')
    const b=await importSharedJson(base,interestMessages());await drainSharedDerived()
    const f={...base,session:b.session,items:[b.item]},path=join(f.directory,b.item.evidence_relative_path!)
    writeFileSync(path,'被改写')
    const item=getTodayKeywordInterest(f.db,todayClock()).items[0],before=interestDatabaseFingerprint(f),open=vi.fn(async()=>'')
    expect(await safeKeywordRadarAction(()=>openKeywordHitEvidence(f.db,f.path,item.representativeHitId,open))).toMatchObject({ok:false,error:{code:'EVIDENCE_UNAVAILABLE'}})
    expect(open).not.toHaveBeenCalled();expect(getTodayKeywordInterest(f.db,todayClock()).items).toEqual([item]);expect(interestDatabaseFingerprint(f)).toEqual(before)
  })
})
