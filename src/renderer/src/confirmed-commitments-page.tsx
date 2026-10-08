import { useEffect, useRef, useState } from 'react'
import type { CommitmentCandidateContext, CommitmentCandidateView, CommitmentDesktopApi, CommitmentResult } from '../../shared/commitment'
import { CommitmentContext, CommitmentOccurrence, commitmentCandidateError, commitmentCandidateReason } from './commitment-candidates-page'

type ConfirmedCommitmentApi = Pick<CommitmentDesktopApi, 'listCommitmentCandidates' | 'getCommitmentCandidateContext' | 'openCommitmentCandidateEvidence'>
type CardApi = Pick<ConfirmedCommitmentApi, 'getCommitmentCandidateContext' | 'openCommitmentCandidateEvidence'>

function reviewedTime(value: string | null): number | null {
  if (!value) return null
  const date = /^(\d{4}-\d{2}-\d{2})T/.exec(value)?.[1]
  const time = Date.parse(value)
  if (!date || !Number.isFinite(time)) return null
  const day = new Date(date + 'T00:00:00Z')
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === date ? time : null
}

/** 仅选择已有审核结果；无效确认时间不能补造，也不能冒充正常空列表。 */
export function selectConfirmedCommitments(candidates: CommitmentCandidateView[]): { candidates: CommitmentCandidateView[]; unavailableCount: number } {
  const confirmed = candidates.filter(candidate => candidate.status === 'confirmed')
  const available = confirmed.filter(candidate => reviewedTime(candidate.reviewedAt) !== null)
  return { candidates: available.sort((left, right) => reviewedTime(right.reviewedAt)! - reviewedTime(left.reviewedAt)! || left.id.localeCompare(right.id, 'en')),
    unavailableCount: confirmed.length - available.length }
}

async function value<T>(request: Promise<CommitmentResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

export function ConfirmedCommitmentCard({ candidate, api }: { candidate: CommitmentCandidateView; api: CardApi }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [context, setContext] = useState<CommitmentCandidateContext | null>(null)
  const [showContext, setShowContext] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  const locked = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function openContext() {
    if (locked.current) return
    if (showContext) { setShowContext(false); return }
    if (context) { setShowContext(true); return }
    locked.current = true; setBusy('context'); setError('')
    try {
      const next = await value(api.getCommitmentCandidateContext(candidate.id))
      if (mounted.current) { setContext(next); setShowContext(true) }
    } catch (reason) { if (mounted.current) setError(commitmentCandidateError(reason)) }
    finally { locked.current = false; if (mounted.current) setBusy('') }
  }
  async function openEvidence() {
    if (locked.current || !candidate.source.evidenceRecorded) return
    locked.current = true; setBusy('evidence'); setError(''); setNotice('')
    try {
      await value(api.openCommitmentCandidateEvidence(candidate.id))
      if (mounted.current) setNotice('已打开该附件的证据目录。')
    } catch (reason) { if (mounted.current) setError(commitmentCandidateError(reason)) }
    finally { locked.current = false; if (mounted.current) setBusy('') }
  }
  const unavailable = !candidate.source.evidenceRecorded || ['missing', 'corrupt', 'error'].includes(candidate.source.evidenceStatus)
  const confirmedAt = reviewedTime(candidate.reviewedAt)
  return <article className="confirmed-commitment commitment-candidate" data-candidate-id={candidate.id}>
    <p className="commitment-body">{expanded || candidate.body.length <= 600 ? candidate.body : candidate.body.slice(0, 600) + '…'}</p>
    {candidate.body.length > 600 && <button type="button" className="confirmed-secondary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? '收起原文' : '展开原文'}</button>}
    <CommitmentOccurrence entry={candidate} />
    <div className="commitment-source"><span>来源：{candidate.source.attachmentName?.trim() || `附件 ${candidate.source.ordinal + 1}`}</span></div>
    {confirmedAt !== null && <p className="confirmed-review-time">你确认于：{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(confirmedAt))}</p>}
    {unavailable && <p className="commitment-muted">该附件的证据不可用，原话仍保留。</p>}
    <div className="commitment-actions">
      <button type="button" className="commitment-primary" disabled={!!busy} onClick={() => void openContext()} aria-expanded={showContext}>{busy === 'context' ? '读取上下文…' : showContext ? '收起上下文' : '查看上下文'}</button>
      <button type="button" className="confirmed-secondary" disabled={!!busy || !candidate.source.evidenceRecorded} onClick={() => void openEvidence()}>{busy === 'evidence' ? '检查证据…' : '查看证据'}</button>
    </div>
    <details className="commitment-rule confirmed-reason"><summary>为什么出现</summary><p>{commitmentCandidateReason(candidate)}</p><dl><dt>原因代码</dt><dd>{candidate.reasonCode}</dd><dt>规则编号</dt><dd>{candidate.ruleId}</dd><dt>规则版本</dt><dd>{candidate.ruleVersion}</dd></dl></details>
    {notice && <p className="commitment-notice" role="status">{notice}</p>}
    {error && <p className="commitment-error" role="alert">{error}</p>}
    {showContext && context && <CommitmentContext context={context} />}
  </article>
}

export function ConfirmedCommitmentsContent({ candidates, api }: { candidates: CommitmentCandidateView[]; api: CardApi }): React.JSX.Element {
  const selected = selectConfirmedCommitments(candidates)
  return <section className="commitment-list" aria-label="已确认承诺表达列表">
    {selected.unavailableCount > 0 && <p className="commitment-error" role="alert">部分已确认记录缺少有效确认时间，暂未展示，请刷新后重试。</p>}
    {selected.candidates.length ? selected.candidates.map(candidate => <ConfirmedCommitmentCard key={candidate.id} candidate={candidate} api={api} />)
      : selected.unavailableCount === 0 && <div className="commitment-empty">还没有已确认的承诺表达。</div>}
  </section>
}

export function ConfirmedCommitmentsPage({ api = window.privateRadar.commitmentCandidates }: { api?: ConfirmedCommitmentApi }): React.JSX.Element {
  const [candidates, setCandidates] = useState<CommitmentCandidateView[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const mounted = useRef(true)
  const generation = useRef(0)
  async function refresh() {
    const current = ++generation.current
    setPhase('loading')
    try {
      const next = await value(api.listCommitmentCandidates())
      if (mounted.current && current === generation.current) { setCandidates(next); setPhase('ready') }
    } catch { if (mounted.current && current === generation.current) setPhase('error') }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++ } }, [api])
  return <div className="commitment-candidates-page confirmed-commitments-page" aria-busy={phase === 'loading'}>
    <div className="commitment-refresh"><span>最近确认的在前。</span><button type="button" disabled={phase === 'loading'} onClick={() => void refresh()}>{phase === 'loading' ? '读取中…' : '刷新'}</button></div>
    {phase === 'loading' && <p role="status">正在读取已确认的承诺表达…</p>}
    {phase === 'error' && <p className="commitment-error" role="alert">承诺表达加载失败，请刷新重试。</p>}
    {phase === 'ready' && <ConfirmedCommitmentsContent candidates={candidates} api={api} />}
  </div>
}
