import { useEffect, useRef, useState } from 'react'
import type { CommitmentCandidateContext, CommitmentCandidateReview, CommitmentCandidateView, CommitmentDesktopApi, CommitmentOccurrenceView, CommitmentResult } from '../../shared/commitment'

const safeErrors: Record<string, string> = {
  INVALID_INPUT: '候选编号无效，请刷新后重试。',
  CANDIDATE_UNAVAILABLE: '这条候选或它的来源已不可用，请刷新。',
  EVIDENCE_UNAVAILABLE: '该附件的证据不可用，候选仍保留。',
  OPERATION_FAILED: '承诺候选操作未完成，请稍后重试。'
}
export function commitmentCandidateError(reason: unknown): string {
  if (reason instanceof Error && Object.hasOwn(safeErrors, reason.message)) return safeErrors[reason.message]
  return safeErrors.OPERATION_FAILED
}
async function value<T>(request: Promise<CommitmentResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}
const reasonLabels: Record<string, { code: string; label: string }> = {
  self_responsibility: { code: 'explicit_self_responsibility', label: '原话明确由“我”负责具体事项。' },
  self_future_action: { code: 'explicit_self_future_action', label: '原话明确由“我”在稍后采取具体行动。' },
  self_will_action: { code: 'explicit_self_will_action', label: '原话明确表达“我会”采取具体行动。' },
  self_take_action: { code: 'explicit_self_take_action', label: '原话明确表达“我来”采取具体行动。' }
}
export function commitmentCandidateReason(candidate: Pick<CommitmentCandidateView, 'reasonCode' | 'ruleId' | 'ruleVersion'>): string {
  if (candidate.ruleVersion === 'commitment-v1' && Object.hasOwn(reasonLabels, candidate.ruleId)) {
    const saved = reasonLabels[candidate.ruleId]
    if (saved.code === candidate.reasonCode) return saved.label
  }
  return '这条候选的匹配依据尚无可读说明，请查看已保存的规则信息。'
}
function chatTime(entry: CommitmentOccurrenceView): string {
  if (!['source_native', 'user_supplied'].includes(entry.timestampSource ?? '') || !entry.chatTimestamp || !Number.isFinite(Date.parse(entry.chatTimestamp))) return '聊天时间未知'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(entry.chatTimestamp))
}
export function CommitmentOccurrence({ entry }: { entry: CommitmentOccurrenceView }): React.JSX.Element {
  return <div className="commitment-occurrence"><span>{entry.senderName?.trim() ? entry.senderName : '发送人未知'}</span><span>{chatTime(entry)}</span><span>{entry.conversationName?.trim() ? entry.conversationName : '会话未知'}</span></div>
}
export function CommitmentContext({ context }: { context: CommitmentCandidateContext }): React.JSX.Element {
  return <ol className="commitment-context" aria-label="同一附件及会话中的上下文">
    {context.entries.map(entry => <li key={entry.sourcePosition} aria-current={entry.isCurrent ? 'true' : undefined}>
      <div className="commitment-context-position">来源位置 {entry.sourcePosition}{entry.isCurrent && <strong>当前候选原话</strong>}</div>
      <CommitmentOccurrence entry={entry} /><p>{entry.body}</p>
    </li>)}
  </ol>
}
const statusLabels = { pending: '待审核', confirmed: '已确认', ignored: '已忽略' }
const evidenceLabels = { pending: '证据待检查', available: '证据已登记', missing: '证据不可用：已缺失', corrupt: '证据不可用：校验未通过', error: '证据不可用：检查失败' }
export function CommitmentCandidateCard({ candidate, api, onReviewed }: { candidate: CommitmentCandidateView; api: CommitmentDesktopApi; onReviewed: (review: CommitmentCandidateReview) => void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [context, setContext] = useState<CommitmentCandidateContext | null>(null)
  const [showContext, setShowContext] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const locked = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function review(target: 'confirmed' | 'ignored') {
    if (locked.current || candidate.status === target) return
    locked.current = true; setBusy(target); setError(''); setNotice('')
    try {
      const next = await value(target === 'confirmed' ? api.confirmCommitmentCandidate(candidate.id) : api.ignoreCommitmentCandidate(candidate.id))
      if (mounted.current) { onReviewed(next); setNotice(next.status === 'confirmed' ? '已确认原话表达了承诺，可在「承诺表达（已确认）」回看。' : '已忽略这条候选。') }
    } catch (reason) { if (mounted.current) setError(commitmentCandidateError(reason)) }
    finally { locked.current = false; if (mounted.current) setBusy('') }
  }
  async function openContext() {
    if (locked.current) return
    if (showContext) { setShowContext(false); return }
    if (context) { setShowContext(true); return }
    locked.current = true; setBusy('context'); setError('')
    try { const next = await value(api.getCommitmentCandidateContext(candidate.id)); if (mounted.current) { setContext(next); setShowContext(true) } }
    catch (reason) { if (mounted.current) setError(commitmentCandidateError(reason)) }
    finally { locked.current = false; if (mounted.current) setBusy('') }
  }
  async function openEvidence() {
    if (locked.current || !candidate.source.evidenceRecorded) return
    locked.current = true; setBusy('evidence'); setError(''); setNotice('')
    try { await value(api.openCommitmentCandidateEvidence(candidate.id)); if (mounted.current) setNotice('已打开该附件的证据目录。') }
    catch (reason) { if (mounted.current) setError(commitmentCandidateError(reason)) }
    finally { locked.current = false; if (mounted.current) setBusy('') }
  }
  return <article className="commitment-candidate" data-candidate-id={candidate.id}>
    <header><h3>承诺候选</h3><span className={`commitment-status is-${candidate.status}`}>{statusLabels[candidate.status]}</span></header>
    <CommitmentOccurrence entry={candidate} />
    <p className="commitment-body">{expanded || candidate.body.length <= 600 ? candidate.body : candidate.body.slice(0, 600) + '…'}</p>
    {candidate.body.length > 600 && <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? '收起原文' : '展开原文'}</button>}
    <p className="commitment-reason">匹配依据：{commitmentCandidateReason(candidate)}</p>
    <details className="commitment-rule"><summary>已保存的规则信息</summary><dl><dt>原因代码</dt><dd>{candidate.reasonCode}</dd><dt>规则编号</dt><dd>{candidate.ruleId}</dd><dt>规则版本</dt><dd>{candidate.ruleVersion}</dd></dl></details>
    <div className="commitment-source"><span>来源：{candidate.source.attachmentName ?? `附件 ${candidate.source.ordinal + 1}`}</span><span>{candidate.source.evidenceRecorded ? evidenceLabels[candidate.source.evidenceStatus] : '证据不可用：未登记'}</span><span>来源位置 {candidate.sourcePosition}</span></div>
    {(!candidate.source.evidenceRecorded || ['missing', 'corrupt', 'error'].includes(candidate.source.evidenceStatus)) && <p className="commitment-muted">该附件的证据不可用，候选仍保留。</p>}
    <div className="commitment-actions">
      <button type="button" disabled={!!busy} onClick={() => void openContext()} aria-expanded={showContext}>{busy === 'context' ? '读取上下文…' : showContext ? '收起上下文' : '查看上下文'}</button>
      <button type="button" disabled={!!busy || !candidate.source.evidenceRecorded} onClick={() => void openEvidence()}>{busy === 'evidence' ? '检查证据…' : '查看证据'}</button>
      <button type="button" className="commitment-primary" disabled={!!busy || candidate.status === 'confirmed'} onClick={() => void review('confirmed')}>{busy === 'confirmed' ? '确认中…' : '确认'}</button>
      <button type="button" disabled={!!busy || candidate.status === 'ignored'} onClick={() => void review('ignored')}>{busy === 'ignored' ? '忽略中…' : '忽略'}</button>
    </div>
    {notice && <p className="commitment-notice" role="status">{notice}</p>}
    {error && <p className="commitment-error" role="alert">{error}</p>}
    {showContext && context && <CommitmentContext context={context} />}
  </article>
}
export function CommitmentCandidatesContent({ candidates, api, onReviewed }: { candidates: CommitmentCandidateView[]; api: CommitmentDesktopApi; onReviewed: (review: CommitmentCandidateReview) => void }): React.JSX.Element {
  const pending = candidates.filter(candidate => candidate.status === 'pending')
  const reviewed = candidates.filter(candidate => candidate.status !== 'pending')
  return <section className="commitment-list" aria-label="承诺候选列表">
    <p className="commitment-muted">候选需要人工审核；确认仅表示这条原话表达了承诺。</p>
    {!candidates.length && <div className="commitment-empty">还没有承诺候选。之后新导入的聊天产生候选时，会出现在这里。</div>}
    <section className="commitment-review-section" aria-label="待审核">
      <h2>待审核 <small>{pending.length}</small></h2>
      {!pending.length ? <p className="commitment-muted">当前没有待审核的候选。</p> : pending.map(candidate => <CommitmentCandidateCard key={candidate.id} candidate={candidate} api={api} onReviewed={onReviewed} />)}
    </section>
    <section className="commitment-review-section" aria-label="已审核">
      <h2>已审核 <small>{reviewed.length}</small></h2>
      <p className="commitment-muted">已确认或已忽略的候选仍可在这里修正审核状态。</p>
      {!reviewed.length ? <p className="commitment-muted">还没有已审核的候选。</p> : reviewed.map(candidate => <CommitmentCandidateCard key={candidate.id} candidate={candidate} api={api} onReviewed={onReviewed} />)}
    </section>
  </section>
}
export function CommitmentCandidatesPage({ api = window.privateRadar.commitmentCandidates }: { api?: CommitmentDesktopApi }): React.JSX.Element {
  const [candidates, setCandidates] = useState<CommitmentCandidateView[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const generation = useRef(0)
  const reviewRevision = useRef(0)
  const [notice, setNotice] = useState('')
  async function refresh() {
    const current = ++generation.current; const revision = reviewRevision.current; setLoading(true); setError('')
    try {
      const next = await value(api.listCommitmentCandidates())
      if (mounted.current && current === generation.current) { if (revision === reviewRevision.current) setCandidates(next); setLoaded(true) }
    } catch (reason) { if (mounted.current && current === generation.current) setError(commitmentCandidateError(reason)) }
    finally { if (mounted.current && current === generation.current) setLoading(false) }
  }
  function reviewed(review: CommitmentCandidateReview) {
    reviewRevision.current++
    setCandidates(current => current.map(candidate => candidate.id === review.id ? { ...candidate, ...review } : candidate))
    setNotice(review.status === 'confirmed' ? '已确认原话表达了承诺，可在「承诺表达（已确认）」回看。' : '已忽略这条候选。')
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++ } }, [api])
  return <div className="commitment-candidates-page" aria-busy={loading}>
    <div className="commitment-refresh"><span>只读取已有候选，不扫描以前的聊天记录。</span><button type="button" disabled={loading} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新'}</button></div>
    {notice && <p className="commitment-notice" role="status">{notice}</p>}
    {error && <p className="commitment-error" role="alert">{error}</p>}
    {!loaded ? !error && <p role="status">正在读取承诺候选…</p> : <CommitmentCandidatesContent candidates={candidates} api={api} onReviewed={reviewed} />}
  </div>
}
