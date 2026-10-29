import { useEffect, useRef, useState } from 'react'
import { ConversationName } from './conversation-labels'
import { HistoricalKeywordScan } from './historical-keyword-scan'
import type { KeywordGroupView, KeywordHitContext, KeywordHitView, KeywordOccurrenceView, KeywordRadarDesktopApi, KeywordRadarResult, KeywordRadarStatus } from '../../shared/keyword-radar'

const safeErrors: Record<string, string> = {
  INVALID_INPUT: '输入无效，请检查名称、关键词或编号。',
  CONFIG_UNAVAILABLE: '关键词组或关键词不存在，或已归档。',
  HIT_UNAVAILABLE: '这条命中或它的来源已不可用，请刷新。',
  EVIDENCE_UNAVAILABLE: '该附件的证据暂不可用，未打开其他来源。'
}
export function keywordRadarError(reason: unknown): string {
  if (reason instanceof Error && Object.hasOwn(safeErrors, reason.message)) return safeErrors[reason.message]
  return '关键词雷达操作未完成，请稍后重试。'
}
async function value<T>(request: Promise<KeywordRadarResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}
function timeLabel(value: string | null, fallback: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return fallback
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
export function KeywordOccurrence({ entry }: { entry: KeywordOccurrenceView }): React.JSX.Element {
  return <div className="keyword-occurrence">
    <span>{entry.senderName ?? '发送人未知'}</span>
    <span>{timeLabel(entry.chatTimestamp, '聊天时间未知')}</span>
    <span><ConversationName value={entry} evidence /></span>
  </div>
}
export function KeywordContext({ context }: { context: KeywordHitContext }): React.JSX.Element {
  return <ol className="keyword-context" aria-label={context.batchItemId === null ? '原始消息上下文' : '同一附件中的上下文'}>
    {context.entries.map(entry => <li key={`${entry.messageId}:${entry.sourcePosition ?? ''}`} aria-current={entry.isCurrent ? 'true' : undefined}>
      <div className="keyword-context-position">{entry.sourcePosition === null ? '原始消息' : `来源位置 ${entry.sourcePosition}`}{entry.isCurrent && <strong>当前命中</strong>}</div>
      <KeywordOccurrence entry={entry} /><p>{entry.body}</p>
    </li>)}
  </ol>
}
const evidenceLabels = { pending: '证据待登记', available: '证据已登记可用', missing: '证据缺失', corrupt: '证据校验未通过', error: '证据状态待检查' }
export function KeywordHitCard({ hit, api }: { hit: KeywordHitView; api: KeywordRadarDesktopApi }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [context, setContext] = useState<KeywordHitContext | null>(null)
  const [showContext, setShowContext] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function openContext() {
    if (showContext) { setShowContext(false); return }
    if (context) { setShowContext(true); return }
    setBusy('context'); setError('')
    try { const next = await value(api.getHitContext(hit.id)); if (mounted.current) { setContext(next); setShowContext(true) } }
    catch (reason) { if (mounted.current) setError(keywordRadarError(reason)) }
    finally { if (mounted.current) setBusy('') }
  }
  async function openEvidence() {
    setBusy('evidence'); setError(''); setNotice('')
    try { await value(api.openHitEvidence(hit.id)); if (mounted.current) setNotice('已打开该附件的证据目录。') }
    catch (reason) { if (mounted.current) setError(keywordRadarError(reason)) }
    finally { if (mounted.current) setBusy('') }
  }
  return <article className="keyword-hit" data-hit-id={hit.id}>
    <header><h3>{hit.groupName}</h3><small>发现时间：{timeLabel(hit.matchedAt, '发现时间未知')}</small></header>
    <div className="keyword-matched" aria-label="历史命中词"><span>命中</span>{hit.matchedTerms.map((term, index) => <span className="keyword-chip" key={index}>{term}</span>)}</div>
    <KeywordOccurrence entry={hit} />
    <p className="keyword-body">{expanded || hit.body.length <= 600 ? hit.body : hit.body.slice(0, 600) + '…'}</p>
    {hit.body.length > 600 && <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? '收起正文' : '展开正文'}</button>}
    <div className="keyword-source"><span>来源：{hit.batchItemId === null ? '历史消息（本命中未绑定附件）' : hit.source.attachmentName ?? (hit.source.ordinal === null ? '来源未登记' : `附件 ${hit.source.ordinal + 1}`)}</span><span>{hit.source.evidenceRecorded ? evidenceLabels[hit.source.evidenceStatus] : '证据未登记'}</span></div>
    {hit.batchItemId !== null && <details className="keyword-source-id"><summary>附件编号</summary><code>{hit.batchItemId}</code></details>}
    <div className="keyword-actions">
      <button type="button" disabled={!!busy} onClick={() => void openContext()} aria-expanded={showContext}>{busy === 'context' ? '读取上下文…' : showContext ? '收起上下文' : '查看上下文'}</button>
      <button type="button" disabled={!!busy || !hit.source.evidenceRecorded} onClick={() => void openEvidence()}>{busy === 'evidence' ? '检查证据…' : '查看证据'}</button>
    </div>
    {notice && <p className="keyword-notice" role="status">{notice}</p>}
    {error && <p className="keyword-error" role="alert">{error}</p>}
    {showContext && context && <KeywordContext context={context} />}
  </article>
}
function KeywordGroupCard({ group, api, changed, onRescanComplete }: { group: KeywordGroupView; api: KeywordRadarDesktopApi; changed: () => Promise<void>; onRescanComplete: () => Promise<void> }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [name, setName] = useState(group.name)
  const [renaming, setRenaming] = useState(false)
  const [archive, setArchive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  async function act(request: () => Promise<KeywordRadarResult<unknown>>, success?: (result: unknown) => void) {
    setBusy(true); setError(''); setNotice('')
    try { const result = await value(request()); success?.(result); await changed() }
    catch (reason) { setError(keywordRadarError(reason)) }
    finally { setBusy(false) }
  }
  return <article className={`keyword-group${!group.enabled || group.archivedAt ? ' is-disabled' : ''}`} data-group-id={group.id}>
    <header><h3>{group.name}</h3><span>{group.archivedAt ? '已归档' : group.enabled ? '已启用' : '已停用'}</span></header>
    {!group.archivedAt && <div className="keyword-rule-stats" aria-label="规则命中统计" title="统计全部已有命中；同一消息的多个来源只计一次。">
      <span>历史命中：<strong>{group.stats?.historicalMatchCount ?? 0}</strong> 条</span>
      <span>最近发现：{timeLabel(group.stats?.latestDiscoveryAt ?? null, '暂无')}</span>
    </div>}
    <div className="keyword-terms">{group.terms.length ? group.terms.map(term => <span className={`keyword-chip${term.enabled ? '' : ' is-disabled'}`} key={term.id}>
      <span>{term.term}</span>{!group.archivedAt && <button type="button" disabled={busy} aria-label={`${term.enabled ? '停用' : '启用'}关键词 ${term.term}`} aria-pressed={term.enabled}
        onClick={() => void act(() => api.setTermEnabled(term.id, !term.enabled))}>{term.enabled ? '停用' : '启用'}</button>}
      {group.archivedAt && !term.enabled && <small>已停用</small>}
    </span>) : <p className="keyword-muted">还没有关键词，添加一个关心的词。</p>}</div>
    {!group.archivedAt && <>
      <form className="keyword-inline-form" onSubmit={event => { event.preventDefault(); void act(() => api.addTerm(group.id, draft.trim()), result => {
        const outcome = (result as { outcome: string }).outcome
        setNotice(outcome === 'exists' ? '这个关键词已经存在' : outcome === 'reenabled' ? '已重新启用' : '关键词已添加'); setDraft('')
      }) }}>
        <label htmlFor={`keyword-term-${group.id}`}>添加关键词</label>
        <div><input id={`keyword-term-${group.id}`} maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} disabled={busy} placeholder="输入你关心的词" /><button type="submit" disabled={busy || !draft.trim()}>添加</button></div>
      </form>
      <div className="keyword-actions"><button type="button" disabled={busy} onClick={() => void act(() => api.setGroupEnabled(group.id, !group.enabled))}>{group.enabled ? '停用组' : '启用组'}</button>
        <button type="button" disabled={busy} onClick={() => { setName(group.name); setRenaming(!renaming); setArchive(false) }}>改组名</button>
        <button type="button" disabled={busy} onClick={() => { setArchive(!archive); setRenaming(false) }}>归档</button></div>
      <HistoricalKeywordScan api={api.historicalRescan} groupId={group.id} enabled={group.enabled} onComplete={onRescanComplete} />
      {renaming && <form className="keyword-inline-form" onSubmit={event => { event.preventDefault(); void act(() => api.renameGroup(group.id, name.trim()), () => setRenaming(false)) }}>
        <label htmlFor={`keyword-name-${group.id}`}>新组名</label><div><input id={`keyword-name-${group.id}`} maxLength={200} value={name} onChange={event => setName(event.target.value)} disabled={busy} /><button type="submit" disabled={busy || !name.trim()}>保存组名</button><button type="button" onClick={() => setRenaming(false)} disabled={busy}>取消</button></div>
      </form>}
      {archive && <div className="keyword-confirm"><p>归档后不会再匹配新的聊天，已有命中记录仍会保留。</p><div className="keyword-actions"><button type="button" disabled={busy} onClick={() => void act(() => api.archiveGroup(group.id))}>确认归档</button><button type="button" disabled={busy} onClick={() => setArchive(false)}>取消</button></div></div>}
    </>}
    {notice && <p className="keyword-notice" role="status">{notice}</p>}{error && <p className="keyword-error" role="alert">{error}</p>}
  </article>
}
export function KeywordRadarContent({ groups, hits, status, api, refreshGroups, retry, retrying, onRescanComplete = refreshGroups }: {
  groups: KeywordGroupView[]; hits: KeywordHitView[]; status: KeywordRadarStatus; api: KeywordRadarDesktopApi
  refreshGroups: () => Promise<void>; retry: () => void; retrying: boolean
  onRescanComplete?: () => Promise<void>
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = groups.filter(group => !group.archivedAt), archived = groups.filter(group => group.archivedAt)
  async function create() {
    setBusy(true); setError('')
    try { await value(api.createGroup(name.trim())); setName(''); setCreating(false); await refreshGroups() }
    catch (reason) { setError(keywordRadarError(reason)) }
    finally { setBusy(false) }
  }
  return <>
    {status.pending > 0 && <div className="keyword-pending" role="status">有 {status.pending} 个导入批次正在等待关键词检查。</div>}
    {status.failed > 0 && <div className="keyword-failed" role="status"><span>有 {status.failed} 个导入批次的关键词处理失败。</span><button type="button" disabled={retrying} onClick={retry}>{retrying ? '处理中…' : '重新处理'}</button></div>}
    <section className="keyword-settings" aria-labelledby="keyword-settings-title">
      <header className="keyword-section-heading"><h2 id="keyword-settings-title">关键词设置</h2><button type="button" className="keyword-primary" disabled={busy} onClick={() => setCreating(!creating)} aria-expanded={creating}>+ 新增关键词组</button></header>
      <p className="keyword-muted">规则修改只影响之后新导入的聊天，不会自动重新扫描以前的记录。需要时点击“扫描历史聊天”。</p>
      {creating && <form className="keyword-create" onSubmit={event => { event.preventDefault(); void create() }}><label htmlFor="keyword-create-name">组名</label><div><input id="keyword-create-name" maxLength={200} value={name} onChange={event => setName(event.target.value)} disabled={busy} placeholder="例如：拼车" autoFocus /><button type="submit" className="keyword-primary" disabled={busy || !name.trim()}>{busy ? '创建中…' : '创建关键词组'}</button><button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button></div></form>}
      {error && <p className="keyword-error" role="alert">{error}</p>}
      {!active.length && <div className="keyword-empty">还没有设置关键词。点击“新增关键词组”开始。</div>}
      <div className="keyword-group-grid">{active.map(group => <KeywordGroupCard key={group.id} group={group} api={api} changed={refreshGroups} onRescanComplete={onRescanComplete} />)}</div>
      {!!archived.length && <details className="keyword-archived"><summary>已归档关键词组（{archived.length}）</summary><div className="keyword-group-grid">{archived.map(group => <KeywordGroupCard key={group.id} group={group} api={api} changed={refreshGroups} onRescanComplete={onRescanComplete} />)}</div></details>}
    </section>
    <section className="keyword-recent" aria-labelledby="keyword-hits-title"><header className="keyword-section-heading"><h2 id="keyword-hits-title">最近命中</h2><small>按发现时间排序 · 最近 100 条</small></header>
      {!hits.length ? <div className="keyword-empty"><p>还没有命中记录。之后新导入的聊天如果包含这些关键词，会出现在这里。</p><small>不自动扫描以前的聊天记录，可在对应组手动扫描。</small></div> : <div className="keyword-hit-list">{hits.map(hit => <KeywordHitCard key={hit.id} hit={hit} api={api} />)}</div>}
    </section>
  </>
}
export function KeywordRadarPage({ api = window.privateRadar.keywordRadar }: { api?: KeywordRadarDesktopApi }): React.JSX.Element {
  const [groups, setGroups] = useState<KeywordGroupView[]>([])
  const [hits, setHits] = useState<KeywordHitView[]>([])
  const [status, setStatus] = useState<KeywordRadarStatus>({ pending: 0, failed: 0 })
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const mounted = useRef(true)
  async function refresh() {
    const current = ++generation.current; setLoading(true); setError('')
    try {
      const [nextGroups, nextHits, nextStatus] = await Promise.all([value(api.listGroups()), value(api.listRecentHits(100)), value(api.getStatusCounts())])
      if (mounted.current && current === generation.current) { setGroups(nextGroups); setHits(nextHits); setStatus(nextStatus); setLoaded(true) }
    } catch (reason) { if (mounted.current && current === generation.current) setError(keywordRadarError(reason)) }
    finally { if (mounted.current && current === generation.current) setLoading(false) }
  }
  async function refreshGroups() {
    const next = await value(api.listGroups()); if (mounted.current) setGroups(next)
  }
  async function retry() {
    setRetrying(true); setError(''); setNotice('')
    try {
      const result = await value(api.retryFailedRuns())
      if (mounted.current) setNotice(result.status.failed ? `仍有 ${result.status.failed} 个批次处理失败。` : `已完成 ${result.completed} 个批次的关键词检查。`)
      await refresh()
    } catch (reason) { if (mounted.current) setError(keywordRadarError(reason)) }
    finally { if (mounted.current) setRetrying(false) }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++ } }, [api])
  return <div className="keyword-radar-page" aria-busy={loading || retrying}>
    <div className="keyword-refresh"><span>只匹配之后新导入的聊天，不扫描以前的记录。</span><button type="button" disabled={loading || retrying} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新'}</button></div>
    {error && <p className="keyword-error" role="alert">{error}</p>}{notice && <p className="keyword-notice" role="status">{notice}</p>}
    {!loaded ? !error && <p role="status">正在读取关键词与命中记录…</p> : <KeywordRadarContent groups={groups} hits={hits} status={status} api={api} refreshGroups={refreshGroups} retry={() => void retry()} retrying={retrying} onRescanComplete={refresh} />}
  </div>
}
