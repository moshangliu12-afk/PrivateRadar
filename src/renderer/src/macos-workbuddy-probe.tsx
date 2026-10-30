import { useRef, useState } from 'react'
import type { MacWorkBuddyProbeApi, MacWorkBuddyProbeReport } from '../../shared/macos-workbuddy-probe'

export function MacWorkBuddyProbePanel({ enabled, api }: { enabled: boolean; api?: MacWorkBuddyProbeApi }): React.JSX.Element | null {
  const [report, setReport] = useState<MacWorkBuddyProbeReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const service = api ?? (typeof window !== 'undefined' ? window.privateRadar?.macWorkBuddyProbe : undefined)
  if (!enabled || !service) return null
  async function detect(): Promise<void> {
    if (lock.current) return
    lock.current = true; setBusy(true); setReport(null); setNotice('正在只读检测，请稍候…')
    try { setReport(await service!.run()); setNotice('检测完成。请导出检测报告；连接与导入能力仍待真实环境验证。') }
    catch { setNotice('检测未完成。请确认 WorkBuddy 已安装并至少使用过一次，再重试；无需更改系统权限。') }
    finally { lock.current = false; setBusy(false) }
  }
  async function save(): Promise<void> {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try { const result = await service!.exportReport(); setNotice(result.message) }
    catch { setNotice('无法保存检测报告，请重新选择一个本地文件名。') }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="settings-section" aria-labelledby="mac-workbuddy-probe-title">
    <h2 id="mac-workbuddy-probe-title">WorkBuddy</h2>
    <p>尚未完成真实环境验证</p>
    <p>仅检测当前用户的应用、目录结构和运行环境，不读取聊天正文，不配置或修改 WorkBuddy，不导入聊天。报告只在你选择保存时写入本机，不会自动上传。</p>
    <button type="button" disabled={busy} onClick={() => void detect()}>{busy ? '正在处理…' : '检测 macOS WorkBuddy 环境'}</button>
    {report && <>
      <dl>
        <dt>WorkBuddy 应用</dt><dd>{report.workbuddy_app.some(app => app.exists) ? '已发现' : '未发现'}</dd>
        <dt>数据目录</dt><dd>{report.workbuddy_roots.some(root => root.traversal === 'allowed') ? '已发现' : '未发现或无法读取'}</dd>
        <dt>聊天历史结构</dt><dd>{report.chat_history_layout.some(layout => layout.legacy_exists || layout.users.some(user => user.history_exists)) ? '已发现' : '未发现'}</dd>
        <dt>MCP 配置</dt><dd>{report.mcp.some(config => config.exists) ? '已发现' : '未发现'}</dd>
        <dt>运行环境</dt><dd>{report.runtime.env_node_resolves ? 'Node 已发现，WorkBuddy Host 仍待确认' : '待确认'}</dd>
      </dl>
      {!report.workbuddy_roots.some(root => root.traversal === 'allowed') && <p>未发现 WorkBuddy 数据目录。请确认 WorkBuddy 已安装并至少使用过一次。</p>}
      {report.errors.length > 0 && <p>部分查询未完成，报告已记录原因。请直接发回报告，无需修改权限或系统安全设置。</p>}
      <button type="button" disabled={busy} onClick={() => void save()}>导出检测报告</button>
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
