export const SEARCH_HISTORY_LIMIT = 6
// 仅限制本地历史条目的大小，不限制或截断原有搜索请求。
export const MAX_SEARCH_HISTORY_QUERY_BYTES = 8192
export type SearchHistoryResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
export interface SearchHistoryApi {
  list: () => Promise<SearchHistoryResult<string[]>>
  record: (query: string) => Promise<SearchHistoryResult<string[]>>
  remove: (query: string) => Promise<SearchHistoryResult<string[]>>
  clear: () => Promise<SearchHistoryResult<string[]>>
}

/** 去重只折叠空白；实际提交词仍原样保存，重搜不会改写引号等检索语义。 */
export function normalizeSearchHistoryKey(query: string): string { return query.trim().replace(/\s+/gu, ' ') }
export function validateSearchHistoryQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('搜索词不能为空。')
  const query = value.trim()
  if (new TextEncoder().encode(query).length > MAX_SEARCH_HISTORY_QUERY_BYTES) throw new Error('搜索词较长，未保存到最近搜索；本次检索仍可继续。')
  return query
}
export function sanitizeSearchHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const queries: string[] = [], keys = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    let query: string
    try { query = validateSearchHistoryQuery(item) } catch { continue }
    const key = normalizeSearchHistoryKey(query)
    if (keys.has(key)) continue
    keys.add(key); queries.push(query)
    if (queries.length === SEARCH_HISTORY_LIMIT) break
  }
  return queries
}
export function addSearchHistory(history: unknown, value: unknown): string[] {
  const query = validateSearchHistoryQuery(value), key = normalizeSearchHistoryKey(query)
  return [query, ...sanitizeSearchHistory(history).filter(item => normalizeSearchHistoryKey(item) !== key)].slice(0, SEARCH_HISTORY_LIMIT)
}
export function removeSearchHistory(history: unknown, value: unknown): string[] {
  const key = normalizeSearchHistoryKey(validateSearchHistoryQuery(value))
  return sanitizeSearchHistory(history).filter(item => normalizeSearchHistoryKey(item) !== key)
}
