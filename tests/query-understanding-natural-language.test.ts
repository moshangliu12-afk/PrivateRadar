import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hybridSearch } from '../src/main/retrieval/hybrid-search'
import { understandQuery } from '../src/main/retrieval/query-understanding'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'

const anchorDate = '2026-10-04'
const carQuestion = '今天关于安吉星和车辆主动安全聊了什么？'
const routeQuestion = '今天南京到光山的拼车信息是什么？'
const options = { anchorDate, aiProvider: null, embeddingProvider: null }
let db: DatabaseSync

function message(id: string, content: string, timestamp: string | null = `${anchorDate}T13:00:00+08:00`, group = '车辆讨论群', sender = '小周'): void {
  db.prepare(`INSERT OR IGNORE INTO conversations (id, platform, name, conversation_type, created_at)
    VALUES (?, 'wechat', ?, 'group', '2026-10-04T00:00:00.000Z')`).run(group, group)
  db.prepare(`INSERT INTO messages (
    id, platform, conversation_id, conversation_name, sender_id, sender_name,
    sender_name_source, timestamp, timestamp_source, content, message_type,
    source, source_batch_id, source_position, fingerprint, imported_at
  ) VALUES (?, 'wechat', ?, ?, ?, ?, 'source_native', ?, ?, ?, 'text',
    'fixture', ?, 0, ?, '2026-10-04T06:00:00.000Z')`)
    .run(id, group, group, sender, sender, timestamp, timestamp ? 'source_native' : 'unknown', content, group, id)
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  // 当天十条：汽车主题分散在两条消息；南京四条、光山五条，无完整问句原文。
  const contents = [
    '明早记得带好资料。',
    '我用过安吉星，远程查看状态挺方便。',
    '收到，稍后补充实际体验。',
    '车辆主动安全能帮助减少碰撞风险。',
    '南京出发，目的地光山，今晚有空位。',
    '光山回程，司机下午确认。',
    '南京出发到光山，顺风拼车可带两位。',
    '从南京回光山，有车找人同行。',
    '南京到光山的拼车，联系方式稍后发。',
    '今晚早点休息。'
  ]
  contents.forEach((content, index) => message(`today-${index}`, content,
    `${anchorDate}T13:${String(index).padStart(2, '0')}:00+08:00`, index < 4 ? '车辆讨论群' : '拼车信息群', index === 3 ? '小林' : '小周'))
  message('yesterday', '安吉星和车辆主动安全，南京光山拼车。', '2026-10-03T13:00:00+08:00')
  message('unknown', '安吉星和车辆主动安全，南京光山拼车。', null)
})

afterEach(() => db.close())

describe('未知中文自然语言的确定性内容词回归', () => {
  it.each([
    [carQuestion, ['安吉星', '主动安全']],
    [routeQuestion, ['南京', '光山', '拼车']]
  ])('%s 保留有效内容词并删除问句功能词', (query, expected) => {
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.dateRange).toEqual({ label: '今天', start: anchorDate, end: anchorDate })
    expect(understanding.timeIntent).toBe('strict')
    expect(understanding.isNaturalLanguage).toBe(true)
    expect(understanding.searchTerms).toEqual(expect.arrayContaining(expected))
    expect(understanding.expandedTerms).toEqual(expect.arrayContaining(expected))
    expect(understanding.searchTerms.length).toBeLessThanOrEqual(8)
    expect(understanding.searchTerms.every(term => term.length >= 2)).toBe(true)
    expect(understanding.searchTerms.join(' ')).not.toMatch(/今天|关于|聊了什么|是什么/)
    expect(understanding.searchTerms).not.toContain(query.replace(/^今天(?:关于)?/, '').replace(/？$/, ''))
  })

  it.each(['安吉星', '主动安全', '南京', '光山', '资格认证', '清理楼道杂物', '12345'])('%s 直接关键词或明确短语保持原字面契约', (query) => {
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.searchTerms).toEqual([query])
    expect(understanding.expandedTerms).toEqual([query])
    expect(understanding.isNaturalLanguage).toBe(false)
  })

  it.each([
    ['今天大家聊了什么 AI 工具？', ['AI', '工具']],
    ['昨天关于 Claude Code 说了什么？', ['Claude Code']],
    ['最近谁提到微信小程序？', ['微信小程序']],
    ['南京到光山有什么信息？', ['南京', '光山', '信息']],
    ['关于车辆安全大家怎么说？', ['车辆', '安全', '车辆安全']],
    ['今天关于燃料电池和城市交通聊了什么？', ['燃料', '电池', '城市', '交通']],
    ['今天关于42号线聊了什么？', ['42']]
  ])('%s 不依赖真实案例专用词典', (query, expected) => {
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.searchTerms).toEqual(expect.arrayContaining(expected))
    expect(understanding.searchTerms.join(' ')).not.toMatch(/聊了什么|说了什么|是什么|怎么说/)
  })

  it('结构化日期、人物和群条件继续生效', async () => {
    const query = '今天车辆讨论群小周关于安吉星聊了什么？'
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.conversationNames).toEqual(['车辆讨论群'])
    expect(understanding.senderNames).toEqual(['小周'])
    expect(understanding.searchTerms).toContain('安吉星')
    expect(understanding.searchTerms.join(' ')).not.toMatch(/车辆讨论群|小周/)
    const result = await hybridSearch(db, query, understanding, null)
    expect(result.results.map(item => item.messageId)).toEqual(['today-1'])
  })

  it('明确日期只用于日期条件，不成为未知内容的检索词', () => {
    const understanding = understandQuery(db, '2026-10-04 关于燃料电池聊了什么？', anchorDate)
    expect(understanding.dateRange).toEqual({ label: anchorDate, start: anchorDate, end: anchorDate })
    expect(understanding.searchTerms).toEqual(expect.arrayContaining(['燃料', '电池']))
    expect(understanding.searchTerms.join(' ')).not.toContain('2026')
  })

  it('未知内容的昨天与最近日期范围不退化', () => {
    expect(understandQuery(db, '昨天关于燃料电池聊了什么？', anchorDate).dateRange)
      .toEqual({ label: '昨天', start: '2026-10-03', end: '2026-10-03' })
    expect(understandQuery(db, '最近7天关于燃料电池聊了什么？', anchorDate).dateRange)
      .toEqual({ label: '最近7天', start: '2026-09-28', end: anchorDate })
    expect(understandQuery(db, '最近7天关于燃料电池聊了什么？', anchorDate).searchTerms.join(' ')).not.toMatch(/7天/)
  })

  it('英文产品、版本与现有显式词规则保留', () => {
    const understanding = understandQuery(db, '昨天关于 Claude-Sonnet-5 v5.1 说了什么？', anchorDate)
    expect(understanding.searchTerms).toEqual(expect.arrayContaining(['claude-sonnet-5', 'v5.1']))
    expect(understanding.dateRange.start).toBe('2026-10-03')
  })

  it('长问题最多生成八个内容词，且相同输入规划稳定', () => {
    const query = '今天关于燃料电池和城市交通以及车辆安全与医疗设备及教育资源和体育赛事与农业生产及能源供应聊了什么？'
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.searchTerms.length).toBeGreaterThan(1)
    expect(understanding.searchTerms.length).toBeLessThanOrEqual(8)
    expect(understanding.expandedTerms.length).toBeLessThanOrEqual(8)
    for (let index = 0; index < 10; index += 1) expect(understandQuery(db, query, anchorDate)).toEqual(understanding)
  })

  it.each(['', '   ', '？？！！', '@@@', '今天请问有没有？', '今天和与以及的了什么？'])('无有效内容 %j 不回退到整句或返回所有消息', async (query) => {
    const understanding = understandQuery(db, query, anchorDate)
    expect(understanding.searchTerms).toEqual([])
    expect(understanding.expandedTerms).toEqual([])
    const result = await hybridSearch(db, query, understanding, null)
    expect(result.results).toEqual([])
    if (!query.trim()) await expect(askChat(db, query, options)).rejects.toThrow('请输入问题')
  })
})

describe('隔离十条当天消息的检索验收', () => {
  it.each([
    [carQuestion, '安吉星和车辆主动安全聊了什么', ['today-1', 'today-3'], 2],
    [routeQuestion, '南京到光山的拼车信息是什么', ['today-4', 'today-5', 'today-6', 'today-7', 'today-8'], 5]
  ])('%s 从原错误规划零条恢复为独立消息证据', async (query, oldLiteral, expectedIds, count) => {
    const understanding = understandQuery(db, query, anchorDate)
    // 保存原错误规划作为隔离对照，不依赖正式数据库或 Git 历史。
    const before = await hybridSearch(db, query, {
      ...understanding, searchTerms: [oldLiteral], expandedTerms: [oldLiteral], coreTopics: [oldLiteral]
    }, null)
    expect(before.results).toEqual([])
    const after = await askChat(db, query, options)
    expect(after.hitMessageCount).toBe(count)
    expect(after.sourceMessageIds.sort()).toEqual([...expectedIds].sort())
    expect(after.results.every(item => item.timeVerification === 'verified' && item.timestamp.startsWith(anchorDate))).toBe(true)
    expect(after.sourceMessageIds).not.toContain('yesterday')
    expect(after.sourceMessageIds).not.toContain('unknown')
    expect(after.unverifiedTimeResults).toEqual([])
    expect(after.telemetry.retrievalMode).toBe('全文搜索')
  })

  it.each([['安吉星', 1], ['主动安全', 1], ['南京', 4], ['光山', 5]])('%s 关键词召回仍为 %i 条当天消息', async (query, count) => {
    const understanding = understandQuery(db, `今天${query}`, anchorDate)
    const result = await hybridSearch(db, query, understanding, null)
    expect(result.results).toHaveLength(count)
  })

  it('现有相关性优先同时匹配路线与拼车词的消息', async () => {
    const result = await hybridSearch(db, routeQuestion, understandQuery(db, routeQuestion, anchorDate), null)
    const score = (id: string) => result.results.find(item => item.messageId === id)!.relevanceScore
    expect(score('today-6')).toBeGreaterThan(score('today-4'))
    expect(score('today-4')).toBeGreaterThan(score('today-5'))
  })

  it('现有相关性优先复合主题证据，而非仅匹配宽泛单词', async () => {
    message('generic', '讨论安全。')
    message('specific', '讨论车辆安全。')
    const query = '关于车辆安全大家怎么说？'
    const result = await hybridSearch(db, query, understandQuery(db, query, anchorDate), null)
    const score = (id: string) => result.results.find(item => item.messageId === id)!.relevanceScore
    expect(score('specific')).toBeGreaterThan(score('generic'))
  })
})
