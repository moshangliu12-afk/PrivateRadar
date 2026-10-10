// CI 专用：合成夹具直接经过生产候选生成与真实 SQLite 检索，不读取用户数据。
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeDatabase } from '../../../src/main/schema'
import { planSearchTerms, understandQuery } from '../../../src/main/retrieval/query-understanding'
import { hybridSearch } from '../../../src/main/retrieval/hybrid-search'

const fixtures = [7, 13].map(count => {
  const words = Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i).repeat(2))
  return { name: count === 7 ? '十四词' : '二十六词',
    query: [...words, ...words.map(word => word.toUpperCase())].join('，'),
    contents: words.map(word => word + ' 隔离审计材料') }
})
fixtures.push(
  { name: '车辆短查询', query: '2026-10-04 关于安吉星和车辆主动安全聊了什么？',
    contents: ['我用过安吉星，远程查看状态挺方便。', '车辆主动安全能帮助减少碰撞风险。'] },
  { name: '拼车短查询', query: '2026-10-04 南京到光山的拼车信息是什么？',
    contents: ['南京出发，目的地光山，今晚有空位。', '光山回程，司机下午确认。', '南京出发到光山，顺风拼车可带两位。',
      '从南京回光山，有车找人同行。', '南京到光山的拼车，联系方式稍后发。'] },
  { name: '中文自然语言', query: '关于车辆安全大家怎么说？', contents: ['讨论安全。', '讨论车辆安全。'] },
  { name: '中英混合', query: '昨天谁提到 Claude Code 和知识库检索？',
    contents: ['Claude Code 可以辅助编程。', '知识库检索可以定位原始材料。', '普通聊天。'] }
)

export async function captureSearchRuntime() {
  const scenarios = []
  let sqlite = ''
  for (const fixture of fixtures) {
    const db = new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      sqlite = String(db.prepare('SELECT sqlite_version() AS version').get()!.version)
      db.prepare("INSERT INTO conversations(id,platform,name,created_at) VALUES ('隔离群','wechat','隔离群','2026-10-04')").run()
      fixture.contents.forEach((content, index) => {
        db.prepare("INSERT INTO messages(id,platform,conversation_id,sender_id,timestamp,timestamp_source,content,message_type,source,fingerprint,imported_at) VALUES (?, 'wechat','隔离群','隔离发送人','2026-10-04T12:00:00Z','source_native',?,'text','fixture',?,'2026-10-04')")
          .run(String(index), content, String(index))
      })
      const u = understandQuery(db, fixture.query, '2026-10-05')
      const metadata = planSearchTerms(fixture.query, u)
      const expressions: string[] = [], statements: string[] = []
      const prepare = db.prepare.bind(db)
      // 只旁路记录 SQL 与实参；仍执行原生 SQLite 语句，不替换查询结果。
      db.prepare = sql => {
        const statement = prepare(sql)
        if (sql.includes('bm25(messages_fts) AS rank')) {
          const all = statement.all.bind(statement)
          statement.all = (...params) => {
            expressions.push(String(params[0])); statements.push(sql)
            return Reflect.apply(all, statement, params)
          }
        }
        return statement
      }
      const result = await hybridSearch(db, fixture.query, u, null)
      assert.ok(statements.length > 0)
      assert.ok(statements.every(sql => sql.includes('ORDER BY rank, m.id COLLATE BINARY LIMIT 300')))
      scenarios.push({ name: fixture.name, query: fixture.query,
        generatedCandidates: { searchTerms: u.searchTerms, expandedTerms: u.expandedTerms },
        allCandidates: metadata, top24: metadata.slice(0, 24).map(term => term.text),
        top12: metadata.slice(0, 12).map(term => term.text), ftsExpression: expressions[0],
        results: result.results.map(row => ({ messageId: row.messageId, relevanceScore: row.relevanceScore })),
        dateRange: u.dateRange, stableFtsSql: true })
    } finally { db.close() }
  }
  return { runtime: { platform: process.platform, arch: process.arch, node: process.version,
    electron: process.versions.electron ?? null, icu: process.versions.icu, sqlite,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, scenarios }
}
