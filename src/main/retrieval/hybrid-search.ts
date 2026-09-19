import type { DatabaseSync } from 'node:sqlite'
import type { ChatSearchResult, MetadataProvenance, QueryUnderstanding } from '../../shared/models'
import { DEFAULT_DAILY_CONFIG } from '../intelligence/daily/config'
import { extractEntityKeys } from '../intelligence/daily/similarity'
import type { EmbeddingProvider } from '../embedding/provider'

const MAX_BASE_ROWS = 2_000
const MAX_EMBEDDING_CANDIDATES = 120
const MAX_RESULTS = 20
const MIN_RELEVANCE_SCORE = 0.2

interface MessageRow {
  id: string
  conversation_id: string
  conversation_name: string
  sender_id: string
  sender_name: string
  sender_name_source: MetadataProvenance
  timestamp: string
  content: string
  links_json: string
}

interface RankedRow { id: string; rank: number }

export interface HybridSearchResult {
  results: ChatSearchResult[]
  unverifiedTimeResults: ChatSearchResult[]
  embeddingCandidateCount: number
  usedEmbedding: boolean
}

export async function hybridSearch(
  db: DatabaseSync,
  question: string,
  understanding: QueryUnderstanding,
  embeddingProvider: EmbeddingProvider | null
): Promise<HybridSearchResult> {
  const rows = loadFilteredRows(db, understanding, 'verified')
  const unverifiedRows = understanding.timeIntent === 'recent'
    ? loadFilteredRows(db, understanding, 'unverified')
    : []
  if (rows.length === 0 && unverifiedRows.length === 0) {
    return { results: [], unverifiedTimeResults: [], embeddingCandidateCount: 0, usedEmbedding: false }
  }
  const ranked = await rankRows(db, question, understanding, rows, embeddingProvider)
  const unverified = unverifiedRows.length > 0
    ? await rankRows(db, question, understanding, unverifiedRows, embeddingProvider)
    : { results: [], embeddingCandidateCount: 0, usedEmbedding: false }
  return {
    results: ranked.results,
    unverifiedTimeResults: unverified.results,
    embeddingCandidateCount: ranked.embeddingCandidateCount + unverified.embeddingCandidateCount,
    usedEmbedding: ranked.usedEmbedding || unverified.usedEmbedding
  }
}

async function rankRows(
  db: DatabaseSync,
  question: string,
  understanding: QueryUnderstanding,
  rows: MessageRow[],
  embeddingProvider: EmbeddingProvider | null
): Promise<Pick<HybridSearchResult, 'results' | 'embeddingCandidateCount' | 'usedEmbedding'>> {
  if (rows.length === 0) return { results: [], embeddingCandidateCount: 0, usedEmbedding: false }
  const allowed = new Set(rows.map((row) => row.id))
  const searchTerms = allSearchTerms(understanding)
  const ftsScores = ftsSearch(db, searchTerms, allowed)
  // 主关键词分数保持原有精确检索语义；扩展词只通过 expansionScore 参与，避免宽泛同义词稀释精确匹配。
  const lexicalScores = new Map(rows.map((row) => [row.id, lexicalScore(row, understanding.searchTerms)]))
  const entityScores = new Map(rows.map((row) => [row.id, entityScore(row, understanding.entityKeys)]))
  const embeddingScores = new Map<string, number>()
  let embeddingCandidateCount = 0
  let usedEmbedding = false

  if (embeddingProvider) {
    const pool = selectEmbeddingPool(rows, ftsScores, lexicalScores)
    embeddingCandidateCount = pool.length
    if (pool.length > 0) {
      try {
        const [queryVector] = await embeddingProvider.embed([question.slice(0, 500)])
        const vectors = await loadOrCreateEmbeddings(db, pool, embeddingProvider, queryVector.length)
        for (const row of pool) {
          const vector = vectors.get(row.id)
          if (vector) embeddingScores.set(row.id, cosineSimilarity(queryVector, vector))
        }
        usedEmbedding = true
      } catch {
        usedEmbedding = false
        embeddingScores.clear()
      }
    }
  }

  const d1Scores = loadD1Scores(db)
  const topicScores = loadTopicScores(db)
  const hasContentTerms = searchTerms.length > 0 || understanding.entityKeys.length > 0
  const ranked = rows.flatMap((row): ChatSearchResult[] => {
    const fts = ftsScores.get(row.id) ?? 0
    const lexical = lexicalScores.get(row.id) ?? 0
    const entity = entityScores.get(row.id) ?? 0
    const semantic = Math.max(0, embeddingScores.get(row.id) ?? 0)
    const expansion = expansionScore(row, understanding)
    const subject = subjectScore(question, row.content)
    if (!matchesStrictEntities(row, understanding.entityKeys)) return []
    if (understanding.entityKeys.length > 0 && entity === 0 && semantic < 0.58) return []
    if (hasContentTerms && lexical === 0 && entity === 0 && expansion === 0 && semantic < 0.58) return []
    if (understanding.searchTerms.length >= 2 && lexical < 0.5 && entity === 0 && expansion === 0 && semantic < 0.58) return []
    if (!matchesRequiredTerms(row, searchTerms) && entity === 0 && expansion === 0 && semantic < 0.58) return []
    if (understanding.coreTopics.includes('工具更新') && expansion === 0 && semantic < 0.58) return []
    if (understanding.searchTerms.includes('工具') && !row.content.includes('工具') && subject === 0 && expansion === 0 && semantic < 0.58) return []
    const d1 = Math.min(1, (d1Scores.get(row.id) ?? 0) / 16)
    const topic = Math.min(1, (topicScores.get(row.id) ?? 0) / 100)
    const filterMatch = understanding.conversationIds.length > 0 || understanding.senderIds.length > 0 ? 1 : 0
    const action = actionScore(question, row.content)
    const score = lexical * 0.27 + fts * 0.15 + semantic * 0.25 + entity * 0.22 + expansion * 0.24 + action * 0.06 + subject * 0.04 + d1 * 0.025 + topic * 0.01 + filterMatch * 0.005
    if (score < MIN_RELEVANCE_SCORE) return []
    return [{
      messageId: row.id,
      conversationId: row.conversation_id,
      conversationName: row.conversation_name,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderNameSource: row.sender_name_source,
      timestamp: row.timestamp,
      timeVerification: row.timestamp ? 'verified' : 'unknown',
      content: row.content,
      links: safeStringArray(row.links_json),
      relevanceScore: Number(score.toFixed(5)),
      matchReasons: matchReasons({ fts, lexical, semantic, entity, expansion, d1, topic, understanding })
    }]
  }).sort((left, right) => understanding.sort === 'oldest'
    ? left.timestamp.localeCompare(right.timestamp) || right.relevanceScore - left.relevanceScore || left.messageId.localeCompare(right.messageId)
    : right.relevanceScore - left.relevanceScore || right.timestamp.localeCompare(left.timestamp) || left.messageId.localeCompare(right.messageId)
  )

  return { results: deduplicateResults(ranked).slice(0, MAX_RESULTS), embeddingCandidateCount, usedEmbedding }
}

function matchesStrictEntities(row: MessageRow, queryEntities: string[]): boolean {
  const strict = queryEntities.filter((key) => key.startsWith('product:') || key.startsWith('github:'))
  if (strict.length === 0) return true
  const rowEntities = extractEntityKeys(row.content, DEFAULT_DAILY_CONFIG)
  const compactText = row.content.toLowerCase().replace(/[^a-z0-9\p{Script=Han}]+/gu, '')
  return strict.some((key) => {
    if (rowEntities.has(key)) return true
    const value = key.slice(key.indexOf(':') + 1).replace(/[^a-z0-9]+/g, '')
    return value.length >= 3 && compactText.includes(value)
  })
}

function matchesRequiredTerms(row: MessageRow, searchTerms: string[]): boolean {
  const required = searchTerms.filter((term) => ['公众号', '微信小程序', 'GitHub'].includes(term))
  if (required.length === 0) return true
  const haystack = `${row.content} ${safeStringArray(row.links_json).join(' ')}`.toLowerCase()
  return required.some((term) => haystack.includes(term.toLowerCase()))
}

function deduplicateResults(results: ChatSearchResult[]): ChatSearchResult[] {
  const seen = new Set<string>()
  return results.filter((result) => {
    const key = result.content.normalize('NFKC').toLowerCase()
      .replace(/第\s*\d+\s*(位|条)/g, '第#$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function loadFilteredRows(db: DatabaseSync, understanding: QueryUnderstanding, timeGroup: 'verified' | 'unverified'): MessageRow[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  const hasExplicitDateFilter = understanding.dateRange.label !== '全部时间'
  if (hasExplicitDateFilter && understanding.dateRange.start) {
    if (timeGroup === 'verified') {
      conditions.push("date(timestamp, 'localtime') >= ?")
      params.push(understanding.dateRange.start)
    }
  }
  if (hasExplicitDateFilter && understanding.dateRange.end) {
    if (timeGroup === 'verified') {
      conditions.push("date(timestamp, 'localtime') <= ?")
      params.push(understanding.dateRange.end)
    }
  }
  if (understanding.timeIntent === 'recent' && timeGroup === 'unverified') {
    conditions.push("(timestamp IS NULL OR timestamp = '')")
  }
  if (understanding.conversationIds.length > 0) {
    conditions.push(`conversation_id IN (${understanding.conversationIds.map(() => '?').join(',')})`)
    params.push(...understanding.conversationIds)
  }
  if (understanding.senderIds.length > 0) {
    conditions.push(`sender_id IN (${understanding.senderIds.map(() => '?').join(',')})`)
    params.push(...understanding.senderIds)
  }
  params.push(MAX_BASE_ROWS)
  return db.prepare(`
    SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
           sender_id, COALESCE(sender_name, '') AS sender_name, sender_name_source,
           COALESCE(timestamp, '') AS timestamp, content, links_json
    FROM messages
    ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY COALESCE(NULLIF(timestamp, ''), imported_at) DESC, id DESC LIMIT ?
  `).all(...params) as unknown as MessageRow[]
}

function allSearchTerms(understanding: QueryUnderstanding): string[] {
  return [...new Set([...understanding.searchTerms, ...understanding.expandedTerms])]
    .filter((term) => term.length >= 2)
    .slice(0, 24)
}

function expansionScore(row: MessageRow, understanding: QueryUnderstanding): number {
  if (understanding.expandedTerms.length === 0) return 0
  const content = `${row.content} ${safeStringArray(row.links_json).join(' ')}`.toLowerCase()
  const has = (term: string): boolean => content.includes(term.toLowerCase())
  const eventMatch = understanding.eventTerms.some(has)
  if (understanding.coreTopics.includes('工具更新')) {
    const hasSubject = /工具|产品|软件/.test(row.content) || extractEntityKeys(row.content, DEFAULT_DAILY_CONFIG).size > 0
    return hasSubject && eventMatch ? 1 : 0
  }
  const matched = understanding.expandedTerms.filter(has).length
  if (matched === 0) return 0
  if (understanding.eventTerms.length > 0 && !eventMatch) return 0
  return Math.min(1, matched / Math.min(2, understanding.expandedTerms.length))
}

function ftsSearch(db: DatabaseSync, terms: string[], allowed: Set<string>): Map<string, number> {
  if (terms.length === 0) return new Map()
  const expression = terms.slice(0, 12).map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
  try {
    const rows = db.prepare(`
      SELECT m.id, bm25(messages_fts) AS rank
      FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? ORDER BY rank LIMIT 300
    `).all(expression) as unknown as RankedRow[]
    const filtered = rows.filter((row) => allowed.has(row.id))
    return new Map(filtered.map((row, index) => [row.id, Number((1 - index / Math.max(1, filtered.length * 1.25)).toFixed(4))]))
  } catch {
    return new Map()
  }
}

function lexicalScore(row: MessageRow, terms: string[]): number {
  if (terms.length === 0) return 0
  const haystack = `${row.content} ${safeStringArray(row.links_json).join(' ')}`.toLowerCase()
  let matched = 0
  for (const term of terms) if (haystack.includes(term.toLowerCase())) matched += 1
  return Math.min(1, matched / Math.min(3, terms.length))
}

function actionScore(question: string, content: string): number {
  if (!/推荐|分享|好用|适合/.test(question)) return 0
  return /推荐|分享|好用|适合/.test(content) ? 1 : 0
}

function subjectScore(question: string, content: string): number {
  if (!/工具|项目|产品/.test(question)) return 0
  return extractEntityKeys(content, DEFAULT_DAILY_CONFIG).size > 0 ? 1 : 0
}

function entityScore(row: MessageRow, queryEntities: string[]): number {
  if (queryEntities.length === 0) return 0
  const rowEntities = extractEntityKeys(row.content, DEFAULT_DAILY_CONFIG)
  return queryEntities.some((key) => rowEntities.has(key)) ? 1 : 0
}

function selectEmbeddingPool(rows: MessageRow[], fts: Map<string, number>, lexical: Map<string, number>): MessageRow[] {
  const selected = rows.filter((row) => fts.has(row.id) || (lexical.get(row.id) ?? 0) > 0).slice(0, MAX_EMBEDDING_CANDIDATES)
  if (selected.length >= Math.min(40, rows.length)) return selected
  for (const row of rows) {
    if (selected.length >= Math.min(MAX_EMBEDDING_CANDIDATES, rows.length)) break
    if (!selected.some((item) => item.id === row.id)) selected.push(row)
  }
  return selected
}

async function loadOrCreateEmbeddings(
  db: DatabaseSync,
  rows: MessageRow[],
  provider: EmbeddingProvider,
  dimensions: number
): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>()
  const missing: MessageRow[] = []
  const read = db.prepare('SELECT provider, model, dimensions, vector_blob FROM embeddings WHERE message_id = ?')
  for (const row of rows) {
    const cached = read.get(row.id) as { provider: string; model: string; dimensions: number; vector_blob: Uint8Array } | undefined
    if (cached && cached.provider === provider.id && cached.model === provider.model && cached.dimensions === dimensions) {
      vectors.set(row.id, decodeVector(cached.vector_blob))
    } else {
      missing.push(row)
    }
  }
  if (missing.length > 0) {
    const created = await provider.embed(missing.map((row) => row.content.slice(0, 500)))
    if (created.length !== missing.length || created.some((vector) => vector.length !== dimensions)) throw new Error('Embedding 结果维度不一致')
    const save = db.prepare(`
      INSERT INTO embeddings (message_id, provider, model, dimensions, vector_blob, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        provider = excluded.provider, model = excluded.model, dimensions = excluded.dimensions,
        vector_blob = excluded.vector_blob, created_at = excluded.created_at
    `)
    const now = new Date().toISOString()
    db.exec('BEGIN')
    try {
      missing.forEach((row, index) => {
        vectors.set(row.id, created[index])
        save.run(row.id, provider.id, provider.model, dimensions, encodeVector(created[index]), now)
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return vectors
}

function loadD1Scores(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare(`
    SELECT s.message_id AS id, MAX(c.importance_score) AS score
    FROM daily_candidate_sources s JOIN daily_intelligence_candidates c ON c.id = s.candidate_id
    GROUP BY s.message_id
  `).all() as Array<{ id: string; score: number }>
  return new Map(rows.map((row) => [row.id, row.score]))
}

function loadTopicScores(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare(`
    SELECT s.message_id AS id, MAX(m.signal_score) AS score
    FROM topic_daily_sources s
    JOIN topic_daily_metrics m ON m.topic_id = s.topic_id AND m.metric_date = s.metric_date
    GROUP BY s.message_id
  `).all() as Array<{ id: string; score: number }>
  return new Map(rows.map((row) => [row.id, row.score]))
}

function matchReasons(input: {
  fts: number
  lexical: number
  semantic: number
  entity: number
  expansion: number
  d1: number
  topic: number
  understanding: QueryUnderstanding
}): string[] {
  const reasons: string[] = []
  if (input.fts > 0) reasons.push('全文命中')
  if (input.lexical > 0) reasons.push('关键词匹配')
  if (input.semantic >= 0.58) reasons.push('语义相似')
  if (input.entity > 0) reasons.push('实体匹配')
  if (input.expansion > 0) reasons.push('查询意图匹配')
  if (input.understanding.conversationIds.length > 0) reasons.push('群筛选')
  if (input.understanding.senderIds.length > 0) reasons.push('人物筛选')
  if (input.d1 >= 0.5) reasons.push('D1 重要消息')
  if (input.topic >= 0.5) reasons.push('话题关联')
  return reasons
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftLength = 0
  let rightLength = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftLength += left[index] * left[index]
    rightLength += right[index] * right[index]
  }
  if (leftLength === 0 || rightLength === 0) return 0
  return dot / Math.sqrt(leftLength * rightLength)
}

function encodeVector(vector: number[]): Uint8Array {
  const buffer = Buffer.allocUnsafe(vector.length * 4)
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4))
  return buffer
}

function decodeVector(value: Uint8Array): number[] {
  const buffer = Buffer.from(value)
  return Array.from({ length: buffer.length / 4 }, (_, index) => buffer.readFloatLE(index * 4))
}

function safeStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
