import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownExportPanel } from '../src/renderer/src/markdown-export-panel'
import type { MarkdownExportApi, MarkdownExportOutcome, MarkdownExportResult } from '../src/shared/markdown-export'
import type { ObsidianExportApi } from '../src/shared/obsidian-export'

interface Frame { slots: any[]; cursor: number }
const hooks = vi.hoisted(() => ({ active: null as Frame | null }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useState(initial: unknown) {
      if (!hooks.active) return actual.useState(initial)
      const f = hooks.active, index = f.cursor++
      if (!(index in f.slots)) f.slots[index] = typeof initial === 'function' ? initial() : initial
      return [f.slots[index], (value: any) => { f.slots[index] = typeof value === 'function' ? value(f.slots[index]) : value }]
    },
    useRef(initial: unknown) {
      if (!hooks.active) return actual.useRef(initial)
      const f = hooks.active, index = f.cursor++
      if (!(index in f.slots)) f.slots[index] = { current: initial }
      return f.slots[index]
    }
  }
})

describe('Vault 导出复用现有会话与日期选择', () => {
  it('加载已保存 Vault，目录选择和导出共享单个会话选择器，结果完整反馈', async () => {
    const h = setup(true); let tree = h.render()
    button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('D:\\已有Vault')
    expect(elements(tree).filter(element => element.type === 'select')).toHaveLength(2)
    expect(button(tree, '导出到 Obsidian').disabled).toBe(false)
    expect(button(tree, '开始导出').disabled).toBe(true)
    button(tree, '选择 Vault').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('D:\\新Vault')
    button(tree, '导出到 Obsidian').onClick(); await flush(); tree = h.render()
    expect(h.vaultApi.start).toHaveBeenCalledExactlyOnceWith({ conversation_ids: ['真实会话编号'], range: { type: 'conversation', start_date: null, end_date: null } })
    expect(h.api.start).not.toHaveBeenCalled()
    const html = renderToStaticMarkup(tree)
    for (const label of ['Obsidian 导出完成', '新建：', '更新：', '未变化：', '保留用户修改：', '失败：', '已保留用户修改']) expect(html).toContain(label)
    button(tree, '打开 Vault 导出目录').onClick(); await flush(); expect(h.vaultApi.openOutput).toHaveBeenCalledOnce()
  })
  it('目录取消保留设置；日期范围条件传给 Vault，错误明确显示', async () => {
    const h = setup(true); let tree = h.render()
    button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    vi.mocked(h.vaultApi.chooseVault).mockResolvedValueOnce(ok(null))
    button(tree, '选择 Vault').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('D:\\已有Vault')
    expect(renderToStaticMarkup(tree)).toContain('已取消选择 Vault')
    elements(tree).find(element => element.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); tree = h.render()
    expect(button(tree, '导出到 Obsidian').disabled).toBe(true)
    const dates = elements(tree).filter(element => element.props.type === 'date')
    dates[0].props.onChange({ target: { value: '2026-10-01' } }); dates[1].props.onChange({ target: { value: '2026-10-02' } }); tree = h.render()
    vi.mocked(h.vaultApi.start).mockResolvedValueOnce({ ok: false, error: { code: 'EXPORT_PATH_UNSAFE', message: 'Obsidian Vault 不可用，请重新选择目录。' } })
    button(tree, '导出到 Obsidian').onClick(); await flush(); tree = h.render()
    expect(h.vaultApi.start).toHaveBeenCalledWith({ conversation_ids: ['真实会话编号'], range: { type: 'date_range', start_date: '2026-10-01', end_date: '2026-10-02' } })
    expect(renderToStaticMarkup(tree)).toContain('role="alert"')
    expect(renderToStaticMarkup(tree)).toContain('Vault 不可用')
  })
  it('Vault 任务防止重复点击，取消走正确通道，普通导出不被调用', async () => {
    const h = setup(true)
    let finish!: (value: Awaited<ReturnType<ObsidianExportApi['start']>>) => void
    vi.mocked(h.vaultApi.start).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    const start = button(tree, '导出到 Obsidian').onClick
    start(); start(); tree = h.render()
    expect(h.vaultApi.start).toHaveBeenCalledOnce()
    button(tree, '取消导出').onClick(); await flush()
    expect(h.vaultApi.cancel).toHaveBeenCalledOnce(); expect(h.api.cancel).not.toHaveBeenCalled()
    finish(ok({ status: 'cancelled', directory: 'D:\\已有Vault\\PrivateRadar', conversationCount: 0, created: 0, updated: 0, skipped: 0, preserved: 0, failed: 0, manifestRecovered: false, userModifiedFilePreserved: false }))
    await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('Obsidian 导出已取消')
  })
})
afterEach(() => { hooks.active = null; vi.restoreAllMocks() })
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<any>
  return [element, ...elements(element.props.children)]
}
function button(tree: ReactNode, label: string) {
  return elements(tree).find(element => element.type === 'button' && (element.props.children === label || elements(element.props.children).some(child => child.props.children === label)))!.props
}
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve() }
const ok = <T,>(value: T): MarkdownExportResult<T> => ({ ok: true, value })
function setup(withVault = false) {
  const api: MarkdownExportApi = { listConversations: vi.fn(async () => ok([{ conversationId: '真实会话编号', sourceConversationName: '来源群', userConversationLabel: '用户标签', displayConversationName: '用户标签', messageCount: 3 }])),
    chooseDirectory: vi.fn(async () => ok<string | null>('D:\\用户输出')), start: vi.fn(async () => ok<MarkdownExportOutcome>({ status: 'created', directory: 'D:\\用户输出\\PrivateRadar\\结果', messageCount: 3, excludedUnknownTimeCount: 0 })), cancel: vi.fn(async () => ok(null)), openOutput: vi.fn(async () => ok(null)) }
  const vaultApi: ObsidianExportApi = {
    settings: vi.fn(async () => ok({ path: 'D:\\已有Vault', supported: true })),
    chooseVault: vi.fn(async () => ok('D:\\新Vault')),
    start: vi.fn(async () => ok({ status: 'completed' as const, directory: 'D:\\新Vault\\PrivateRadar', conversationCount: 1, created: 2, updated: 1, skipped: 3, preserved: 1, failed: 0, manifestRecovered: false, userModifiedFilePreserved: true })),
    cancel: vi.fn(async () => ok(null)), openOutput: vi.fn(async () => ok(null))
  }
  const frame: Frame = { slots: [], cursor: 0 }
  const render = () => { frame.cursor = 0; hooks.active = frame; try { return MarkdownExportPanel({ api, ...(withVault ? { vaultApi } : {}) }) } finally { hooks.active = null } }
  return { api, vaultApi, render }
}
describe('轻量聊天导出界面', () => {
  it('明确入口、单会话选择、目录选择和成功输出；不引入复杂页面或任务中心', async () => {
    const h = setup(); let tree = h.render()
    button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('用户标签 · 3 条消息')
    expect(button(tree, '开始导出').disabled).toBe(true)
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    expect(button(tree, '开始导出').disabled).toBe(false)
    button(tree, '开始导出').onClick(); await flush(); tree = h.render()
    expect(h.api.start).toHaveBeenCalledWith({ conversation_id: '真实会话编号', range: { type: 'conversation', start_date: null, end_date: null } })
    expect(renderToStaticMarkup(tree)).toContain('导出成功，共 3 条消息')
    button(tree, '打开导出目录').onClick(); await flush(); expect(h.api.openOutput).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(tree)).not.toMatch(/PDF|任务中心|模板设置/)
  })
  it('取消目录选择不执行导出，失败保留选择并明确提示，重复点击不会并发提交', async () => {
    const h = setup(); let tree = h.render()
    button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    vi.mocked(h.api.chooseDirectory).mockResolvedValueOnce(ok(null))
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('已取消选择目录')
    expect(h.api.start).not.toHaveBeenCalled()
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    vi.mocked(h.api.start).mockResolvedValueOnce({ ok: false, error: { code: 'EXPORT_IO_ERROR', message: '磁盘空间不足，已有文件未覆盖。' } })
    const start = button(tree, '开始导出').onClick; start(); start(); await flush(); tree = h.render()
    expect(h.api.start).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(tree)).toContain('role="alert"')
    expect(renderToStaticMarkup(tree)).toContain('磁盘空间不足')
    expect(renderToStaticMarkup(tree)).toContain('D:\\用户输出')
  })
  it('运行中可请求取消，完成后显示取消结果', async () => {
    const h = setup(); let finish!: (result: MarkdownExportResult<MarkdownExportOutcome>) => void
    vi.mocked(h.api.start).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render(); button(tree, '开始导出').onClick(); tree = h.render()
    button(tree, '取消导出').onClick(); await flush(); expect(h.api.cancel).toHaveBeenCalledOnce()
    finish(ok({ status: 'cancelled', directory: null, messageCount: 0, excludedUnknownTimeCount: 0 })); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('导出已取消，未覆盖已有文件')
  })
  it('日期范围复用已有选择语义，缺失或倒序日期禁用提交', async () => {
    const h = setup(); let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    elements(tree).find(element => element.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); tree = h.render()
    expect(button(tree, '开始导出').disabled).toBe(true)
    const dates = elements(tree).filter(element => element.props.type === 'date')
    dates[0].props.onChange({ target: { value: '2026-10-01' } }); dates[1].props.onChange({ target: { value: '2026-10-02' } }); tree = h.render()
    button(tree, '开始导出').onClick(); await flush()
    expect(h.api.start).toHaveBeenCalledWith({ conversation_id: '真实会话编号', range: { type: 'date_range', start_date: '2026-10-01', end_date: '2026-10-02' } })
  })
  it.each(['json', 'txt'] as const)('格式选择明确、默认 Markdown，选择 %s 后沿用现有开始与目录流程', async format => {
    const h = setup(); let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    const selector = elements(tree).find(element => element.type === 'select' && element.props['aria-label'] === '导出格式')!
    expect(selector.props.value).toBe('markdown')
    const html = renderToStaticMarkup(tree)
    for (const name of ['Markdown', 'JSON', 'TXT', '适合 Obsidian']) expect(html).toContain(name)
    selector.props.onChange({ target: { value: format } }); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain(format === 'json' ? '适合备份、脚本、AI 和程序处理' : '适合普通文本阅读与复制')
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    button(tree, '开始导出').onClick(); await flush()
    expect(h.api.start).toHaveBeenCalledWith({ format, conversation_id: '真实会话编号', range: { type: 'conversation', start_date: null, end_date: null } })
  })
})
