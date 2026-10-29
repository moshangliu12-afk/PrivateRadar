import { useEffect, useRef, useState } from 'react'
import type { SearchHistoryApi, SearchHistoryResult } from '../../shared/search-history'
import { sanitizeSearchHistory } from '../../shared/search-history'
import './search-history.css'

export interface SearchHistoryState {
  entries: readonly string[]
  error: string
  record: (query: string) => Promise<void>
  remove: (query: string) => Promise<void>
  clear: () => Promise<void>
}
async function unwrap(value: Promise<SearchHistoryResult<string[]>>): Promise<string[]> {
  const result = await value
  if (!result.ok) throw new Error(result.error.message)
  return sanitizeSearchHistory(result.value)
}

/** 本地设置为唯一持久化来源；界面只保留最近六个搜索词的展示副本。 */
export function useSearchHistory(supplied?: SearchHistoryApi): SearchHistoryState {
  const api = supplied ?? (typeof window === 'undefined' ? undefined : window.privateRadar?.searchHistory)
  const [entries, setEntries] = useState<string[]>([]), [error, setError] = useState('')
  const mounted = useRef(false), revision = useRef(0)
  async function update(action: () => Promise<SearchHistoryResult<string[]>>): Promise<void> {
    const version = ++revision.current
    try {
      const value = await unwrap(action())
      if (mounted.current && version === revision.current) { setEntries(value); setError('') }
    } catch (reason) {
      if (mounted.current && version === revision.current) setError(reason instanceof Error ? reason.message : '最近搜索暂时无法保存到本机。')
    }
  }
  useEffect(() => {
    mounted.current = true
    if (api) void update(() => api.list())
    return () => { mounted.current = false; revision.current++ }
  }, [api])
  return { entries, error,
    record: async query => { if (api) await update(() => api.record(query)) },
    remove: async query => { if (api) await update(() => api.remove(query)) },
    clear: async () => { if (api) await update(() => api.clear()) }
  }
}

export function RecentSearches({ entries, querying, onSearch, onRemove, onClear }: {
  entries: readonly string[]; querying: boolean
  onSearch: (query: string) => Promise<void>
  onRemove: (query: string) => void
  onClear: () => void
}): React.JSX.Element | null {
  if (!entries.length) return null
  return <section className="search-history" aria-label="最近搜索">
    <div className="search-history-heading"><span>最近搜索</span><button type="button" onClick={onClear}>清空历史</button></div>
    <ul className="search-history-list">{entries.map(query => <li key={query}>
      <button className="search-history-query" type="button" title={query} disabled={querying} onClick={() => void onSearch(query)}>{query}</button>
      <button className="search-history-remove" type="button" aria-label={`删除最近搜索：${query}`} title="删除这条搜索历史" onClick={() => onRemove(query)}>×</button>
    </li>)}</ul>
  </section>
}
