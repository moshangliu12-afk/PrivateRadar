import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { hybridSearch } from '../src/main/retrieval/hybrid-search'
import { planSearchTerms, understandQuery } from '../src/main/retrieval/query-understanding'
import { compareStableText } from '../src/main/retrieval/term-ranking'
import type { QueryUnderstanding } from '../src/shared/models'

afterEach(() => vi.restoreAllMocks())
function database(contents: string[]): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  db.prepare("INSERT INTO conversations(id,platform,name,created_at) VALUES ('隔离群','wechat','隔离群','2026-10-04')").run()
  contents.forEach((content, index) => {
    db.prepare("INSERT INTO messages(id,platform,conversation_id,sender_id,timestamp,timestamp_source,content,message_type,source,fingerprint,imported_at) VALUES (?, 'wechat','隔离群','隔离发送人','2026-10-04T12:00:00Z','source_native',?,'text','fixture',?,'2026-10-04')")
      .run(String(index), content, String(index))
  })
  return db
}
function permutations<T>(values: T[]): T[][] {
  return values.length === 0 ? [[]] : values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest]))
}
function recordFts(db: DatabaseSync) {
  const expressions: string[] = [], statements: string[] = [], prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql)
    if (sql.includes('bm25(messages_fts) AS rank')) {
      statements.push(sql)
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...params) => {
        expressions.push(String(params[0]))
        return all(String(params[0]))
      })
    }
    return statement
  })
  return { expressions, statements }
}
async function snapshot(db: DatabaseSync, question: string, understanding: QueryUnderstanding) {
  return (await hybridSearch(db, question, understanding, null)).results
    .map(row => ({ messageId: row.messageId, relevanceScore: row.relevanceScore }))
}

describe('同词集合的全文评分顺序中立', () => {
  it.each([[2, 5, 9], [3, 7, 11], [1, 4, 9], [4, 7, 13]])('词频%s的真实浮点顺序反例被消除', async (...counts) => {
    const words = ['alpha', 'bravo', 'delta'], query = words.join('，')
    const db = database(permutations(counts).map(freq => words.flatMap((word, i) => Array(freq[i]).fill(word)).join(' ')))
    try {
      const base = understandQuery(db, query, '2026-10-05'), captured = recordFts(db)
      for (const sort of ['relevance', 'oldest'] as const) {
        const outputs = []
        for (const terms of permutations(words)) outputs.push(await snapshot(db, query, {
          ...base, sort, searchTerms: terms, expandedTerms: [], entityKeys: [], coreTopics: [], eventTerms: []
        }))
        expect(new Set(outputs.map(output => JSON.stringify(output))).size).toBe(1)
        expect(outputs[0]).toHaveLength(6)
      }
      expect(new Set(captured.expressions).size).toBe(1)
      expect(captured.expressions[0]).toBe('"alpha" OR "bravo" OR "delta"')
      expect(captured.statements.every(sql => sql.includes('ORDER BY rank, m.id COLLATE BINARY LIMIT 300'))).toBe(true)
    } finally { db.close() }
  })
  it('同分超过300行时，在SQL截断前用消息ID确定选中集合', async () => {
    const db = database(Array.from({ length: 305 }, (_, i) => 'alpha 隔离标记' + String(i).padStart(3, '0')))
    try {
      const query = 'alpha', u = understandQuery(db, query, '2026-10-05')
      const originalPrepare = db.prepare.bind(db), rows: string[][] = []
      vi.spyOn(db, 'prepare').mockImplementation(sql => {
        const statement = originalPrepare(sql)
        if (sql.includes('bm25(messages_fts) AS rank')) {
          const all = statement.all.bind(statement)
          vi.spyOn(statement, 'all').mockImplementation((...params) => {
            const result = all(String(params[0])); rows.push(result.map(row => String(row.id))); return result
          })
        }
        return statement
      })
      await snapshot(db, query, u)
      const expected = Array.from({ length: 305 }, (_, i) => String(i)).sort(compareStableText).slice(0, 300)
      expect(rows[0]).toEqual(expected)
    } finally { db.close() }
  })
  it('时间和分数相同的最终结果固定使用ID兜底，并保持去重和20条上限', async () => {
    const db = database(Array.from({ length: 25 }, (_, i) => '共享匹配 ' + i))
    try {
      const query = '共享匹配', base = understandQuery(db, query, '2026-10-05')
      // 阻止FTS返回，使同分最终排序独立于全文位置评分接受检验。
      const prepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation(sql => {
        if (sql.includes('bm25(messages_fts) AS rank')) throw new Error('隔离模拟全文不可用')
        return prepare(sql)
      })
      for (const sort of ['relevance', 'oldest'] as const) {
        const result = await snapshot(db, query, { ...base, sort })
        expect(result.map(row => row.messageId)).toEqual(Array.from({ length: 25 }, (_, i) => String(i)).sort(compareStableText).slice(0, 20))
      }
      db.prepare("UPDATE messages SET content='共享匹配 重复内容' WHERE id IN ('0','1')").run()
      const result = await snapshot(db, query, base)
      expect(result.some(row => row.messageId === '0')).toBe(true)
      expect(result.some(row => row.messageId === '1')).toBe(false)
    } finally { db.close() }
  })
})

describe('区域排序扰动不能改变生产候选与检索路径', () => {
  it.each(['抛错', '反向', '全相等'])('%s时Top24、Top12、表达式、消息身份和评分完全相同', async mode => {
    const words = Array.from({ length: 13 }, (_, i) => String.fromCharCode(97 + i).repeat(2))
    const query = [...words, ...words.map(word => word.toUpperCase())].join('，'), db = database(words.map(word => word + ' 隔离材料'))
    try {
      const capture = recordFts(db)
      const collect = async () => {
        const u = understandQuery(db, query, '2026-10-05')
        const top24 = planSearchTerms(query, u).slice(0, 24).map(term => term.text)
        const result = await snapshot(db, query, u)
        return { top24, top12: top24.slice(0, 12), expression: capture.expressions.at(-1), result }
      }
      const before = await collect()
      const original = String.prototype.localeCompare
      try {
        String.prototype.localeCompare = mode === '抛错' ? function () { throw new Error('禁止区域排序') }
          : mode === '反向' ? function (this: string, other) { return -compareStableText(String(this), String(other)) } : function () { return 0 }
        expect(await collect()).toEqual(before)
      } finally { String.prototype.localeCompare = original }
    } finally { db.close() }
  })
})

describe('短查询身份、评分与排序硬门禁', () => {
  it.each([
    ['车辆', '2026-10-04 关于安吉星和车辆主动安全聊了什么？',
      ['我用过安吉星，远程查看状态挺方便。', '车辆主动安全能帮助减少碰撞风险。'],
      [{ messageId: '1', relevanceScore: 0.51 }, { messageId: '0', relevanceScore: 0.21 }]],
    ['拼车', '2026-10-04 南京到光山的拼车信息是什么？',
      ['南京出发，目的地光山，今晚有空位。', '光山回程，司机下午确认。', '南京出发到光山，顺风拼车可带两位。',
        '从南京回光山，有车找人同行。', '南京到光山的拼车，联系方式稍后发。'],
      [{ messageId: '2', relevanceScore: 0.51 }, { messageId: '4', relevanceScore: 0.51 },
        { messageId: '0', relevanceScore: 0.42 }, { messageId: '3', relevanceScore: 0.42 }, { messageId: '1', relevanceScore: 0.21 }]]
  ])('%s保持原Windows消息身份、评分和顺序', async (_label, query, contents, expected) => {
    const db = database(contents)
    try {
      const u = understandQuery(db, query, '2026-10-05')
      expect(await snapshot(db, query, u)).toEqual(expected)
      expect(u.dateRange).toEqual({ label: '2026-10-04', start: '2026-10-04', end: '2026-10-04' })
    } finally { db.close() }
  })
})

describe('长查询窗口与精度验收', () => {
  it.each([
    ['公众号排版工具是谁推荐的？', '公众号排版工具适合文章制作。', '公众号的广告投放。'],
    ['微信小程序项目有什么信息？', '微信小程序项目分享。', '小程序的信息说明。']
  ])('%s的完整证据保留，只有泛化片段的负例不误召回', async (query, relevant, noise) => {
    const db = database([noise, relevant])
    try {
      const result = await snapshot(db, query, understandQuery(db, query, '2026-10-05'))
      expect(result.map(row => row.messageId)).toEqual(['1'])
    } finally { db.close() }
  })
  it.each([
    ['Claude Code 的介绍', 'Claude Code 的编程能力。', 'Claude 今天天气晴朗。',
      [{ messageId: '1', relevanceScore: 0.88 }, { messageId: '0', relevanceScore: 0.61 }]],
    ['南京到光山的拼车信息是什么？', '南京出发到光山，顺风拼车可带两位。', '天气预报信息说明。',
      [{ messageId: '1', relevanceScore: 0.51 }, { messageId: '0', relevanceScore: 0.21 }]]
  ])('%s保持旧宽泛命中的身份、低分和相关证据优先', async (query, relevant, broad, expected) => {
    const db = database([broad, relevant])
    try {
      // 旧生产隔离对照确认这两条宽泛命中已存在；本轮只锁定原有评分和顺序。
      expect(await snapshot(db, query, understandQuery(db, query, '2026-10-05'))).toEqual(expected)
    } finally { db.close() }
  })
  it.each([7, 13])('%i组大小写词按原查询位置入窗，不由大写编码决定', async count => {
    const words = Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i).repeat(2))
    const query = [...words, ...words.map(word => word.toUpperCase())].join('，'), db = database(words.map(word => word + ' 隔离材料'))
    try {
      const u = understandQuery(db, query, '2026-10-05'), plan = planSearchTerms(query, u)
      const top24 = plan.slice(0, 24), top12 = top24.slice(0, 12), result = await snapshot(db, query, u)
      expect(top24).toHaveLength(Math.min(count * 2 + 1, 24))
      expect(top12.map(term => term.text)).toEqual([...words, ...words.map(word => word.toUpperCase())].slice(0, 12))
      expect(result).toHaveLength(count === 7 ? 7 : 12)
      expect(result.every(row => Number(row.messageId) < Math.min(count, 12))).toBe(true)
      expect(plan.filter(term => term.sourcePriority === 1).every(term => term.phrasePriority === 0 && term.conditionalLength === 0)).toBe(true)
    } finally { db.close() }
  })
  it('具体车辆组合证据优先于仅安全的泛化噪声', async () => {
    const db = database(['讨论安全。', '讨论车辆安全。'])
    try {
      const query = '关于车辆安全大家怎么说？', result = await snapshot(db, query, understandQuery(db, query, '2026-10-05'))
      expect(result[0].messageId).toBe('1')
      expect(result.find(row => row.messageId === '1')!.relevanceScore).toBeGreaterThan(result.find(row => row.messageId === '0')!.relevanceScore)
    } finally { db.close() }
  })
})
