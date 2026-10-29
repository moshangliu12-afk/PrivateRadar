import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExportFormat, MarkdownExportApi, MarkdownExportConversation, MarkdownExportOutcome, MarkdownExportResult } from '../../shared/markdown-export'
import type { ObsidianExportApi, ObsidianExportOutcome, ObsidianVaultSettings } from '../../shared/obsidian-export'
import { UiIcon } from './ui-components'
import { useConversationNames } from './conversation-labels'
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
  const [selectedConversationIds, setSelectedConversationIds] = useState<string[]>([])
  const [conversationPickerOpen, setConversationPickerOpen] = useState(false)
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
  const conversationPickerButton = useRef<HTMLButtonElement | null>(null)
  const conversationPicker = useRef<HTMLDivElement | null>(null)
  const optionButtons = useRef(new Map<string, HTMLInputElement>())
  const optionFocus = useRef(0)
  const mounted = useRef(false), loadVersion = useRef(0), reloadPending = useRef(false)
  const selectionInitialized = useRef(false)
  const names = useConversationNames()
  const latestNames = useRef(names), namesAtListRead = useRef<typeof names | null>(null)
  latestNames.current = names
  const active = useRef<'normal' | 'obsidian'>('normal')
  const displayedConversations = conversations.map(value => {
    const known = names !== namesAtListRead.current ? names.get(value.conversationId) : undefined
    return known ? { ...value, sourceConversationName: known.sourceConversationName, userConversationLabel: known.userConversationLabel,
      displayConversationName: known.displayConversationName } : value
  })
  const conversationsById = new Map(displayedConversations.map(value => [value.conversationId, value]))
  const selectedIds = new Set(selectedConversationIds)
  const selectedConversations = selectedConversationIds.map(id => conversationsById.get(id)).filter((value): value is MarkdownExportConversation => !!value)
  const selectedSummary = selectedConversations.length ? selectedConversations.map(value => `${value.displayConversationName} · ${value.messageCount} 条消息`).join('；') : loading ? '正在读取会话…' : '尚未选择会话'
  function finishConversationSelection(): void {
    setConversationPickerOpen(false)
    conversationPickerButton.current?.focus()
  }
  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    if (locked.current) { reloadPending.current = true; return }
    const version = ++loadVersion.current
    const namesAtStart = latestNames.current
    const valid = () => mounted.current && version === loadVersion.current
    setLoading(true); setError('')
    try {
      const values = await unwrap(api.listConversations())
      if (!valid()) return
      namesAtListRead.current = namesAtStart
      setConversations(values)
      const initialized = selectionInitialized.current
      setSelectedConversationIds(current => {
        const retained = current.filter(id => values.some(value => value.conversationId === id))
        return retained.length ? retained : initialized && !current.length ? [] : values[0] ? [values[0].conversationId] : []
      })
      selectionInitialized.current = true
      if (vaultApi) {
        const settings = await unwrap(vaultApi.settings())
        if (valid()) setVault(settings)
      }
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : '会话列表读取失败，请重试。') }
    finally { if (valid()) setLoading(false) }
  }, [api, vaultApi])
  useEffect(() => {
    mounted.current = true; void load()
    const reload = () => { void load() }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', reload)
      window.addEventListener('privateradar-conversations-updated', reload)
    }
    return () => {
      mounted.current = false; loadVersion.current++
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', reload)
        window.removeEventListener('privateradar-conversations-updated', reload)
      }
    }
  }, [load])
  useEffect(() => {
    if (!busy && !loading && reloadPending.current) { reloadPending.current = false; void load() }
  }, [busy, loading, load])
  useEffect(() => {
    if (!conversationPickerOpen) return
    optionButtons.current.get(displayedConversations[optionFocus.current]?.conversationId)?.focus()
    const outside = (event: PointerEvent) => {
      if (!conversationPicker.current?.contains(event.target as Node)) setConversationPickerOpen(false)
    }
    if (typeof document !== 'undefined') document.addEventListener('pointerdown', outside)
    return () => { if (typeof document !== 'undefined') document.removeEventListener('pointerdown', outside) }
  }, [conversationPickerOpen])
  function openConversationPicker(last = false): void {
    const selected = displayedConversations.findIndex(value => selectedIds.has(value.conversationId))
    optionFocus.current = last ? displayedConversations.length - 1 : Math.max(0, selected)
    setConversationPickerOpen(true)
  }
  function selectConversation(id: string, checked: boolean): void {
    setSelectedConversationIds(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id))
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
        ...(format === 'pdf' || selectedConversationIds.length > 1 ? { conversation_ids: selectedConversationIds } : {}),
        conversation_id: selectedConversationIds[0], range: dateRange
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
    if (!vaultApi || locked.current || !selectedConversationIds.length) return
    active.current = 'obsidian'
    locked.current = true; setBusy(true); setError(''); setNotice(''); setResult(null); setVaultResult(null)
    try {
      setVaultResult(await unwrap(vaultApi.start({ conversation_ids: selectedConversationIds, range: dateRange
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
  const batch = result?.batch ?? result?.pdf
  const batchLabel = result?.pdf ? 'PDF' : '普通文件'
  return <section className="settings-section markdown-export-section" aria-labelledby="markdown-export-title">
    <div className="settings-section-heading"><div><span className="settings-kicker">本地导出</span><h2 id="markdown-export-title">导出聊天</h2></div></div>
    <p>将已有聊天导出为 Markdown、JSON、TXT 或 PDF。导出不会改动聊天或来源证据，附件仅保留占位说明。</p>
    <button type="button" className="settings-action-card" disabled={!api || busy} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="settings-action-icon"><UiIcon name="folder" /></span><span>{open ? '收起导出' : '导出聊天'}</span><UiIcon name="arrow" className="settings-action-arrow" />
    </button>
    {open && <div className="markdown-export-form" aria-busy={loading || busy}>
      <div className="markdown-export-conversation-picker" ref={conversationPicker}>
        <span className="markdown-export-picker-label">选择会话</span>
        <button ref={conversationPickerButton} type="button" className="markdown-export-combobox" aria-label="选择会话" aria-describedby="markdown-export-selection-summary" aria-haspopup="dialog" aria-expanded={conversationPickerOpen} aria-controls="markdown-export-conversation-options" disabled={loading || busy || !conversations.length}
          onClick={() => conversationPickerOpen ? setConversationPickerOpen(false) : openConversationPicker()}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openConversationPicker(event.key === 'ArrowUp') }
            else if (event.key === 'Escape') finishConversationSelection()
          }}>
          <span id="markdown-export-selection-summary" className="markdown-export-selection-summary">已选择 {selectedConversationIds.length} 个会话 · 当前已选会话：{selectedSummary}</span><span aria-hidden="true">▾</span>
        </button>
        {selectedConversationIds.length > 50 && <small role="status">已选择超过 50 个会话，导出可能耗时更长；仍可继续选择和导出。</small>}
        {conversationPickerOpen && <div id="markdown-export-conversation-options" className="markdown-export-conversation-options" role="dialog" aria-label="选择多个会话">
          {displayedConversations.map((value, index) => <label key={value.conversationId} className="markdown-export-conversation-option">
            <input type="checkbox" aria-label={`选择会话 ${value.displayConversationName}`} checked={selectedIds.has(value.conversationId)}
            ref={element => { if (element) optionButtons.current.set(value.conversationId, element); else optionButtons.current.delete(value.conversationId) }} disabled={loading || busy}
            onChange={event => selectConversation(value.conversationId, event.target.checked)}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); finishConversationSelection() }
              else if (event.key === 'Enter') { event.preventDefault(); selectConversation(value.conversationId, !selectedIds.has(value.conversationId)) }
              else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? displayedConversations.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + displayedConversations.length) % displayedConversations.length
                optionButtons.current.get(displayedConversations[next]?.conversationId)?.focus()
              }
            }} />{value.displayConversationName} · {value.messageCount} 条消息</label>)}
        </div>}
      </div>
      <label className="markdown-export-range"><input type="checkbox" checked={dateRange} disabled={busy || loading} onChange={event => setDateRange(event.target.checked)} />按日期范围导出（默认导出完整会话）</label>
      {dateRange && <div className="markdown-export-dates"><label>开始日期<input type="date" value={startDate} disabled={busy} onChange={event => setStartDate(event.target.value)} /></label><label>结束日期<input type="date" value={endDate} disabled={busy} onChange={event => setEndDate(event.target.value)} /></label><p>按导出开始时的系统本地时区筛选。此模式不包含未知时间消息，结果会说明排除数量。</p></div>}
      <section className="markdown-export-file-controls" aria-labelledby="markdown-export-file-title">
      <h3 id="markdown-export-file-title">普通文件导出</h3>
      <p>将聊天记录导出为 Markdown、JSON、TXT 或 PDF 文件，保存到指定文件夹。</p>
      <label>导出格式<select aria-label="导出格式" value={format} disabled={loading || busy} onChange={event => {
        const next = event.target.value as ExportFormat
        setFormat(next); setResult(null); setNotice(''); setConversationPickerOpen(false)
      }}>
        <option value="markdown">Markdown</option><option value="json">JSON</option><option value="txt">TXT</option><option value="pdf">PDF</option>
      </select></label>
      <small>{format === 'markdown' ? '适合 Obsidian / Markdown 工具' : format === 'json' ? '适合备份、脚本、AI 和程序处理；不包含实际附件' : format === 'pdf' ? '适合打印与归档；每个会话单独生成一份 A4 文档。' : '适合普通文本阅读与复制'}</small>
      <div className="markdown-export-location"><h4>普通文件保存位置</h4><button type="button" disabled={busy || loading} onClick={() => void choose()}>选择输出目录</button><p className="markdown-export-path">{directory || '尚未选择输出目录'}</p></div>
      <div className="markdown-export-actions"><button type="button" className="markdown-export-start" disabled={busy || loading || !selectedConversationIds.length || !directory || (dateRange && (!startDate || !endDate || startDate > endDate))} onClick={() => void start()}>{busy ? '正在导出…' : '开始导出'}</button>
        {busy && <button type="button" onClick={() => void cancel()}>取消导出</button>}
      </div>
      <small>相同且完整的导出会直接保留；聊天变化或文件被修改时创建新版本，不覆盖旧文件。当前支持 Windows 本地固定 NTFS 目录。</small>
      </section>
      <div className="obsidian-export-controls" aria-labelledby="obsidian-vault-title">
        <h3 id="obsidian-vault-title">Obsidian Vault 归档</h3>
        <p>将聊天记录整理为 Markdown 笔记，保存到指定的 Obsidian Vault。此功能始终生成 .md 文件，与上方普通文件导出相互独立。</p>
        <div className="markdown-export-location"><h4>Obsidian 知识库位置</h4><p className="markdown-export-path">{vault.path || '尚未选择 Vault'}</p>
        <button type="button" disabled={loading || busy || !vaultApi || !vault.supported} onClick={() => void chooseVault()}>选择 Vault</button></div>
        <p>使用上方同一组已选会话和日期范围，按会话及本地日期导出到 Vault 的 PrivateRadar 目录。无需运行 Obsidian。</p>
        <button type="button" className="markdown-export-start" disabled={loading || busy || !vaultApi || !vault.supported || !vault.path || !selectedConversationIds.length || (dateRange && (!startDate || !endDate || startDate > endDate))} onClick={() => void startVault()}>导出到 Obsidian</button>
        <small>仅支持 Windows 本地固定磁盘上的 Vault。未变化的文件跳过；源变化时更新未手改文件；手改或无法确认所有权的文件保留并另写版本。</small>
      </div>
      {error && <p className="markdown-export-error" role="alert">{error}</p>}
      {notice && !result && !vaultResult && <p role="status">{notice}</p>}
      {vaultResult && <div role={vaultResult.failed || vaultResult.batch?.errors.length ? 'alert' : 'status'} className="obsidian-export-result">
        <p>{vaultResult.status === 'cancelled' ? 'Obsidian 导出已取消，已完成的文件已保留。' : vaultResult.failed || vaultResult.batch?.remaining ? 'Obsidian 导出结束，部分文件未完成。' : 'Obsidian 导出完成'}</p>
        <p>会话：{vaultResult.conversationCount} · 新建：{vaultResult.created} · 更新：{vaultResult.updated} · 未变化：{vaultResult.skipped} · 保留用户修改：{vaultResult.preserved} · 失败：{vaultResult.failed}</p>
        {vaultResult.batch && <>
          <p>已处理：{vaultResult.batch.processed} · 未处理：{vaultResult.batch.remaining}</p>
          {vaultResult.batch.errors.map(item => <p key={item.conversationId}>{conversationsById.get(item.conversationId)?.displayConversationName ?? '所选会话'}：{item.message}</p>)}
        </>}
        {vaultResult.userModifiedFilePreserved && <p>已保留用户修改或无法确认所有权的文件，并生成安全新版本。</p>}
        {vaultResult.manifestRecovered && <p>已安全建立导出清单，原有 Markdown 保留。</p>}
        <p className="markdown-export-path">{vaultResult.directory}</p>
        <button type="button" onClick={() => { if (vaultApi) void unwrap(vaultApi.openOutput()).catch(reason => setError(reason instanceof Error ? reason.message : '无法打开 Vault。')) }}>打开 Vault 导出目录</button>
      </div>}
      {result && <div role={batch?.failed ? 'alert' : 'status'}>
        {batch ? <>
          <p>{result.status === 'cancelled' ? `${batchLabel} 导出已取消，已完成的文件已保留。` : batch.failed ? `${batchLabel} 导出结束，部分会话未完成。` : `${batchLabel} 导出完成。`}</p>
          <p>成功：{batch.succeeded} · 新建：{batch.created} · 未变化：{batch.unchanged} · 无消息：{batch.empty} · 失败：{batch.failed} · 未处理：{batch.remaining}</p>
          {batch.errors.map(item => <p key={item.conversationId}>{conversationsById.get(item.conversationId)?.displayConversationName ?? '所选会话'}：{item.message}</p>)}
        </> : <p>{result.status === 'created' ? `导出成功，共 ${result.messageCount} 条消息。` : result.status === 'unchanged' ? '已有相同且完整的导出，已保留原文件。' : result.status === 'empty' ? '这个范围内没有可导出的消息。' : '导出已取消，未覆盖已有文件。'}</p>}
        {result.excludedUnknownTimeCount > 0 && <p>已排除 {result.excludedUnknownTimeCount} 条未知时间消息。</p>}
        {result.directory && <><p className="markdown-export-path">{result.directory}</p><button type="button" onClick={() => { if (api) void unwrap(api.openOutput()).catch(reason => setError(reason instanceof Error ? reason.message : '无法打开输出目录。')) }}>打开导出目录</button></>}
      </div>}
    </div>}
  </section>
}
