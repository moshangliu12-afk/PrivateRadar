import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MacWorkBuddyProbePanel } from '../src/renderer/src/macos-workbuddy-probe'
import type { MacWorkBuddyProbeApi, MacWorkBuddyProbeReport } from '../src/shared/macos-workbuddy-probe'

interface Frame { values: any[]; cursor: number }
const hooks = vi.hoisted(() => ({ current: null as Frame | null }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useState(initial: unknown) {
      const frame = hooks.current
      if (!frame) return actual.useState(initial)
      const index = frame.cursor++
      if (!(index in frame.values)) frame.values[index] = initial
      return [frame.values[index], (value: unknown) => { frame.values[index] = value }]
    },
    useRef(initial: unknown) {
      const frame = hooks.current
      if (!frame) return actual.useRef(initial)
      const index = frame.cursor++
      if (!(index in frame.values)) frame.values[index] = { current: initial }
      return frame.values[index]
    }
  }
})
afterEach(() => { hooks.current = null; vi.unstubAllGlobals() })
const empty = (): MacWorkBuddyProbeReport => ({
  report_schema: 'macos-workbuddy-probe-v1', generated_at: '2026-10-30T00:00:00Z',
  private_radar: { version: '0.2.0-alpha.26', is_packaged: true, electron_version: '44.10.0', node_version: '24.14.0', user_data_path: '<HOME>/Library/Application Support/PrivateRadar' },
  system: { macos_version: '15.7', darwin_version: '24', cpu_architecture: 'arm64', process_arch: 'arm64' },
  workbuddy_app: [], workbuddy_roots: [], chat_history_layout: [], mcp: [], skills: [],
  runtime: { env_node_resolves: false, executable_path_class: 'missing_or_unavailable', node_version: null, bundled_node_candidates: [] },
  filesystem: [], capability: { read_only: true, connector_registration: 'not_tested', stdio_mcp: 'not_tested', tcc: 'not_inferred', real_mac_workbuddy_validated: false }, privacy_redactions: [], errors: []
})
function view(api: MacWorkBuddyProbeApi, enabled = true) {
  const frame: Frame = { values: [], cursor: 0 }
  return { render() { frame.cursor = 0; hooks.current = frame; try { return MacWorkBuddyProbePanel({ enabled, api }) } finally { hooks.current = null } } }
}
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const item = node as ReactElement<any>
  return [item, ...elements(item.props.children)]
}
function click(tree: ReactNode, label: string): void {
  const button = elements(tree).find(item => item.type === 'button' && item.props.children === label)
  if (!button) throw new Error('缺少按钮：' + label)
  expect(button.props.disabled).toBe(false)
  button.props.onClick()
}
async function flush(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve() }
function api(report = empty()): MacWorkBuddyProbeApi {
  return { run: vi.fn(async () => report), exportReport: vi.fn(async () => ({ status: 'saved' as const, message: '检测报告已保存，请把该 JSON 文件发回。' })) }
}
describe('macOS 专属只读探测界面', () => {
  it('Windows 不显示 M2A 入口，也不调用探测', () => {
    const service = api(), h = view(service, false)
    expect(h.render()).toBeNull(); expect(service.run).not.toHaveBeenCalled()
  })
  it('缺少 macOS 专属预加载 API 时不显示入口', () => {
    expect(renderToStaticMarkup(<MacWorkBuddyProbePanel enabled />)).toBe('')
  })
  it('初始界面明确未验证、只读、不会自动上传；不会自动启动检测', () => {
    const service = api(), h = view(service), html = renderToStaticMarkup(h.render())
    expect(html).toContain('尚未完成真实环境验证'); expect(html).toContain('检测 macOS WorkBuddy 环境')
    expect(html).toContain('不读取聊天正文'); expect(html).toContain('不会自动上传')
    expect(html).not.toContain('导出检测报告'); expect(service.run).not.toHaveBeenCalled()
  })
  it('无 WorkBuddy 显示操作建议并允许导出缺失报告', async () => {
    const service = api(), h = view(service)
    click(h.render(), '检测 macOS WorkBuddy 环境'); await flush()
    const html = renderToStaticMarkup(h.render())
    expect(service.run).toHaveBeenCalledOnce()
    expect(html).toContain('请确认 WorkBuddy 已安装并至少使用过一次')
    expect(html).toContain('导出检测报告'); expect(html).not.toContain('已连接')
    click(h.render(), '导出检测报告'); await flush()
    expect(service.exportReport).toHaveBeenCalledWith(); expect(renderToStaticMarkup(h.render())).toContain('检测报告已保存')
  })
  it('存在结构与 Node 仍不宣称 Connector 或 Host 完成', async () => {
    const report = empty()
    report.runtime.env_node_resolves = true
    report.errors.push({ scope: 'filesystem', code: 'EPERM' })
    const h = view(api(report)); click(h.render(), '检测 macOS WorkBuddy 环境'); await flush()
    const html = renderToStaticMarkup(h.render())
    expect(html).toContain('WorkBuddy Host 仍待确认'); expect(html).toContain('无需修改权限或系统安全设置')
    expect(html).not.toContain('已连接')
  })
  it('探测运行期间阻止双击与导出，完成后恢复按钮', async () => {
    let finish!: (report: MacWorkBuddyProbeReport) => void
    const service = api(); service.run = vi.fn(() => new Promise<MacWorkBuddyProbeReport>(resolve => { finish = resolve }))
    const h = view(service), tree = h.render()
    click(tree, '检测 macOS WorkBuddy 环境'); click(tree, '检测 macOS WorkBuddy 环境')
    expect(service.run).toHaveBeenCalledOnce()
    expect(elements(h.render()).filter(item => item.type === 'button').every(item => item.props.disabled)).toBe(true)
    finish(empty()); await flush()
    expect(renderToStaticMarkup(h.render())).toContain('导出检测报告')
  })
  it('检测异常不给出原始路径、秘密或红色崩溃错误', async () => {
    const service = api(); service.run = vi.fn(async () => { throw new Error('/Users/秘密用户名 token=私密') })
    const h = view(service); click(h.render(), '检测 macOS WorkBuddy 环境'); await flush()
    const html = renderToStaticMarkup(h.render())
    expect(html).toContain('检测未完成'); expect(html).not.toContain('秘密用户名'); expect(html).not.toContain('私密')
  })
  it('保存取消或失败保留报告并提示可重试', async () => {
    const service = api(); service.exportReport = vi.fn(async () => ({ status: 'cancelled' as const, message: '已取消保存检测报告。' }))
    const h = view(service); click(h.render(), '检测 macOS WorkBuddy 环境'); await flush()
    click(h.render(), '导出检测报告'); await flush(); expect(renderToStaticMarkup(h.render())).toContain('已取消保存检测报告')
    service.exportReport = vi.fn(async () => { throw new Error('私密路径') })
    click(h.render(), '导出检测报告'); await flush()
    expect(renderToStaticMarkup(h.render())).toContain('请重新选择一个本地文件名')
    expect(renderToStaticMarkup(h.render())).not.toContain('私密路径')
  })
})
