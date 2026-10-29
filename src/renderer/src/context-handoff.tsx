import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ContextHandoffApi, ContextPreview } from '../../shared/context-handoff'
import { CONTEXT_LIMITS } from '../../shared/context-handoff'
import type { MarkdownExportOutcome, MarkdownExportResult } from '../../shared/markdown-export'
import './context-handoff.css'

const Context = createContext<{ ids: readonly string[]; add: (id: string) => void; remove: (id: string) => void; open: () => void } | null>(null)
const limit = CONTEXT_LIMITS.max_messages

export function ContextHandoffProvider({ children, api: supplied }: { children: ReactNode; api?: ContextHandoffApi }): React.JSX.Element {
  const api = supplied ?? (typeof window === 'undefined' ? undefined : window.privateRadar?.contextHandoff)
  const [ids, setIds] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const current = useRef<string[]>([])
  const revision = useRef(0)
  function update(next: string[]): void { current.current = next; revision.current++; setIds(next); setError('') }
  function add(id: string): void {
    if (current.current.includes(id)) return
    if (current.current.length >= limit) { setError('每次最多选择 200 条消息，请先移除部分内容。'); setOpen(true); return }
    update([...current.current, id])
  }
  function remove(id: string): void { update(current.current.filter(value => value !== id)) }
  return <Context.Provider value={api ? { ids, add, remove, open: () => setOpen(value => !value) } : null}>
    {children}
    {api && open && <div className="context-handoff-float">
      <div className="context-handoff-heading"><h2>准备分析的聊天记录</h2><button type="button" onClick={() => setOpen(false)}>收起</button></div>
      {error && <p role="alert">{error}</p>}
      <ContextHandoffPanel api={api} ids={ids} getRevision={() => revision.current}
        onRemove={remove} onClear={() => update([])} />
    </div>}
  </Context.Provider>
}

export function AddContextButton({ messageId }: { messageId: string }): React.JSX.Element | null {
  const context = useContext(Context)
  if (!context) return null
  const selected = context.ids.includes(messageId)
  return <button type="button" className="context-handoff-add" aria-pressed={selected} onClick={() => selected ? context.remove(messageId) : context.add(messageId)}>
    {selected ? '已加入 · 点击移除' : '加入分析材料'}
  </button>
}

export function ContextHandoffEntry(): React.JSX.Element | null {
  const context = useContext(Context)
  if (!context) return null
  return <button type="button" className="context-handoff-entry" onClick={context.open}>整理聊天给 AI 分析（{context.ids.length}）</button>
}

async function unwrap<T>(value: Promise<MarkdownExportResult<T>>): Promise<T> {
  const result = await value
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export function ContextHandoffPanel({ api, ids, getRevision, onRemove, onClear }: {
  api: ContextHandoffApi; ids: readonly string[]; getRevision: () => number
  onRemove: (id: string) => void; onClear: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<{ key: string; value: ContextPreview } | null>(null)
  const [directory, setDirectory] = useState('')
  const [result, setResult] = useState<MarkdownExportOutcome | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [feedbackKey, setFeedbackKey] = useState('')
  const locked = useRef(false)
  const mounted = useRef(true)
  const request = useRef(0)
  const key = JSON.stringify([getRevision(), ids])
  const selectionKey = useRef(key)
  selectionKey.current = key
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++ } }, [])
  const current = preview?.key === key ? preview.value : null
  async function run(kind: string, action: (valid: () => boolean) => Promise<void>): Promise<void> {
    if (locked.current) return
    locked.current = true; setBusy(kind); setFeedbackKey(key); setNotice(''); setError(''); setResult(null)
    const version = getRevision(), ticket = ++request.current, selected = key
    const valid = () => mounted.current && ticket === request.current && version === getRevision() && selected === selectionKey.current
    try { await action(valid) }
    catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '分析材料操作失败，请重试。') }
    finally { locked.current = false; if (mounted.current) setBusy('') }
  }
  function remove(id?: string): void {
    request.current++; setPreview(null); setResult(null); setNotice(''); setError('')
    if (id === undefined) onClear(); else onRemove(id)
  }
  async function exportFile(format: 'markdown' | 'json'): Promise<void> {
    await run('export', async valid => {
      const value = await unwrap(api.export({ message_ids: ids }, format))
      if (valid()) {
        setResult(value)
        setNotice(value.status === 'cancelled' ? '导出已取消，已有文件已保留。' : value.status === 'unchanged'
          ? '已有相同且完整的分析材料，已保留原文件。' : '分析材料导出成功。')
      }
    })
  }
  const stats = current?.snapshot.statistics
  return <section className="context-handoff-panel" aria-label="准备分析的聊天记录与整理结果" aria-busy={!!busy}>
    <p>准备分析的聊天记录：{ids.length} 条消息{stats && <> · {stats.evidence_count} 条关联证据 · 约 {stats.character_count.toLocaleString()} 字符</>}</p>
    <p className="context-handoff-note">关联证据随消息自动加入分析材料。仅在本机整理和复制，不会自动发送给 AI；关闭应用后清空分析材料。</p>
    {ids.length === 0 ? <p>从搜索结果或展开的会话原始消息中，点击“加入分析材料”。</p> : <ul className="context-handoff-selection">
      {ids.map((id, index) => {
        const item = current?.snapshot.items.find(value => value.id === id)
        const snippet = item ? Array.from(item.content).slice(0, 80).join('') : ''
        return <li key={id}><span>{item ? <><strong>{item.displayConversationName}</strong> · {item.sender ?? '发送人未提供'} · {item.localDate ?? '时间未提供'} {item.localTime ?? ''}<br /><span className="context-handoff-snippet">{snippet}{Array.from(item.content).length > 80 ? '…' : ''}</span></> : <>已选消息 {index + 1}</>}</span>
          <button type="button" disabled={busy === 'export' || busy === 'copy'} aria-label={`移除消息 ${id}`} onClick={() => remove(id)}>移除</button></li>
      })}
    </ul>}
    {ids.length > 0 && !current && <p className="context-handoff-note">点击“查看整理结果”可查看所选消息的来源与正文。</p>}
    <div className="context-handoff-actions">
      <button type="button" disabled={!ids.length || busy === 'export' || busy === 'copy'} onClick={() => remove()}>清空全部消息</button>
      <button type="button" disabled={!ids.length || !!busy} onClick={() => void run('preview', async valid => {
        const value = await unwrap(api.preview({ message_ids: ids }))
        if (valid()) setPreview({ key, value })
      })}>查看整理结果</button>
    </div>
    {stats?.large_context && <p role="alert">当前分析材料较长，部分 AI 工具可能无法一次处理。所有已选内容均完整保留，请按需要自行分批选择。</p>}
    {current && <><h3>整理结果（Markdown）</h3><pre className="context-handoff-preview">{current.markdown}</pre></>}
    <div className="context-handoff-actions">
      <button type="button" disabled={!current || !!busy} onClick={() => void run('copy', async valid => {
        await unwrap(api.copyMarkdown({ message_ids: ids })); if (valid()) setNotice('已复制分析材料，可粘贴给 AI')
      })}>复制给 AI</button>
      <button type="button" disabled={!!busy} onClick={() => void run('directory', async valid => {
        const value = await unwrap(api.chooseDirectory())
        if (valid()) { if (value) setDirectory(value); else setNotice('已取消选择输出目录。') }
      })}>选择输出目录</button>
      <button type="button" disabled={!current || !directory || !!busy} onClick={() => void exportFile('markdown')}>导出 Markdown</button>
      <button type="button" disabled={!current || !directory || !!busy} onClick={() => void exportFile('json')}>导出 JSON</button>
      {busy === 'export' && <button type="button" onClick={() => {
        void unwrap(api.cancel()).then(() => { if (mounted.current) setNotice('正在取消导出…') }).catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : '取消失败，请重试。') })
      }}>取消导出</button>}
    </div>
    {directory && <p className="context-handoff-path">输出目录：{directory}</p>}
    {feedbackKey === key && notice && <p role="status">{notice}</p>}{feedbackKey === key && error && <p role="alert">{error}</p>}
    {feedbackKey === key && result?.directory && <div><p className="context-handoff-path">{result.directory}</p><button type="button" disabled={!!busy} onClick={() => void run('open', async () => { await unwrap(api.openOutput()) })}>打开导出目录</button></div>}
  </section>
}
