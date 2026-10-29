import type { DatabaseSync } from 'node:sqlite'
import { addSearchHistory, removeSearchHistory, sanitizeSearchHistory, SEARCH_HISTORY_LIMIT, MAX_SEARCH_HISTORY_QUERY_BYTES, type SearchHistoryResult } from '../shared/search-history'

export const SEARCH_HISTORY_SETTING = 'search_recent_queries_v1'
// 六条查询即使全部需要 JSON 转义也保持有界；不读取或存储搜索结果。
const MAX_STORED_BYTES = SEARCH_HISTORY_LIMIT * MAX_SEARCH_HISTORY_QUERY_BYTES * 6 + 1024
interface HistoryIpc { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => unknown }

export function readSearchHistory(db: DatabaseSync): string[] {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key=? AND length(CAST(value_json AS BLOB))<=?')
    .get(SEARCH_HISTORY_SETTING, MAX_STORED_BYTES) as { value_json: string } | undefined
  if (!row) return []
  try { return sanitizeSearchHistory(JSON.parse(row.value_json)) } catch { return [] }
}
function save(db: DatabaseSync, queries: string[]): string[] {
  db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
    .run(SEARCH_HISTORY_SETTING, JSON.stringify(queries), new Date().toISOString())
  return queries
}

/** 复用原运行数据库的设置键，调用方不能指定存储位置、键名或结果正文。 */
export function registerSearchHistoryIpc(ipc: HistoryIpc, db: DatabaseSync): void {
  function safe(action: () => string[]): SearchHistoryResult<string[]> {
    try { return { ok: true, value: action() } }
    catch { return { ok: false, error: { message: '最近搜索未能读取或保存，本次搜索仍可继续。' } } }
  }
  ipc.handle('search-history:list', () => safe(() => readSearchHistory(db)))
  ipc.handle('search-history:record', (_event, query: string) => safe(() => save(db, addSearchHistory(readSearchHistory(db), query))))
  ipc.handle('search-history:remove', (_event, query: string) => safe(() => save(db, removeSearchHistory(readSearchHistory(db), query))))
  ipc.handle('search-history:clear', () => safe(() => save(db, [])))
}
