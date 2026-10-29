import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationLabelApi, ConversationLabelView, ConversationNameInput } from '../../shared/conversation-labels'
import { resolveDisplayConversationName } from '../../shared/conversation-labels'
import './conversation-labels.css'

const Context = createContext<{ names: Map<string, ConversationLabelView>; edit?: (value: ConversationNameInput) => void }>({ names: new Map() })

export function ConversationLabelEditor({ view, onSave, onClose }: {
  view: ConversationLabelView; onSave: (label: string | null) => Promise<void>; onClose: () => void
}): React.JSX.Element {
  const [text, setText] = useState(view.userConversationLabel ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  async function save(label: string | null): Promise<void> {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try { await onSave(label) } catch (reason) { setError(reason instanceof Error ? reason.message : '会话名称保存失败，请重试。') }
    finally { locked.current = false; setBusy(false) }
  }
  return <div className="conversation-label-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="conversation-label-editor" role="dialog" aria-modal="true" aria-labelledby="conversation-label-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose() }}>
      <h2 id="conversation-label-title">修改会话显示名称</h2>
      <p>来源名称：{view.sourceConversationName ?? '未知会话'}</p>
      <form onSubmit={event => { event.preventDefault(); void save(text.trim() || null) }}>
        <label>自定义会话名称<input autoFocus value={text} maxLength={120} disabled={busy} onChange={event => setText(event.target.value)} /></label>
        <p>仅修改 PrivateRadar 中的显示名称。清空后显示来源名称；来源未提供时显示“未知会话”。</p>
        {error && <p role="alert">{error}</p>}
        <div className="conversation-label-actions">
          <button type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
          <button type="button" disabled={busy || view.userConversationLabel === null} onClick={() => void save(null)}>清空自定义名称</button>
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
        </div>
      </form>
    </section>
  </div>
}

export function ConversationLabelProvider({ children, api: supplied }: { children: ReactNode; api?: ConversationLabelApi }): React.JSX.Element {
  const api = supplied ?? (typeof window === 'undefined' ? undefined : window.privateRadar?.conversationLabels)
  const [names, setNames] = useState(new Map<string, ConversationLabelView>())
  const [editing, setEditing] = useState<ConversationLabelView | null>(null)
  const revision = useRef(0)
  const mounted = useRef(false)
  const refresh = useCallback(async () => {
    if (!api) return
    const version = ++revision.current
    try {
      const result = await api.listConversations()
      if (mounted.current && version === revision.current && result.ok) setNames(new Map(result.value.map(value => [value.conversationId, value])))
    } catch { /* 名称读取失败时保留现有展示，保存操作仍由主进程验证。 */ }
  }, [api])
  useEffect(() => {
    mounted.current = true; void refresh()
    const reload = () => { void refresh() }
    window.addEventListener('focus', reload)
    window.addEventListener('privateradar-conversations-updated', reload)
    return () => { mounted.current = false; revision.current++; window.removeEventListener('focus', reload); window.removeEventListener('privateradar-conversations-updated', reload) }
  }, [refresh])
  function edit(value: ConversationNameInput): void {
    if (!api || !value.conversationId) return
    const known = names.get(value.conversationId)
    const source = value.sourceConversationName === undefined ? value.conversationName ?? null : value.sourceConversationName
    setEditing(known ?? { conversationId: value.conversationId, sourceConversationName: source, userConversationLabel: value.userConversationLabel ?? null, displayConversationName: resolveDisplayConversationName(value) })
  }
  async function save(label: string | null): Promise<void> {
    if (!api || !editing) throw new Error('会话名称暂时不可用，请重试。')
    const result = await api.setConversationLabel(editing.conversationId, label)
    if (!result.ok) throw new Error(result.error.message)
    revision.current++
    if (mounted.current) { setNames(current => new Map(current).set(result.value.conversationId, result.value)); setEditing(null) }
  }
  return <Context.Provider value={{ names, edit: api ? edit : undefined }}>{children}
    {editing && <ConversationLabelEditor key={editing.conversationId} view={editing} onSave={save} onClose={() => setEditing(null)} />}
  </Context.Provider>
}

// 只读消费现有名称映射用于显示同步，不建立额外缓存或修改名称业务规则。
export function useConversationNames(): ReadonlyMap<string, ConversationLabelView> { return useContext(Context).names }

export function ConversationName({ value, evidence = false }: { value: ConversationNameInput; evidence?: boolean }): React.JSX.Element {
  const state = useContext(Context)
  const current: ConversationNameInput = state.names.get(value.conversationId ?? '') ?? value
  const display = resolveDisplayConversationName(current)
  const source = current.sourceConversationName === undefined ? current.conversationName : current.sourceConversationName
  const title = `来源名称：${source?.trim() ? source : '未知会话'}${current.userConversationLabel ? `；用户自定义：${current.userConversationLabel}` : ''}`
  const original = value.conversationName?.trim() || null
  const sourceChanged = evidence && value.conversationName !== undefined && original !== (source?.trim() || null)
  return <>{state.edit && value.conversationId
    ? <button className="conversation-name" type="button" aria-label={`修改会话名称：${display}`} aria-haspopup="dialog" title="修改会话名称" onClick={() => state.edit?.(value)}>
      {display}<svg className="conversation-name-edit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="m15 5 4 4M4 20l4.5-1 12-12a2.8 2.8 0 0 0-4-4l-12 12L4 20Z" />
      </svg>
    </button>
    : <span title={title}>{display}</span>}
    {evidence && current.userConversationLabel && <small className="conversation-name-origin">用户自定义名称；来源：{source?.trim() ? source : '未知会话'}</small>}
    {sourceChanged && <small className="conversation-name-origin">原始记录会话名称：{original ?? '未提供'}</small>}
  </>
}
