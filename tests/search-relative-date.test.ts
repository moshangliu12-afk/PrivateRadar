// 本文件的电话号码均为显式虚构测试值，不对应联系人。
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hybridSearch } from '../src/main/retrieval/hybrid-search'
import { parseDateRange, understandQuery } from '../src/main/retrieval/query-understanding'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'

const referenceDate = '2026-10-05'
const options = { aiProvider: null, embeddingProvider: null }
const carTerms = ['车辆主动', '主动安全', '安吉星', '车辆', '主动', '安全']
const routeTerms = ['拼车信息', '南京', '光山', '拼车', '信息']
let db: DatabaseSync

function addMessage(id: string, content: string, date: string | null, source = 'source_native'): void {
  db.prepare(`INSERT INTO messages (
    id, platform, conversation_id, sender_id, timestamp, timestamp_source,
    content, message_type, source, fingerprint, imported_at
  ) VALUES (?, 'wechat', '日期测试群', '日期测试发送人', ?, ?, ?, 'text', 'fixture', ?, ?)`)
    .run(id, date ? `${date}T12:00:00+08:00` : null, source, content, id, '2026-10-05T12:00:00+08:00')
}

beforeEach(() => {
  // 固定本地时区和系统时刻；只使用内存数据库，不读取正式聊天数据。
  vi.stubEnv('TZ', 'Asia/Shanghai')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-05T12:00:00+08:00'))
  db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  db.prepare(`INSERT INTO conversations (id, platform, name, created_at)
    VALUES ('日期测试群', 'wechat', '日期测试群', '2026-10-03T00:00:00+08:00')`).run()
  addMessage('oct3', '前一天的安吉星使用记录。', '2026-10-03')
  addMessage('oct4-star', '我用过安吉星，远程查看状态挺方便。', '2026-10-04')
  addMessage('oct4-safety', '车辆主动安全能帮助减少碰撞风险。', '2026-10-04')
  const routes = [
    '南京出发，目的地光山，今晚有空位。',
    '光山回程，司机下午确认。',
    '南京出发到光山，顺风拼车可带两位。',
    '从南京回光山，有车找人同行。',
    '南京到光山的拼车，联系方式稍后发。'
  ]
  routes.forEach((content, index) => addMessage(`oct4-route-${index}`, content, '2026-10-04'))
  addMessage('unknown', '安吉星和车辆主动安全，南京光山拼车。', null, 'unknown')
  addMessage('inferred', '安吉星和车辆主动安全，南京光山拼车。', '2026-10-05', 'inferred')
  expect(db.prepare(`SELECT MAX(date(timestamp, 'localtime')) AS date FROM messages
    WHERE timestamp_source IN ('source_native', 'user_supplied')`).get()).toMatchObject({ date: '2026-10-04' })
})

afterEach(() => {
  try { db?.close() } finally { vi.useRealTimers(); vi.unstubAllEnvs() }
})

describe('Search 使用当前本地日历而不是最新消息日期', () => {
  it.each([
    ['今天安吉星', '今天', '2026-10-05', []],
    ['昨天安吉星', '昨天', '2026-10-04', ['oct4-star']],
    ['前天安吉星', '前天', '2026-10-03', ['oct3']],
    ['今天关于安吉星和车辆主动安全聊了什么？', '今天', '2026-10-05', []]
  ])('%s 严格使用 %s，不回退到有消息的一天', async (question, label, date, ids) => {
    const result = await askChat(db, question, options)
    expect(result.understanding.dateRange).toEqual({ label, start: date, end: date })
    expect(result.understanding.timeIntent).toBe('strict')
    expect(result.sourceMessageIds).toEqual(ids)
    expect(result.hitMessageCount).toBe(ids.length)
    expect(result.unverifiedTimeResults).toEqual([])
    if (ids.length === 0) {
      expect(result.results).toEqual([])
      expect(result.insufficientEvidence).toBe(true)
    }
  })

  it('2026-10-04 安吉星的明确日期约束不受当前日历影响', async () => {
    const result = await askChat(db, '2026-10-04 安吉星', options)
    expect(result.understanding.dateRange).toEqual({ label: '2026-10-04', start: '2026-10-04', end: '2026-10-04' })
    expect(result.understanding.timeIntent).toBe('strict')
    expect(result.understanding.searchTerms).toEqual(['安吉星'])
    expect(result.understanding.expandedTerms).toEqual(['安吉星'])
    expect(result.sourceMessageIds).toEqual(['oct4-star'])
    expect(result.unverifiedTimeResults).toEqual([])
  })

  it.each([
    ['本周', '2026-10-05', '2026-10-05'],
    ['这周', '2026-10-05', '2026-10-05'],
    ['上周', '2026-09-28', '2026-10-04'],
    ['本月', '2026-10-01', '2026-10-05'],
    ['这个月', '2026-10-01', '2026-10-05'],
    ['上个月', '2026-09-01', '2026-09-30'],
    ['最近7天', '2026-09-29', '2026-10-05'],
    ['最近30天', '2026-09-06', '2026-10-05'],
    ['最近三个月', '2026-07-05', '2026-10-05'],
    ['最近', '2026-09-06', '2026-10-05'],
    ['近期', '2026-09-06', '2026-10-05']
  ])('%s 同样从当前日历计算', async (expression, start, end) => {
    const result = await askChat(db, `${expression}安吉星`, options)
    expect(result.understanding.dateRange).toMatchObject({ start, end })
  })

  it('每次请求重新读取当前日期，跨午夜后不保留旧锚点', async () => {
    vi.setSystemTime(new Date('2026-10-05T23:59:59+08:00'))
    expect((await askChat(db, '今天安吉星', options)).understanding.dateRange.start).toBe('2026-10-05')
    vi.setSystemTime(new Date('2026-10-06T00:00:01+08:00'))
    expect((await askChat(db, '今天安吉星', options)).understanding.dateRange.start).toBe('2026-10-06')
  })

  it('本地零点附近不误用UTC日期', async () => {
    vi.setSystemTime(new Date('2026-10-05T00:30:00+08:00'))
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-04')
    expect((await askChat(db, '今天安吉星', options)).understanding.dateRange.start).toBe(referenceDate)
  })

  it('更晚的可靠消息也不能替代当前本地日期', async () => {
    addMessage('future', '未来一天的安吉星记录。', '2026-10-06')
    const result = await askChat(db, '今天安吉星', options)
    expect(result.understanding.dateRange.start).toBe(referenceDate)
    expect(result.results).toEqual([])
  })

  it('保留现有anchorDate注入能力，测试无需依赖运行日', async () => {
    const result = await askChat(db, '今天安吉星', { ...options, anchorDate: '2026-10-04' })
    expect(result.understanding.dateRange).toEqual({ label: '今天', start: '2026-10-04', end: '2026-10-04' })
    expect(result.sourceMessageIds).toEqual(['oct4-star'])
  })
})

describe('只清理日期解析器成功消费的显式日期', () => {
  it.each([
    '2026-10-04', '2026-10-4', '2026/10/04', '2026/10/4',
    '2026年10月04日', '2026年10月4日', '2026年10月4', '2026年10/04'
  ])('%s 的现有日期格式不进入字面内容词', async (date) => {
    const result = await askChat(db, `${date} 安吉星`, options)
    expect(result.understanding.dateRange).toEqual({ label: '2026-10-04', start: '2026-10-04', end: '2026-10-04' })
    expect(result.understanding.searchTerms).toEqual(['安吉星'])
    expect(result.understanding.expandedTerms).toEqual(['安吉星'])
    expect(result.understanding.coreTopics).toEqual(['安吉星'])
    expect(result.sourceMessageIds).toEqual(['oct4-star'])
  })

  it.each([
    '2026-10-03 至 2026-10-04',
    '2026/10/3 到 2026/10/4',
    '2026年10月3日—2026年10月4日',
    '2026-10-03 - 2026-10-04',
    '2026-10-03 ~ 2026-10-04',
    '2026-10-03～2026-10-04',
    '2026-10-03、2026-10-04',
    '2026-10-03 2026-10-04'
  ])('%s 的已解析范围及其连接符不进入内容词', async (range) => {
    const result = await askChat(db, `${range} 安吉星`, options)
    expect(result.understanding.dateRange).toEqual({ label: '2026-10-03 至 2026-10-04', start: '2026-10-03', end: '2026-10-04' })
    expect(result.understanding.searchTerms).toEqual(['安吉星'])
    expect(result.understanding.expandedTerms).toEqual(['安吉星'])
    expect(result.sourceMessageIds.sort()).toEqual(['oct3', 'oct4-star'])
  })

  it('两个被消费日期之间的业务内容仍保留', async () => {
    const result = await askChat(db, '2026-10-03 安吉星 2026-10-04', options)
    expect(result.understanding.searchTerms).toEqual(['安吉星'])
    expect(result.sourceMessageIds.sort()).toEqual(['oct3', 'oct4-star'])
    expect(understandQuery(db, '2026-10-03 13000000000 2026-10-04', referenceDate).searchTerms).toEqual(['13000000000'])
  })

  it('斜杠日期不能变成GitHub实体或重新进入扩展内容词', () => {
    const plain = understandQuery(db, 'GitHub example/toolbox', referenceDate)
    const dated = understandQuery(db, '2026/10/04 GitHub example/toolbox', referenceDate)
    expect(plain.entityKeys).toContain('github:example/toolbox')
    expect(dated.entityKeys).toEqual(plain.entityKeys)
    expect(dated.searchTerms).toEqual(plain.searchTerms)
    expect(dated.expandedTerms).toEqual(plain.expandedTerms)
  })

  it('无日期安吉星仍使用原关键词并能检索历史消息', async () => {
    const result = await askChat(db, '安吉星', options)
    expect(result.understanding.dateRange.label).toBe('全部时间')
    expect(result.understanding.searchTerms).toEqual(['安吉星'])
    expect(result.understanding.expandedTerms).toEqual(['安吉星'])
    expect(result.sourceMessageIds).toEqual(expect.arrayContaining(['oct3', 'oct4-star']))
  })

  it('第三个未被范围解析器消费的日期不能被顺带删除', () => {
    const query = '2026-10-03 至 2026-10-04 2026-10-05 安吉星'
    const result = understandQuery(db, query, referenceDate)
    expect(result.dateRange).toEqual({ label: '2026-10-03 至 2026-10-04', start: '2026-10-03', end: '2026-10-04' })
    expect(result.searchTerms).toEqual(['2026-10-05 安吉星'])
    const natural = understandQuery(db, query + '聊了什么？', referenceDate)
    expect(natural.searchTerms).toEqual(expect.arrayContaining(['2026', '10', '05', '安吉星']))
  })

  it('移除日期后不改变其后的普通数字、电话或版本内容', async () => {
    for (const query of ['12345', '20261004', '13000000000', '400-800-1234', '+86 13000000000', 'v1.4.2', '2026.10.04', '订单2026-1004']) {
      const plain = understandQuery(db, query, referenceDate)
      expect(plain.dateRange.label).toBe('全部时间')
      expect(plain.searchTerms).toEqual([query])
      const dated = understandQuery(db, `2026-10-04 ${query}`, referenceDate)
      expect(dated.searchTerms).toEqual(plain.searchTerms)
      expect(dated.expandedTerms).toEqual(plain.expandedTerms)
      addMessage('numeric-' + query, query, '2026-10-04')
      expect((await askChat(db, `2026-10-04 ${query}`, options)).sourceMessageIds).toContain('numeric-' + query)
    }
  })

  it.each(['', '   ', '？？！！', '@@@', '---', '🚀'])('%j 的空查询或纯符号契约不变', async (query) => {
    const plan = understandQuery(db, query, referenceDate)
    expect(plan.searchTerms).toEqual([])
    expect(plan.expandedTerms).toEqual([])
    if (!query.trim()) await expect(askChat(db, query, options)).rejects.toThrow('请输入问题')
    else expect((await askChat(db, query, options)).hitMessageCount).toBe(0)
  })

  it('只有日期、或日期后仅有符号时不生成日期检索词', async () => {
    for (const query of ['2026-10-04', '2026-10-04 ???', '2026-10-03 至 2026-10-04 @@@']) {
      const result = await askChat(db, query, options)
      expect(result.understanding.searchTerms).toEqual([])
      expect(result.understanding.expandedTerms).toEqual([])
      expect(result.hitMessageCount).toBe(0)
    }
  })

  it('原日期字面词规划为零条，实际服务规划只含安吉星并召回一条', async () => {
    const query = '2026-10-04 安吉星'
    const plan = understandQuery(db, query, referenceDate)
    const before = await hybridSearch(db, query, { ...plan, searchTerms: [query], expandedTerms: [query], coreTopics: [query] }, null)
    expect(before.results).toEqual([])
    const after = await askChat(db, query, options)
    expect(after.understanding.searchTerms).toEqual(['安吉星'])
    expect(after.hitMessageCount).toBe(1)
    expect(after.sourceMessageIds).toEqual(['oct4-star'])
  })
})

describe('明确日期、内容词与可靠来源契约保持', () => {
  it.each([
    ['2026-10-04 关于安吉星和车辆主动安全聊了什么？', carTerms, 2],
    ['2026-10-04 南京到光山的拼车信息是什么？', routeTerms, 5]
  ])('%s 的自然语言内容词与OR证据召回不退化', async (question, terms, count) => {
    const result = await askChat(db, question, options)
    expect(result.understanding.dateRange).toEqual({ label: '2026-10-04', start: '2026-10-04', end: '2026-10-04' })
    expect(result.understanding.searchTerms).toEqual(terms)
    expect(result.hitMessageCount).toBe(count)
    expect(result.results.every(item => item.timestamp.startsWith('2026-10-04') && item.timeVerification === 'verified')).toBe(true)
    expect(result.unverifiedTimeResults).toEqual([])
  })

  it('今天自然语言问题保留原内容词，但当天没有可靠消息时为零条', async () => {
    const result = await askChat(db, '今天关于安吉星和车辆主动安全聊了什么？', options)
    expect(result.understanding.searchTerms).toEqual(carTerms)
    expect(result.understanding.dateRange.start).toBe(referenceDate)
    expect(result.hitMessageCount).toBe(0)
  })

  it('明确日期范围优先于相对日期词并保持可靠时间过滤', async () => {
    expect(parseDateRange('2026-10-03 至 2026-10-04 今天安吉星', referenceDate))
      .toEqual({ label: '2026-10-03 至 2026-10-04', start: '2026-10-03', end: '2026-10-04' })
    const result = await askChat(db, '2026-10-03 至 2026-10-04 关于安吉星聊了什么？', options)
    expect(result.understanding.dateRange).toEqual({ label: '2026-10-03 至 2026-10-04', start: '2026-10-03', end: '2026-10-04' })
    expect(result.sourceMessageIds.sort()).toEqual(['oct3', 'oct4-star'])
    expect(result.unverifiedTimeResults).toEqual([])
  })

  it('前天仅作为日期约束，不能留在字面或自然语言内容词中', async () => {
    for (const question of ['前天安吉星', '前天关于安吉星聊了什么？']) {
      const understanding = understandQuery(db, question, referenceDate)
      expect(understanding.dateRange).toEqual({ label: '前天', start: '2026-10-03', end: '2026-10-03' })
      expect(understanding.searchTerms).toEqual(['安吉星'])
      expect(understanding.expandedTerms).toEqual(['安吉星'])
      expect((await askChat(db, question, options)).sourceMessageIds).toEqual(['oct3'])
    }
  })

  it('检索不会改变原始消息、时间来源或FTS内容', async () => {
    const originals = () => ({
      messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
      fts: db.prepare('SELECT rowid, * FROM messages_fts ORDER BY rowid').all()
    })
    const before = originals()
    await askChat(db, '今天关于安吉星和车辆主动安全聊了什么？', options)
    await askChat(db, '昨天安吉星', options)
    await askChat(db, '前天安吉星', options)
    expect(originals()).toEqual(before)
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
