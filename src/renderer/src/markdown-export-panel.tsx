import { useRef, useState } from 'react'
import type { ExportFormat, MarkdownExportApi, MarkdownExportConversation, MarkdownExportOutcome, MarkdownExportResult } from '../../shared/markdown-export'
import { UiIcon } from './ui-components'
import './markdown-export-panel.css'

async function unwrap<T>(request: Promise<MarkdownExportResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export function MarkdownExportPanel({ api: supplied }: { api?: MarkdownExportApi }): React.JSX.Element {
  const api = supplied ?? (typeof window === 'undefined' ? undefined : window.privateRadar?.markdownExport)
  const [open, setOpen] = useState(false)
  const [conversations, setConversations] = useState<MarkdownExportConversation[]>([])
  const [conversationId, setConversationId] = useState('')
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [dateRange, setDateRange] = useState(false)
  const [startDate, setStartDate] = useState(''), [endDate, setEndDate] = useState('')
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [result, setResult] = useState<MarkdownExportOutcome | null>(null)
  const locked = useRef(false)
  async function load(): Promise<void> {
    if (!api) return
    setLoading(true); setError('')
    try {
      const values = await unwrap(api.listConversations())
      setConversations(values)
      setConversationId(current => values.some(value => value.conversationId === current) ? current : values[0]?.conversationId ?? '')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '会话列表读取失败，请重试。') }
    finally { setLoading(false) }
  }
  async function choose(): Promise<void> {
    if (!api || locked.current) return
    locked.current = true; setLoading(true); setError(''); setNotice('')
    try {
      const value = await unwrap(api.chooseDirectory())
      if (value) setDirectory(value); else setNotice('已取消选择目录，未执行导出。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法选择输出目录。') }
    finally { locked.current = false; setLoading(false) }
  }
  async function start(): Promise<void> {
    if (!api || locked.current) return
    locked.current = true; setBusy(true); setError(''); setNotice(''); setResult(null)
    try {
      const value = await unwrap(api.start({ ...(format === 'markdown' ? {} : { format }), conversation_id: conversationId, range: dateRange
        ? { type: 'date_range', start_date: startDate, end_date: endDate }
        : { type: 'conversation', start_date: null, end_date: null } }))
      setResult(value)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '导出失败，原数据和已有文件未被覆盖。') }
    finally { locked.current = false; setBusy(false) }
  }
  async function cancel(): Promise<void> {
    if (!api) return
    try { await unwrap(api.cancel()); setNotice('已请求取消，正在安全结束导出。') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '取消请求未完成。') }
  }
  return <section className="settings-section markdown-export-section" aria-labelledby="markdown-export-title">
    <div className="settings-section-heading"><div><span className="settings-kicker">本地导出</span><h2 id="markdown-export-title">导出聊天</h2></div></div>
    <p>将已有聊天导出为 Markdown、JSON 或 TXT。导出不会改动聊天或来源证据，附件仅保留占位说明。</p>
    <button type="button" className="settings-action-card" disabled={!api || busy} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load() }}>
      <span className="settings-action-icon"><UiIcon name="folder" /></span><span>{open ? '收起导出' : '导出聊天'}</span><UiIcon name="arrow" className="settings-action-arrow" />
    </button>
    {open && <div className="markdown-export-form" aria-busy={loading || busy}>
      <label>选择会话<select value={conversationId} disabled={loading || busy || !conversations.length} onChange={event => setConversationId(event.target.value)}>
        {!conversations.length && <option value="">{loading ? '正在读取会话…' : '没有可导出的会话'}</option>}
        {conversations.map(value => <option key={value.conversationId} value={value.conversationId}>{value.displayConversationName} · {value.messageCount} 条消息</option>)}
      </select></label>
      <label>导出格式<select aria-label="导出格式" value={format} disabled={loading || busy} onChange={event => { setFormat(event.target.value as ExportFormat); setResult(null); setNotice('') }}>
        <option value="markdown">Markdown</option><option value="json">JSON</option><option value="txt">TXT</option>
      </select></label>
      <small>{format === 'markdown' ? '适合 Obsidian / Markdown 工具' : format === 'json' ? '适合备份、脚本、AI 和程序处理；不包含实际附件' : '适合普通文本阅读与复制'}</small>
      <button type="button" disabled={loading || busy} onClick={() => void load()}>刷新会话名称</button>
      <label className="markdown-export-range"><input type="checkbox" checked={dateRange} disabled={busy || loading} onChange={event => setDateRange(event.target.checked)} />按日期范围导出（默认导出完整会话）</label>
      {dateRange && <div className="markdown-export-dates"><label>开始日期<input type="date" value={startDate} disabled={busy} onChange={event => setStartDate(event.target.value)} /></label><label>结束日期<input type="date" value={endDate} disabled={busy} onChange={event => setEndDate(event.target.value)} /></label><p>按导出开始时的系统本地时区筛选。此模式不包含未知时间消息，结果会说明排除数量。</p></div>}
      <div><button type="button" disabled={busy || loading} onClick={() => void choose()}>选择输出目录</button><p className="markdown-export-path">{directory || '尚未选择输出目录'}</p></div>
      <div className="markdown-export-actions"><button type="button" className="markdown-export-start" disabled={busy || loading || !conversationId || !directory || (dateRange && (!startDate || !endDate || startDate > endDate))} onClick={() => void start()}>{busy ? '正在导出…' : '开始导出'}</button>
        {busy && <button type="button" onClick={() => void cancel()}>取消导出</button>}
      </div>
      <small>相同且完整的导出会直接保留；聊天变化或文件被修改时创建新版本，不覆盖旧文件。当前支持 Windows 本地固定 NTFS 目录。</small>
      {error && <p className="markdown-export-error" role="alert">{error}</p>}
      {notice && !result && <p role="status">{notice}</p>}
      {result && <div role="status">
        <p>{result.status === 'created' ? `导出成功，共 ${result.messageCount} 条消息。` : result.status === 'unchanged' ? '已有相同且完整的导出，已保留原文件。' : result.status === 'empty' ? '这个范围内没有可导出的消息。' : '导出已取消，未覆盖已有文件。'}</p>
        {result.excludedUnknownTimeCount > 0 && <p>已排除 {result.excludedUnknownTimeCount} 条未知时间消息。</p>}
        {result.directory && <><p className="markdown-export-path">{result.directory}</p><button type="button" onClick={() => { if (api) void unwrap(api.openOutput()).catch(reason => setError(reason instanceof Error ? reason.message : '无法打开输出目录。')) }}>打开导出目录</button></>}
      </div>}
    </div>}
  </section>
}
