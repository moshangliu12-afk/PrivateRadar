import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { planSearchTerms, understandQuery } from '../src/main/retrieval/query-understanding'
import { compareSearchTerms, compareStableText, rankSearchTerms, type SearchTermSource } from '../src/main/retrieval/term-ranking'

const source = (text: string, kind: SearchTermSource['kind'] = 'word', primary = true): SearchTermSource => ({ text, kind, primary })

describe('候选词五级确定性优先级', () => {
  it('主词来源优先，不能被完整但仅扩展的长词抢占', () => {
    const ranked = rankSearchTerms('普通 完整扩展短语', [source('完整扩展短语', 'complete', false), source('普通')])
    expect(ranked.map(item => item.text)).toEqual(['普通', '完整扩展短语'])
  })
  it('完整项优先于组合，组合优先于普通片段', () => {
    const ranked = rankSearchTerms('完整短语 相邻组合 片段', [source('片段'), source('相邻组合', 'compound'), source('完整短语', 'complete')])
    expect(ranked.map(item => item.phrasePriority)).toEqual([2, 1, 0])
  })
  it('同来源同质量的完整项才按长度优先', () => {
    expect(rankSearchTerms('短语 更长完整短语', [source('短语', 'complete'), source('更长完整短语', 'complete')])
      .map(item => item.text)).toEqual(['更长完整短语', '短语'])
  })
  it('普通长词不获长度加分，采用原查询位置', () => {
    const ranked = rankSearchTerms('短词 非常非常长的普通词', [source('非常非常长的普通词'), source('短词')])
    expect(ranked.map(item => item.text)).toEqual(['短词', '非常非常长的普通词'])
    expect(ranked.every(item => item.conditionalLength === 0)).toBe(true)
  })
  it('缺少原样连续依据的完整项和组合不获短语提升', () => {
    const ranked = rankSearchTerms('先出现', [source('无依据的长完整项', 'complete'), source('不连续组合', 'compound'), source('先出现')])
    expect(ranked.map(item => item.phrasePriority)).toEqual([0, 0, 0])
    expect(ranked[0].text).toBe('先出现')
    expect(ranked.slice(1).every(item => item.firstQueryIndex === Infinity)).toBe(true)
  })
  it('位置取原始UTF-16坐标，不做大小写或全角折叠', () => {
    const query = '  🚀　ＡＡ，AA，aa，AA'
    const ranked = rankSearchTerms(query, [source('AA'), source('aa'), source('ＡＡ')])
    for (const item of ranked) expect(item.firstQueryIndex).toBe(query.indexOf(item.text))
    expect(rankSearchTerms('ＡＡ', [source('AA')])[0].firstQueryIndex).toBe(Infinity)
  })
  it('词最后才采用固定码元比较，包含非BMP边界', () => {
    const texts = ['aa', 'AA', '𐀀', '\uE000a']
    const ranked = rankSearchTerms('', texts.map(text => source(text, 'word', false)))
    expect(ranked.map(item => item.text)).toEqual(['AA', 'aa', '𐀀', '\uE000a'])
    expect(compareStableText('同词', '同词')).toBe(0)
  })
  it('多来源合并不依赖首次插入，保持精确大小写身份', () => {
    const sources = [source('完整词', 'word', false), source('完整词', 'complete'), source('完整词', 'compound'),
      source('AA'), source('aa')]
    const forward = rankSearchTerms('完整词 AA aa', sources)
    expect(rankSearchTerms('完整词 AA aa', [...sources].reverse())).toEqual(forward)
    expect(forward).toHaveLength(3)
    expect(forward[0]).toMatchObject({ sourcePriority: 1, phrasePriority: 2, conditionalLength: 3 })
  })
  it('缺少主来源为扩展，短于两个码元不入候选', () => {
    expect(rankSearchTerms('', [{ text: '未知', kind: 'word' }, source('单'), source('')]))
      .toEqual([{ text: '未知', sourcePriority: 0, phrasePriority: 0, conditionalLength: 0, firstQueryIndex: Infinity }])
  })
  it('比较关系反对称且传递，重复乱序结果一致', () => {
    const sources = [source('完整项', 'complete'), source('组合', 'compound'), source('普通'),
      source('AA'), source('aa'), source('扩展', 'word', false), source('无位置')]
    const records = rankSearchTerms('普通 AA aa 完整项 组合 扩展', sources)
    for (const a of records) for (const b of records) {
      expect(compareSearchTerms(a, b) + compareSearchTerms(b, a)).toBe(0)
      for (const c of records) if (compareSearchTerms(a, b) <= 0 && compareSearchTerms(b, c) <= 0) {
        expect(compareSearchTerms(a, c)).toBeLessThanOrEqual(0)
      }
    }
    for (let index = 0; index < sources.length; index++) {
      expect(rankSearchTerms('普通 AA aa 完整项 组合 扩展', [...sources.slice(index), ...sources.slice(0, index)])).toEqual(records)
    }
  })
  it('三十个同质量词严格选24再12，没有并列扩窗', () => {
    const words = Array.from({ length: 30 }, (_, i) => '词' + String(i).padStart(2, '0'))
    const ranked = rankSearchTerms(words.join('，'), words.map(text => source(text)).reverse())
    expect(ranked.slice(0, 24).map(item => item.text)).toEqual(words.slice(0, 24))
    expect(ranked.slice(0, 24).slice(0, 12).map(item => item.text)).toEqual(words.slice(0, 12))
  })
})

describe('既有生成阶段的窄类型与噪声门禁', () => {
  it.each([
    ['昨天谁提到 Claude Code？', 'Claude Code', 'Claude'],
    ['公众号排版工具是谁推荐的？', '公众号排版', '公众号'],
    ['微信小程序项目和小程序有什么信息？', '微信小程序', '小程序'],
    ['Ollama 有什么信息？', 'Ollama', null],
    ['知识库检索方案有什么信息？', '知识库检索', null]
  ])('%s 的已有完整对象有依据才优先', (query, complete, fragment) => {
    const db = new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      const u = understandQuery(db, query, '2026-10-05')
      const plan = planSearchTerms(query, u)
      expect(plan.find(item => item.text === complete)?.phrasePriority).toBe(2)
      if (fragment) {
        expect(plan.find(item => item.text === fragment)?.phrasePriority).toBe(0)
        expect(plan.findIndex(item => item.text === complete)).toBeLessThan(plan.findIndex(item => item.text === fragment))
      }
    } finally { db.close() }
  })
  it.each([
    ['关于车辆安全大家怎么说？', '车辆安全', '安全'],
    ['南京到光山的拼车信息是什么？', '拼车信息', '信息']
  ])('%s 的连续组合优先于组成片段', (query, compound, fragment) => {
    const db = new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      const u = understandQuery(db, query, '2026-10-05'), plan = planSearchTerms(query, u)
      expect(plan.find(item => item.text === compound)?.phrasePriority).toBe(1)
      expect(plan.find(item => item.text === fragment)?.phrasePriority).toBe(0)
      expect(plan.findIndex(item => item.text === compound)).toBeLessThan(plan.findIndex(item => item.text === fragment))
    } finally { db.close() }
  })
  it('仅扩展的长别名没有位置和长度加分', () => {
    const db = new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      const query = 'Claude Code', u = understandQuery(db, query, '2026-10-05')
      expect(planSearchTerms(query, u).find(item => item.text === 'Anthropic coding agent'))
        .toMatchObject({ phrasePriority: 0, conditionalLength: 0, firstQueryIndex: Infinity })
    } finally { db.close() }
  })
  it('完整项不能被多于窗口容量的泛化片段挤出', () => {
    const fragments = Array.from({ length: 30 }, (_, i) => '片段' + i)
    const query = fragments.join('，') + '，完整短语'
    const plan = rankSearchTerms(query, [...fragments.map(text => source(text)), source('完整短语', 'complete')])
    expect(plan.slice(0, 24).slice(0, 12)[0].text).toBe('完整短语')
  })
  it.each(['Claude Code', '公众号排版工具', '微信小程序项目', 'Ollama'])('%s的真实生成完整项在片段超窗时仍进入Top12', queryObject => {
    const db = new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      const fragments = Array.from({ length: 30 }, (_, i) => 'fragment' + i)
      const query = fragments.join('，') + '，' + queryObject
      const u = understandQuery(db, query, '2026-10-05'), plan = planSearchTerms(query, u)
      const complete = queryObject.replace(/工具|项目/g, '')
      expect(plan.slice(0, 24).slice(0, 12).map(item => item.text)).toContain(complete)
      expect(plan.find(item => item.text === complete)?.phrasePriority).toBe(2)
    } finally { db.close() }
  })
  it('归一化后的坐标不能冒充原始入口坐标', () => {
    const db = new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      const original = '  🚀 2026-10-04　AA，bb', normalized = original.normalize('NFKC').replace(/\s+/g, ' ').trim()
      const u = understandQuery(db, normalized, '2026-10-05', original)
      const plan = planSearchTerms(normalized, u, original)
      expect(plan.find(item => item.text === 'AA')?.firstQueryIndex).toBe(original.indexOf('AA'))
      expect(plan.find(item => item.text === 'AA')?.firstQueryIndex).not.toBe(normalized.indexOf('AA'))
    } finally { db.close() }
  })
})
