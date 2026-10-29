import { useRef, useState } from 'react'
import type { ExportFormat, MarkdownExportApi, MarkdownExportConversation, MarkdownExportOutcome, MarkdownExportResult } from '../../shared/markdown-export'
import type { ObsidianExportApi, ObsidianExportOutcome, ObsidianVaultSettings } from '../../shared/obsidian-export'
import { UiIcon } from './ui-components'
import './markdown-export-panel.css'

async function unwrap<T>(request: Promise<MarkdownExportResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export function MarkdownExportPanel({ api: supplied, vaultApi: suppliedVault }: { api?: MarkdownExportApi; vaultApi?: ObsidianExportApi }): React.JSX.Element {
  const api = supplied ?? (typeof window === 'undefined' ? undefined : window.privateRadar?.markdownExport)
  const vaultApi = suppliedVault ?? (typeof window === 'undefined' ? undefined : window.privateRadar?.obsidianExport)
  const [open, setOpen] = useState(false)
  const [conversations, setConversations] = useState<MarkdownExportConversation[]>([])
  const [conversationId, setConversationId] = useState('')
  const [pdfConversationIds, setPdfConversationIds] = useState<string[]>([])
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [dateRange, setDateRange] = useState(false)
  const [startDate, setStartDate] = useState(''), [endDate, setEndDate] = useState('')
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [result, setResult] = useState<MarkdownExportOutcome | null>(null)
  const [vault, setVault] = useState<ObsidianVaultSettings>({ path: null, supported: false })
  const [vaultResult, setVaultResult] = useState<ObsidianExportOutcome | null>(null)
  const locked = useRef(false)
  const active = useRef<'normal' | 'obsidian'>('normal')
  const vaultConversationId = format === 'pdf' ? pdfConversationIds[0] ?? '' : conversationId
  async function load(): Promise<void> {
    if (!api) return
    setLoading(true); setError('')
    try {
      const values = await unwrap(api.listConversations())
      setConversations(values)
      setConversationId(current => values.some(value => value.conversationId === current) ? current : values[0]?.conversationId ?? '')
      setPdfConversationIds(current => {
        const retained = current.filter(id => values.some(value => value.conversationId === id))
        return retained.length ? retained : values.some(value => value.conversationId === conversationId) ? [conversationId] : values[0] ? [values[0].conversationId] : []
      })
      if (vaultApi) setVault(await unwrap(vaultApi.settings()))
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
    active.current = 'normal'
    locked.current = true; setBusy(true); setError(''); setNotice(''); setResult(null); setVaultResult(null)
    try {
      const value = await unwrap(api.start({ ...(format === 'markdown' ? {} : { format }),
        ...(format === 'pdf' ? { conversation_ids: pdfConversationIds } : {}),
        conversation_id: format === 'pdf' ? pdfConversationIds[0] : conversationId, range: dateRange
        ? { type: 'date_range', start_date: startDate, end_date: endDate }
        : { type: 'conversation', start_date: null, end_date: null } }))
      setResult(value)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '导出失败，原数据和已有文件未被覆盖。') }
    finally { locked.current = false; setBusy(false) }
  }
  async function chooseVault(): Promise<void> {
    if (!vaultApi || locked.current) return
    locked.current = true; setLoading(true); setError(''); setNotice('')
    try {
      const path = await unwrap(vaultApi.chooseVault())
      if (path) { setVault({ path, supported: true }); setVaultResult(null) }
      else setNotice('已取消选择 Vault，保留原目录。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法选择 Obsidian Vault。') }
    finally { locked.current = false; setLoading(false) }
  }
  async function startVault(): Promise<void> {
    if (!vaultApi || locked.current || !vaultConversationId || (format === 'pdf' && pdfConversationIds.length !== 1)) return
    active.current = 'obsidian'
    locked.current = true; setBusy(true); setError(''); setNotice(''); setResult(null); setVaultResult(null)
    try {
      setVaultResult(await unwrap(vaultApi.start({ conversation_ids: [vaultConversationId], range: dateRange
        ? { type: 'date_range', start_date: startDate, end_date: endDate }
        : { type: 'conversation', start_date: null, end_date: null } })))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Obsidian 导出未完成，请检查 Vault。') }
    finally { locked.current = false; setBusy(false) }
  }
  async function cancel(): Promise<void> {
    if (!api) return
    try { await unwrap(active.current === 'obsidian' && vaultApi ? vaultApi.cancel() : api.cancel()); setNotice('已请求取消，正在安全结束导出。') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '取消请求未完成。') }
  }
  return <section className="settings-section markdown-export-section" aria-labelledby="markdown-export-title">
    <div className="settings-section-heading"><div><span className="settings-kicker">本地导出</span><h2 id="markdown-export-title">导出聊天</h2></div></div>
    <p>将已有聊天导出为 Markdown、JSON、TXT 或 PDF。导出不会改动聊天或来源证据，附件仅保留占位说明。</p>
    <button type="button" className="settings-action-card" disabled={!api || busy} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load() }}>
      <span className="settings-action-icon"><UiIcon name="folder" /></span><span>{open ? '收起导出' : '导出聊天'}</span><UiIcon name="arrow" className="settings-action-arrow" />
    </button>
    {open && <div className="markdown-export-form" aria-busy={loading || busy}>
      <label>选择会话<select aria-label="选择会话" value={format === 'pdf' ? pdfConversationIds : conversationId} multiple={format === 'pdf'} size={format === 'pdf' ? Math.min(6, Math.max(2, conversations.length)) : undefined} disabled={loading || busy || !conversations.length} onChange={event => {
        if (format === 'pdf') {
          const ids = Array.from(event.target.selectedOptions, option => option.value)
          setPdfConversationIds(ids); setConversationId(ids[0] ?? '')
        } else setConversationId(event.target.value)
      }}>
        {!conversations.length && <option value="">{loading ? '正在读取会话…' : '没有可导出的会话'}</option>}
        {conversations.map(value => <option key={value.conversationId} value={value.conversationId}>{value.displayConversationName} · {value.messageCount} 条消息</option>)}
      </select></label>
      <label>导出格式<select aria-label="导出格式" value={format} disabled={loading || busy} onChange={event => {
        const next = event.target.value as ExportFormat
        setFormat(next); setResult(null); setNotice('')
        if (next === 'pdf') setPdfConversationIds(conversationId ? [conversationId] : [])
      }}>
        <option value="markdown">Markdown</option><option value="json">JSON</option><option value="txt">TXT</option><option value="pdf">PDF</option>
      </select></label>
      <small>{format === 'markdown' ? '适合 Obsidian / Markdown 工具' : format === 'json' ? '适合备份、脚本、AI 和程序处理；不包含实际附件' : format === 'pdf' ? '适合打印与归档。可按住 Ctrl 选择多个会话，每个会话单独生成一份 A4 文档。' : '适合普通文本阅读与复制'}</small>
      <button type="button" disabled={loading || busy} onClick={() => void load()}>刷新会话名称</button>
      <label className="markdown-export-range"><input type="checkbox" checked={dateRange} disabled={busy || loading} onChange={event => setDateRange(event.target.checked)} />按日期范围导出（默认导出完整会话）</label>
      {dateRange && <div className="markdown-export-dates"><label>开始日期<input type="date" value={startDate} disabled={busy} onChange={event => setStartDate(event.target.value)} /></label><label>结束日期<input type="date" value={endDate} disabled={busy} onChange={event => setEndDate(event.target.value)} /></label><p>按导出开始时的系统本地时区筛选。此模式不包含未知时间消息，结果会说明排除数量。</p></div>}
      <div><button type="button" disabled={busy || loading} onClick={() => void choose()}>选择输出目录</button><p className="markdown-export-path">{directory || '尚未选择输出目录'}</p></div>
      <div className="markdown-export-actions"><button type="button" className="markdown-export-start" disabled={busy || loading || (format === 'pdf' ? !pdfConversationIds.length : !conversationId) || !directory || (dateRange && (!startDate || !endDate || startDate > endDate))} onClick={() => void start()}>{busy ? '正在导出…' : '开始导出'}</button>
        {busy && <button type="button" onClick={() => void cancel()}>取消导出</button>}
      </div>
      <small>相同且完整的导出会直接保留；聊天变化或文件被修改时创建新版本，不覆盖旧文件。当前支持 Windows 本地固定 NTFS 目录。</small>
      <div className="obsidian-export-controls" aria-labelledby="obsidian-vault-title">
        <h3 id="obsidian-vault-title">Obsidian Vault</h3>
        <p className="markdown-export-path">当前 Vault：{vault.path || '尚未选择 Vault'}</p>
        <button type="button" disabled={loading || busy || !vaultApi || !vault.supported} onClick={() => void chooseVault()}>选择 Vault</button>
        <p>{format === 'pdf' && pdfConversationIds.length > 1 ? 'Obsidian 导出请保留一个已选会话。' : '使用上方已选会话和日期范围，按会话及本地日期导出到 Vault 的 PrivateRadar 目录。无需运行 Obsidian。'}</p>
        <button type="button" className="markdown-export-start" disabled={loading || busy || !vaultApi || !vault.supported || !vault.path || !vaultConversationId || (format === 'pdf' && pdfConversationIds.length !== 1) || (dateRange && (!startDate || !endDate || startDate > endDate))} onClick={() => void startVault()}>导出到 Obsidian</button>
        <small>仅支持 Windows 本地固定磁盘上的 Vault。未变化的文件跳过；源变化时更新未手改文件；手改或无法确认所有权的文件保留并另写版本。</small>
      </div>
      {error && <p className="markdown-export-error" role="alert">{error}</p>}
      {notice && !result && !vaultResult && <p role="status">{notice}</p>}
      {vaultResult && <div role="status" className="obsidian-export-result">
        <p>{vaultResult.status === 'cancelled' ? 'Obsidian 导出已取消，已完成的文件已保留。' : vaultResult.failed ? 'Obsidian 导出结束，部分文件未完成。' : 'Obsidian 导出完成'}</p>
        <p>会话：{vaultResult.conversationCount} · 新建：{vaultResult.created} · 更新：{vaultResult.updated} · 未变化：{vaultResult.skipped} · 保留用户修改：{vaultResult.preserved} · 失败：{vaultResult.failed}</p>
        {vaultResult.userModifiedFilePreserved && <p>已保留用户修改或无法确认所有权的文件，并生成安全新版本。</p>}
        {vaultResult.manifestRecovered && <p>已安全建立导出清单，原有 Markdown 保留。</p>}
        <p className="markdown-export-path">{vaultResult.directory}</p>
        <button type="button" onClick={() => { if (vaultApi) void unwrap(vaultApi.openOutput()).catch(reason => setError(reason instanceof Error ? reason.message : '无法打开 Vault。')) }}>打开 Vault 导出目录</button>
      </div>}
      {result && <div role={result.pdf?.failed ? 'alert' : 'status'}>
        {result.pdf ? <>
          <p>{result.status === 'cancelled' ? 'PDF 导出已取消，已完成的文件已保留。' : result.pdf.failed ? 'PDF 导出结束，部分会话未完成。' : 'PDF 导出完成。'}</p>
          <p>成功：{result.pdf.succeeded} · 新建：{result.pdf.created} · 未变化：{result.pdf.unchanged} · 无消息：{result.pdf.empty} · 失败：{result.pdf.failed} · 未处理：{result.pdf.remaining}</p>
          {result.pdf.errors.map(item => <p key={item.conversationId}>{conversations.find(value => value.conversationId === item.conversationId)?.displayConversationName ?? '所选会话'}：{item.message}</p>)}
        </> : <p>{result.status === 'created' ? `导出成功，共 ${result.messageCount} 条消息。` : result.status === 'unchanged' ? '已有相同且完整的导出，已保留原文件。' : result.status === 'empty' ? '这个范围内没有可导出的消息。' : '导出已取消，未覆盖已有文件。'}</p>}
        {result.excludedUnknownTimeCount > 0 && <p>已排除 {result.excludedUnknownTimeCount} 条未知时间消息。</p>}
        {result.directory && <><p className="markdown-export-path">{result.directory}</p><button type="button" onClick={() => { if (api) void unwrap(api.openOutput()).catch(reason => setError(reason instanceof Error ? reason.message : '无法打开输出目录。')) }}>打开导出目录</button></>}
      </div>}
    </div>}
  </section>
}
