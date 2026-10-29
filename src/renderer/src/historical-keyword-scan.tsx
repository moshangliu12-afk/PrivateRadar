import { useEffect, useRef, useState } from 'react'
import type { HistoricalRescanApi, HistoricalRescanState } from '../../shared/historical-keyword-rescan'
import './historical-keyword-scan.css'

export function HistoricalKeywordScan({ api, groupId, enabled, onComplete }: {
  api?: HistoricalRescanApi; groupId: string; enabled: boolean; onComplete: () => Promise<void>
}): React.JSX.Element | null {
  const [state, setState] = useState<HistoricalRescanState | null>(null)
  const [preparing, setPreparing] = useState(false), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const completed = useRef(''), active = useRef(''), locked = useRef(false), callback = useRef(onComplete)
  callback.current = onComplete
  useEffect(() => {
    if (!api) return
    let mounted = true, timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const result = await api!.status(groupId)
        if (!mounted) return
        if (!result.ok) { setError(result.error.message); return }
        setState(result.value)
        if (result.value?.status === 'running') { active.current = result.value.id; timer = setTimeout(() => void poll(), 250) }
        else if (result.value && active.current === result.value.id && completed.current !== result.value.id) {
          completed.current = result.value.id
          await callback.current()
        }
      } catch { if (mounted) setError('无法读取扫描状态，请刷新后重试。') }
    }
    void poll()
    return () => { mounted = false; if (timer) clearTimeout(timer) }
  }, [api, groupId, refresh])
  if (!api) return null
  async function start() {
    if (locked.current) return
    locked.current = true; setPreparing(true); setError('')
    try {
      const result = await api!.start(groupId)
      if (!result.ok) { setError(result.error.message); return }
      active.current = result.value.id; setState(result.value); setRefresh(value => value + 1)
    } catch { setError('扫描未能开始，请稍后重试。') }
    finally { locked.current = false; setPreparing(false) }
  }
  async function cancel() {
    if (!state) return
    try { const result = await api!.cancel(state.id); if (!result.ok) setError(result.error.message) }
    catch { setError('取消请求未完成，请稍后重试。') }
  }
  const running = state?.status === 'running'
  return <div className="historical-keyword-scan">
    <div className="keyword-actions"><button type="button" disabled={!enabled || preparing || running} onClick={() => void start()}>{preparing ? '准备扫描…' : running ? '扫描中…' : '扫描历史聊天'}</button>
      {running && <button type="button" onClick={() => void cancel()}>取消扫描</button>}</div>
    <small>使用当前组的启用关键词重新检查已导入聊天。创建或修改规则不会自动扫描历史。</small>
    {preparing && <p role="status">准备扫描历史聊天…</p>}
    {state && <div role={state.status === 'failed' ? 'alert' : 'status'}>
      <p>{running ? '正在扫描历史聊天' : state.status === 'complete' ? '历史扫描完成' : state.status === 'cancelled' ? '历史扫描已取消' : '历史扫描未完成'}：已扫描 {state.scannedMessages} / {state.totalMessages} 条消息</p>
      {running && <progress aria-label="历史扫描进度" max={Math.max(state.totalMessages, 1)} value={state.scannedMessages} />}
      <p>命中 {state.matchedHits} 处 · 新增 {state.newHits} · 已有 {state.existingHits} · 移除失效 {state.removedHits}</p>
      <small>命中按既有来源位置计数；无附件登记的历史消息直接关联原文。</small>
      {state.error && <p className="keyword-error">{state.error}</p>}
    </div>}
    {error && <p className="keyword-error" role="alert">{error}</p>}
  </div>
}
