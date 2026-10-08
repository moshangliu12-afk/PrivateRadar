import { useEffect, useRef, useState } from 'react'
import type { KeywordHitContext, KeywordRadarDesktopApi } from '../../shared/keyword-radar'
import type { TodayKeywordInterest, TodayKeywordInterestApi, TodayKeywordInterestItem } from '../../shared/today-keyword-interest'
import { KeywordContext, KeywordOccurrence, keywordRadarError } from './keyword-radar-page'
import './today-keyword-interest-section.css'

export type TodayKeywordInterestState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' | 'ready'; value: TodayKeywordInterest }

export function TodayKeywordInterestCard({ item, api }: {
  item: TodayKeywordInterestItem; api: KeywordRadarDesktopApi
}): React.JSX.Element {
  const [context, setContext] = useState<KeywordHitContext | null>(null)
  const [showContext, setShowContext] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function openContext(): Promise<void> {
    if (pending.current) return
    if (showContext) { setShowContext(false); return }
    if (context) { setShowContext(true); return }
    pending.current = true; setBusy('context'); setError('')
    try {
      const result = await api.getHitContext(item.representativeHitId)
      if (!result.ok) throw new Error(result.error.code)
      if (mounted.current) { setContext(result.value); setShowContext(true) }
    } catch (reason) { if (mounted.current) setError(keywordRadarError(reason)) }
    finally { pending.current = false; if (mounted.current) setBusy('') }
  }
  async function openEvidence(): Promise<void> {
    if (pending.current || !item.source.evidenceRecorded) return
    pending.current = true; setBusy('evidence'); setError(''); setNotice('')
    try {
      const result = await api.openHitEvidence(item.representativeHitId)
      if (!result.ok) throw new Error(result.error.code)
      if (mounted.current) setNotice('已打开该附件的证据目录。')
    } catch { if (mounted.current) setError('证据暂不可用') }
    finally { pending.current = false; if (mounted.current) setBusy('') }
  }
  return <article className="today-keyword-card" data-batch-item-id={item.batchItemId} data-source-position={item.sourcePosition}>
    <p className="today-keyword-body">{item.body}</p>
    <KeywordOccurrence entry={item} />
    <p className="today-keyword-explanation">命中你关注的关键词：{item.matchedTerms.join('、')}</p>
    <div className="today-keyword-source">
      <span>来源：{item.source.attachmentName ?? `附件 ${item.source.ordinal + 1}`}</span>
      {(!item.source.evidenceRecorded || item.source.evidenceStatus !== 'available') && <span>证据暂不可用</span>}
    </div>
    <div className="today-keyword-actions">
      <button type="button" disabled={!!busy} aria-expanded={showContext} onClick={() => void openContext()}>
        {busy === 'context' ? '读取上下文…' : showContext ? '收起上下文' : '查看上下文'}
      </button>
      <button type="button" disabled={!!busy || !item.source.evidenceRecorded} onClick={() => void openEvidence()}>
        {busy === 'evidence' ? '检查证据…' : '查看证据'}
      </button>
    </div>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {showContext && context && <KeywordContext context={context} />}
  </article>
}

export function TodayKeywordInterestContent({ state, api, onRefresh, onViewAll }: {
  state: TodayKeywordInterestState; api: KeywordRadarDesktopApi; onRefresh: () => void; onViewAll: () => void
}): React.JSX.Element {
  return <section className="today-keyword-section" aria-label="你关注的关键词今天有新消息">
    <header className="today-keyword-heading">
      <div><h2>你关注的关键词今天有新消息</h2>
        <small>{'value' in state ? `今天 / ${state.value.todayDate}` : '按当前系统本地日期读取'}</small>
      </div>
      <button type="button" disabled={state.status === 'loading'} onClick={onRefresh}>
        {state.status === 'error' ? '重新加载' : '刷新'}
      </button>
    </header>
    {state.status === 'loading' && <p role="status">正在读取关注词新消息……</p>}
    {state.status === 'error' && <p role="alert">关注词新消息暂时无法读取，请重试。</p>}
    {state.status === 'empty' && <p className="today-keyword-empty">今天暂无关注词新消息。</p>}
    {state.status === 'ready' && <div className="today-keyword-list">{state.value.items.map(item =>
      <TodayKeywordInterestCard key={JSON.stringify([item.batchItemId, item.sourcePosition])} item={item} api={api} />
    )}</div>}
    <footer><button type="button" onClick={onViewAll}>查看全部</button></footer>
  </section>
}

export function TodayKeywordInterestSection({ refreshRevision = 0, onViewAll, api = window.privateRadar,
  keywordApi = window.privateRadar.keywordRadar }: {
  refreshRevision?: number; onViewAll: () => void; api?: TodayKeywordInterestApi; keywordApi?: KeywordRadarDesktopApi
}): React.JSX.Element {
  const [state, setState] = useState<TodayKeywordInterestState>({ status: 'loading' })
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setState({ status: 'loading' })
    void (async () => {
      try {
        const result = await api.getTodayKeywordInterest()
        if (!result.ok) throw new Error(result.error.code)
        if (current === generation.current) setState({
          status: result.value.items.length ? 'ready' : 'empty', value: result.value
        })
      } catch { if (current === generation.current) setState({ status: 'error' }) }
    })()
    return () => { generation.current++ }
  }, [api, refreshRevision, reload])
  return <TodayKeywordInterestContent state={state} api={keywordApi}
    onRefresh={() => setReload(value => value + 1)} onViewAll={onViewAll} />
}
