import { useEffect, useRef, useState } from 'react'
import type { CollectionDesktopApi, CollectionDetail, CollectionImportStatus, CollectionListEntry } from '../../shared/collections'

export function collectionImportCommand(id: string): string {
  return `把本次两张聊天卡加入 Collection ${id}`
}

export async function copyCollectionText(clipboard: Pick<Clipboard, 'writeText'>, id: string, command = false): Promise<void> {
  await clipboard.writeText(command ? collectionImportCommand(id) : id)
}

export function collectionErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : '批量收集操作失败，请重试。'
  if (message.includes('未终结的导入会话')) return '还有导入任务未结束，暂时不能完成。'
  if (message.includes('COLLECTION_COMPLETED') || message.includes('已完成的归集')) return '此 Collection 已完成，不能继续加入新的聊天批次。'
  return message
}

const importLabels: Record<CollectionImportStatus, string> = {
  pending: '待处理', preparing: '准备中', in_progress: '导入中', success: '成功', partial_success: '部分成功', failed: '失败'
}
const jobLabels: Record<string, string> = { pending: '待处理', running: '导入中', in_progress: '导入中', success: '成功', partial: '部分成功', failed: '失败', cancelled: '已取消' }
const evidenceLabels = { pending: '待准备', available: '已登记可用', missing: '登记为缺失', corrupt: '登记为损坏', error: '登记异常' }
function dateTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }

export function CollectionList({ entries, busy, onOpen, onStart }: {
  entries: CollectionListEntry[]; busy: boolean; onOpen: (id: string) => void; onStart: () => void
}): React.JSX.Element {
  if (!entries.length) return <section className="collection-card collection-empty">
    <h2>还没有批量收集记录</h2><p>为多次双卡导入创建一个固定的收集记录。</p>
    <button className="collection-primary" type="button" disabled={busy} onClick={onStart}>开始收集</button>
  </section>
  return <div className="collection-list">{entries.map((entry) => <article className="collection-card" key={entry.id}>
    <div className="collection-row"><h2>{entry.display_name}</h2><span className={`collection-badge ${entry.status}`}>{entry.status === 'collecting' ? '收集中' : '已完成'}</span></div>
    <p>创建时间：<time dateTime={entry.created_at}>{dateTime(entry.created_at)}</time></p>
    {entry.completed_at && <p>完成时间：<time dateTime={entry.completed_at}>{dateTime(entry.completed_at)}</time></p>}
    <p>{entry.sessionCount} 次导入 · {entry.itemCount} 个附件</p>
    <p>附件概况：成功 {entry.successfulItems} · 失败 {entry.failedItems} · 待结束 {entry.activeItems} · 部分成功 {entry.partialItems}</p>
    <button type="button" disabled={busy} onClick={() => onOpen(entry.id)}>查看详情<span className="collection-identity">{entry.id}</span></button>
  </article>)}</div>
}

export function CollectionDetailView({ detail, busy, onCopy, onComplete }: {
  detail: CollectionDetail; busy: boolean; onCopy: (command?: boolean) => void; onComplete: () => void
}): React.JSX.Element {
  const { collection, sessions } = detail
  return <>
    <section className="collection-card">
      <div className="collection-row"><h2>{collection.display_name}</h2><span className={`collection-badge ${collection.status}`}>{collection.status === 'collecting' ? '收集中' : '已完成'}</span></div>
      <p>创建时间：<time dateTime={collection.created_at}>{dateTime(collection.created_at)}</time></p>
      {collection.completed_at && <p>完成时间：<time dateTime={collection.completed_at}>{dateTime(collection.completed_at)}</time></p>}
      <div className="collection-id"><span>Collection ID</span><code>{collection.id}</code>
        <button type="button" onClick={() => onCopy()}>复制 Collection ID</button></div>
      {collection.status === 'collecting' ? <>
        <p>把这个 Collection ID 和本次两张微信聊天卡一起发送给 WorkBuddy，即可加入本次收集。</p>
        <p className="collection-command">{collectionImportCommand(collection.id)}</p>
        <div className="collection-actions"><button type="button" onClick={() => onCopy(true)}>复制导入口令</button>
          <button className="collection-primary" type="button" disabled={busy} onClick={onComplete}>完成收集</button></div>
      </> : <p className="collection-notice">此 Collection 已完成，不能继续加入新的聊天批次。</p>}
    </section>
    <section className="collection-sessions" aria-label="收集中的导入记录">
      <h2>导入记录 <small>{sessions.length} 次</small></h2>
      <p className="collection-stat-note">统计来自当前有效导入任务，不代表跨批去重后的唯一消息数。Evidence 仅显示数据库登记状态，不检查物理文件。</p>
      {!sessions.length && <p className="collection-card">还没有加入聊天批次。导入后点击“刷新”即可查看。</p>}
      {sessions.map((session, index) => <details className="collection-card collection-session" key={session.id}>
        <summary><strong>第 {index + 1} 次导入</strong><span>{importLabels[session.status]}</span><span>{session.items.length} 个附件</span>
          <time dateTime={session.created_at}>{dateTime(session.created_at)}</time></summary>
        <div className="collection-session-body"><p>会话 ID：<code>{session.id}</code></p>
          {session.stats ? <p>当前有效任务：新增消息 {session.stats.imported} · 重复 {session.stats.duplicate} · 更新 {session.stats.updated} · 无效 {session.stats.invalid}</p>
            : <p>尚无可用的导入任务统计。</p>}
          <p>失败附件：{session.items.filter((item) => item.status === 'failed').length}</p>
          {session.items.map((item) => <article className="collection-item" key={item.id}>
            <div className="collection-row"><h3>附件 {item.ordinal + 1}：{item.attachment_name?.trim() || `附件 ${item.ordinal + 1}`}</h3><span>{importLabels[item.status]}</span></div>
            {item.source_hint && <p>来源：{item.source_hint}</p>}
            <p>导入任务：{item.job ? jobLabels[item.job.status] ?? '状态待确认' : '尚未创建'}</p>
            {item.job && <p>任务 ID：<code>{item.job.id}</code></p>}
            <p>Evidence：{item.evidence_source_kind === 'directory' ? '目录快照' : 'ZIP 文件'} · {item.evidenceRecorded ? evidenceLabels[item.evidence_status] : '未登记'}</p>
            {item.error_summary && <p className="collection-error">失败信息：{item.error_summary}</p>}
          </article>)}
        </div>
      </details>)}
    </section>
  </>
}

export function CollectionPage({ api = window.privateRadar }: { api?: CollectionDesktopApi }): React.JSX.Element {
  const [entries, setEntries] = useState<CollectionListEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CollectionDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)

  async function refresh(id: string | null = selectedId): Promise<void> {
    const request = ++generation.current
    setBusy(true); setError(''); setNotice('')
    try {
      const [nextEntries, nextDetail] = await Promise.all([api.listCollections(), id ? api.getCollection(id) : Promise.resolve(null)])
      if (request !== generation.current) return
      setEntries(nextEntries); setDetail(nextDetail); setSelectedId(id)
      if (id && !nextDetail) setError('该批量收集记录不存在，请返回列表。')
    } catch (reason) { if (request === generation.current) setError(collectionErrorMessage(reason)) }
    finally { if (request === generation.current) setBusy(false) }
  }

  useEffect(() => {
    void refresh(null)
    return () => { generation.current++ }
  }, [api])

  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true); setError('')
    try {
      const collection = await api.createCollection(name)
      setCreating(false); setName(''); setSelectedId(collection.id)
      await refresh(collection.id)
    } catch (reason) { setError(collectionErrorMessage(reason)); setBusy(false) }
  }

  async function complete(): Promise<void> {
    if (!selectedId || busy) return
    setBusy(true); setError('')
    try { await api.completeCollection(selectedId); await refresh(selectedId) }
    catch (reason) { setError(collectionErrorMessage(reason)); setBusy(false) }
  }

  async function copy(command = false): Promise<void> {
    if (!detail) return
    setNotice(''); setError('')
    try { await copyCollectionText(navigator.clipboard, detail.collection.id, command); setNotice('已复制') }
    catch { setError('复制失败，请选择完整 Collection ID 手动复制。') }
  }

  return <div className="collection-page" aria-busy={busy}>
    <div className="collection-actions">
      {selectedId ? <button type="button" disabled={busy} onClick={() => { setDetail(null); void refresh(null) }}>返回列表</button>
        : entries.length > 0 && <button className="collection-primary" type="button" disabled={busy} onClick={() => { setCreating(true); setError('') }}>开始收集</button>}
      <button type="button" disabled={busy} onClick={() => void refresh()}>刷新</button>
    </div>
    {error && <p className="collection-error" role="alert">{error}</p>}
    {notice && <p role="status" className="collection-notice">{notice}</p>}
    {busy && <p role="status">正在读取批量收集记录……</p>}
    {creating && !selectedId && <form className="collection-card collection-create" onSubmit={(event) => void create(event)}>
      <label htmlFor="collection-name">收集名称</label>
      <input id="collection-name" autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：南京到光山拼车" />
      <div className="collection-actions"><button className="collection-primary" type="submit" disabled={busy || !name.trim()}>创建收集</button>
        <button type="button" disabled={busy} onClick={() => { setCreating(false); setName('') }}>取消</button></div>
    </form>}
    {selectedId ? detail && <CollectionDetailView detail={detail} busy={busy} onCopy={(command) => void copy(command)} onComplete={() => void complete()} />
      : !busy && !creating && <CollectionList entries={entries} busy={busy} onOpen={(id) => { setDetail(null); void refresh(id) }} onStart={() => setCreating(true)} />}
  </div>
}
