import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownExportPanel } from '../src/renderer/src/markdown-export-panel'
import type { MarkdownExportApi, MarkdownExportOutcome, MarkdownExportResult } from '../src/shared/markdown-export'
import type { ObsidianExportApi } from '../src/shared/obsidian-export'
import { ConversationLabelEditor, ConversationLabelProvider } from '../src/renderer/src/conversation-labels'
import type { ConversationLabelApi, ConversationLabelView } from '../src/shared/conversation-labels'

interface Frame { slots: any[]; cursor: number; effects: Array<() => void>; cleanups: Map<number, () => void> }
const hooks = vi.hoisted(() => ({ active: null as Frame | null, context: undefined as any, emptyNames: new Map() }))
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
    },
    useCallback(callback: any, dependencies: readonly unknown[]) {
      if (!hooks.active) return actual.useCallback(callback, dependencies)
      const f = hooks.active, index = f.cursor++, prior = f.slots[index]
      if (!prior || dependencies.some((value, at) => value !== prior.dependencies[at])) f.slots[index] = { callback, dependencies }
      return f.slots[index].callback
    },
    useEffect(effect: () => (() => void) | undefined, dependencies?: readonly unknown[]) {
      if (!hooks.active) return actual.useEffect(effect, dependencies)
      const f = hooks.active, index = f.cursor++, prior = f.slots[index]
      if (!prior || !dependencies || dependencies.some((value, at) => value !== prior.dependencies?.[at])) {
        f.slots[index] = { dependencies }
        f.effects.push(() => { f.cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) f.cleanups.set(index, cleanup); else f.cleanups.delete(index) })
      }
    },
    useContext(context: any) { return hooks.active ? hooks.context ?? { names: hooks.emptyNames } : actual.useContext(context) }
  }
})

describe('Vault 导出复用现有会话与日期选择', () => {
  it('加载已保存 Vault，目录选择和导出共享单个会话选择器，结果完整反馈', async () => {
    const h = setup(true); let tree = h.render()
    button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('D:\\已有Vault')
    tree = openPicker(h)
    expect(elements(tree).filter(element => element.type === 'select')).toHaveLength(1)
    expect(button(tree, '选择会话')['aria-haspopup']).toBe('dialog')
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
const frames: Frame[] = []
beforeEach(() => { vi.stubGlobal('window', new EventTarget()) })
afterEach(() => { for (const f of frames.splice(0)) for (const cleanup of f.cleanups.values()) cleanup(); hooks.active = null; hooks.context = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
function frame(): Frame { const value = { slots: [], cursor: 0, effects: [], cleanups: new Map() } as Frame; frames.push(value); return value }
function renderFrame<T>(state: Frame, action: () => T): T {
  state.cursor = 0; hooks.active = state
  let value: T
  try { value = action() } finally { hooks.active = null }
  for (const effect of state.effects.splice(0)) effect()
  return value
}
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<any>
  return [element, ...elements(element.props.children)]
}
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(element => (element.type === 'button' || element.type === 'input') && (element.props['aria-label'] === label || element.props.children === label || elements(element.props.children).some(child => child.props.children === label)))
  if (!found) throw Error('缺少按钮：' + label)
  return found.props
}
const pick = (tree: ReactNode, name: string, _oldModifier = false) => {
  const checkbox = button(tree, `选择会话 ${name}`)
  checkbox.onChange({ target: { checked: !checkbox.checked } })
}
function openPicker(h: ReturnType<typeof setup>): ReturnType<typeof h.render> {
  let tree = h.render()
  if (!button(tree, '选择会话')['aria-expanded']) { button(tree, '选择会话').onClick(); tree = h.render() }
  return tree
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
  const state = frame()
  const render = () => renderFrame(state, () => MarkdownExportPanel({ api, ...(withVault ? { vaultApi } : {}) }))
  return { api, vaultApi, render, unmount() { for (const cleanup of state.cleanups.values()) cleanup(); state.cleanups.clear() } }
}

describe('PDF 选择与批量反馈', () => {
  it('刷新列表移除原首选会话后，Obsidian 仍只导出界面实际所选会话', async () => {
    const h = setup(true)
    const item = (id: string) => ({ conversationId: id, sourceConversationName: id, userConversationLabel: null, displayConversationName: id, messageCount: 1 })
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([item('甲'), item('乙')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: 'pdf' } }); tree = h.render()
    tree = openPicker(h)
    pick(tree, '乙', true); tree = h.render()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([item('丙'), item('乙')]))
    window.dispatchEvent(new Event('privateradar-conversations-updated')); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('当前已选会话：乙 · 1 条消息')
    tree = openPicker(h)
    expect(elements(tree).find(element => element.props['aria-label'] === '选择会话 乙')!.props.checked).toBe(true)
    expect(button(tree, '导出到 Obsidian').disabled).toBe(false)
    button(tree, '导出到 Obsidian').onClick(); await flush()
    expect(h.vaultApi.start).toHaveBeenCalledExactlyOnceWith({ conversation_ids: ['乙'], range: { type: 'conversation', start_date: null, end_date: null } })
  })
  it('复用原选择器支持 PDF 多选，逐会话输出并展示成功与失败数', async () => {
    const h = setup(true)
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([
      { conversationId: '真实会话编号', sourceConversationName: '来源群', userConversationLabel: '用户标签', displayConversationName: '用户标签', messageCount: 3 },
      { conversationId: '第二会话', sourceConversationName: '另一个来源群', userConversationLabel: null, displayConversationName: '另一个来源群', messageCount: 2 }
    ]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: 'pdf' } }); tree = h.render()
    tree = openPicker(h)
    expect(elements(tree).find(element => element.props['aria-label'] === '选择多个会话')!.props.role).toBe('dialog')
    expect(elements(tree).find(element => element.props['aria-label'] === '选择会话 用户标签')!.props.checked).toBe(true)
    pick(tree, '另一个来源群', true); tree = h.render()
    expect(button(tree, '导出到 Obsidian').disabled).toBe(false)
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    vi.mocked(h.api.start).mockResolvedValueOnce(ok({
      status: 'created', directory: 'D:\\用户输出\\PrivateRadar', messageCount: 5, excludedUnknownTimeCount: 0,
      pdf: { requested: 2, succeeded: 2, created: 2, unchanged: 0, empty: 0, failed: 0, remaining: 0, errors: [] }
    }))
    button(tree, '开始导出').onClick(); await flush(); tree = h.render()
    expect(h.api.start).toHaveBeenCalledExactlyOnceWith({ format: 'pdf', conversation_id: '真实会话编号',
      conversation_ids: ['真实会话编号', '第二会话'], range: { type: 'conversation', start_date: null, end_date: null } })
    const html = renderToStaticMarkup(tree)
    for (const text of ['PDF 导出完成', '成功：2', '失败：0', '未处理：0', 'D:\\用户输出\\PrivateRadar']) expect(html).toContain(text)
    expect(h.vaultApi.start).not.toHaveBeenCalled()
  })
  it('PDF 部分失败返回可见错误，切回 TXT 保留原单会话请求契约', async () => {
    const h = setup(); let tree = h.render()
    button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: 'pdf' } }); tree = h.render()
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    vi.mocked(h.api.start).mockResolvedValueOnce(ok({
      status: 'failed', directory: null, messageCount: 0, excludedUnknownTimeCount: 0,
      pdf: { requested: 1, succeeded: 0, created: 0, unchanged: 0, empty: 0, failed: 1, remaining: 0,
        errors: [{ conversationId: '真实会话编号', code: 'EXPORT_IO_ERROR', message: 'PDF 生成失败，已有文件保留。' }] }
    }))
    button(tree, '开始导出').onClick(); await flush(); tree = h.render()
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('role="alert"'); expect(html).toContain('失败：1')
    expect(html).toContain('用户标签：PDF 生成失败')
    elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: 'txt' } }); tree = h.render()
    tree = openPicker(h)
    const selector = elements(tree).find(element => element.props['aria-label'] === '选择会话')!
    expect(button(tree, '选择会话')['aria-haspopup']).toBe('dialog'); expect(button(tree, '选择会话 用户标签').checked).toBe(true)
    button(tree, '开始导出').onClick(); await flush()
    expect(h.api.start).toHaveBeenLastCalledWith({ format: 'txt', conversation_id: '真实会话编号', range: { type: 'conversation', start_date: null, end_date: null } })
  })
  it('空 PDF 选择禁用开始，不发出重复任务；取消显示已完成和未处理数量', async () => {
    const h = setup(); let tree = h.render()
    button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: 'pdf' } }); tree = h.render()
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    tree = openPicker(h)
    const selector = elements(tree).find(element => element.props['aria-label'] === '选择会话 用户标签')!
    pick(tree, '用户标签', true); tree = h.render()
    expect(button(tree, '开始导出').disabled).toBe(true)
    tree = openPicker(h)
    pick(tree, '用户标签', true); tree = h.render()
    let finish!: (value: MarkdownExportResult<MarkdownExportOutcome>) => void
    vi.mocked(h.api.start).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const start = button(tree, '开始导出').onClick; start(); start(); tree = h.render()
    expect(h.api.start).toHaveBeenCalledOnce()
    button(tree, '取消导出').onClick(); await flush(); expect(h.api.cancel).toHaveBeenCalledOnce()
    finish(ok({ status: 'cancelled', directory: null, messageCount: 0, excludedUnknownTimeCount: 0,
      pdf: { requested: 1, succeeded: 0, created: 0, unchanged: 0, empty: 0, failed: 0, remaining: 1, errors: [] } }))
    await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('PDF 导出已取消')
    expect(renderToStaticMarkup(tree)).toContain('未处理：1')
  })
})

describe('导出选择器与归档分组优化', () => {
  const conversation = (id: string) => ({ conversationId: id, sourceConversationName: id, userConversationLabel: null, displayConversationName: id, messageCount: 1 })
  it('单个会话取消和再次勾选即时更新数量，候选保持展开', async () => {
    const h = setup(); let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = openPicker(h)
    expect(button(tree, '选择会话 用户标签').type).toBe('checkbox')
    expect(button(tree, '选择会话 用户标签').checked).toBe(true)
    pick(tree, '用户标签'); tree = h.render()
    expect(button(tree, '选择会话')['aria-expanded']).toBe(true)
    expect(renderToStaticMarkup(tree)).toContain('已选择 0 个会话')
    pick(tree, '用户标签'); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('已选择 1 个会话')
    expect(button(tree, '选择会话 用户标签').checked).toBe(true)
    expect(h.api.start).not.toHaveBeenCalled()
  })
  it('连续复选保持列表展开，不需要Ctrl，重复勾选去重', async () => {
    const h = setup()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲会话'), conversation('乙会话'), conversation('丙会话')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = openPicker(h)
    for (const name of ['乙会话', '丙会话']) {
      const change = button(tree, '选择会话 ' + name).onChange
      change({ target: { checked: true } }); change({ target: { checked: true } }); tree = h.render()
      expect(button(tree, '选择会话')['aria-expanded']).toBe(true)
    }
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('已选择 3 个会话')
    expect(html).toContain('当前已选会话：甲会话 · 1 条消息；乙会话 · 1 条消息；丙会话 · 1 条消息')
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render(); button(tree, '开始导出').onClick(); await flush()
    expect(h.api.start).toHaveBeenCalledExactlyOnceWith({ conversation_id: '甲会话', conversation_ids: ['甲会话', '乙会话', '丙会话'], range: { type: 'conversation', start_date: null, end_date: null } })
  })
  it('取消勾选后状态在关闭重开和格式切换后保留', async () => {
    const h = setup()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲会话'), conversation('乙会话')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = openPicker(h)
    pick(tree, '乙会话'); tree = h.render()
    button(tree, '选择会话 乙会话').onKeyDown({ key: 'Escape', preventDefault: vi.fn() }); tree = h.render()
    expect(button(tree, '选择会话')['aria-expanded']).toBe(false)
    tree = openPicker(h); expect(button(tree, '选择会话 乙会话').checked).toBe(true)
    pick(tree, '乙会话'); tree = h.render()
    for (const format of ['txt', 'pdf', 'json']) {
      elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: format } }); tree = openPicker(h)
      expect(button(tree, '选择会话 甲会话').checked).toBe(true)
      expect(button(tree, '选择会话 乙会话').checked).toBe(false)
    }
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render(); button(tree, '开始导出').onClick(); await flush()
    expect(h.api.start).toHaveBeenCalledWith({ format: 'json', conversation_id: '甲会话', range: { type: 'conversation', start_date: null, end_date: null } })
  })
  it('两个区域文案明确，普通 PDF 与 Obsidian 使用各自通道且格式互不传递', async () => {
    const h = setup(true); let tree = h.render()
    button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    const html = renderToStaticMarkup(tree)
    for (const text of ['普通文件导出', '将聊天记录导出为 Markdown、JSON、TXT 或 PDF 文件，保存到指定文件夹。', 'Obsidian Vault 归档',
      '将聊天记录整理为 Markdown 笔记，保存到指定的 Obsidian Vault。此功能始终生成 .md 文件，与上方普通文件导出相互独立。']) expect(html).toContain(text)
    expect(elements(tree).find(element => element.props['aria-labelledby'] === 'markdown-export-file-title')).toBeTruthy()
    expect(elements(tree).find(element => element.props['aria-labelledby'] === 'obsidian-vault-title')).toBeTruthy()
    elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: 'pdf' } }); tree = h.render()
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    button(tree, '开始导出').onClick(); await flush(); tree = h.render()
    expect(h.api.start).toHaveBeenCalledExactlyOnceWith({ format: 'pdf', conversation_id: '真实会话编号', conversation_ids: ['真实会话编号'], range: { type: 'conversation', start_date: null, end_date: null } })
    expect(h.vaultApi.start).not.toHaveBeenCalled()
    button(tree, '导出到 Obsidian').onClick(); await flush(); tree = h.render()
    expect(h.vaultApi.start).toHaveBeenCalledExactlyOnceWith({ conversation_ids: ['真实会话编号'], range: { type: 'conversation', start_date: null, end_date: null } })
    expect(h.api.start).toHaveBeenCalledOnce()
    expect(elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.value).toBe('pdf')
  })
})

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
    expect(renderToStaticMarkup(tree)).not.toMatch(/任务中心|模板设置/)
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

describe('最后两项导出界面修正', () => {
  const conversation = (id: string, count = 1) => ({ conversationId: id, sourceConversationName: id, userConversationLabel: null, displayConversationName: id, messageCount: count })
  it('紧凑控件展示复选框和全部名称消息数，普通点击即可连续多选与取消', async () => {
    const h = setup()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲', 3), conversation('乙', 7), conversation('丙', 2)]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    expect(button(tree, '选择会话')['aria-haspopup']).toBe('dialog')
    expect(renderToStaticMarkup(tree)).not.toMatch(/收起会话列表|展开会话列表|刷新会话名称|按住 Ctrl/)
    expect(elements(tree).some(element => element.props.role === 'dialog')).toBe(false)
    tree = openPicker(h); pick(tree, '乙'); tree = h.render(); pick(tree, '丙'); tree = h.render()
    expect(button(tree, '选择会话')['aria-expanded']).toBe(true)
    expect(renderToStaticMarkup(tree)).toContain('已选择 3 个会话')
    expect(renderToStaticMarkup(tree)).toContain('当前已选会话：甲 · 3 条消息；乙 · 7 条消息；丙 · 2 条消息')
    pick(tree, '乙'); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('当前已选会话：甲 · 3 条消息；丙 · 2 条消息')
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render(); button(tree, '开始导出').onClick(); await flush()
    expect(h.api.start).toHaveBeenCalledWith({ conversation_id: '甲', conversation_ids: ['甲', '丙'], range: { type: 'conversation', start_date: null, end_date: null } })
  })
  it('键盘打开与回车勾选保留展开，Escape关闭后重开保留选择', async () => {
    const h = setup()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲'), conversation('乙')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    const preventDefault = vi.fn()
    button(tree, '选择会话').onKeyDown({ key: 'ArrowDown', preventDefault }); tree = h.render()
    button(tree, '选择会话 乙').onKeyDown({ key: 'Enter', preventDefault }); tree = h.render()
    expect(button(tree, '选择会话')['aria-expanded']).toBe(true)
    button(tree, '选择会话 乙').onKeyDown({ key: 'Escape', preventDefault }); tree = h.render()
    expect(button(tree, '选择会话')['aria-expanded']).toBe(false)
    tree = openPicker(h); expect(button(tree, '选择会话 乙').checked).toBe(true)
    expect(renderToStaticMarkup(tree)).toContain('甲 · 1 条消息；乙 · 1 条消息')
    expect(preventDefault).toHaveBeenCalled()
  })
  it('现有Provider成功修改名称后，列表与当前选择立即同步且不依赖人工刷新', async () => {
    const view: ConversationLabelView = { conversationId: '真实会话编号', sourceConversationName: '来源群', userConversationLabel: '用户标签', displayConversationName: '用户标签' }
    const labelApi: ConversationLabelApi = { listConversations: vi.fn(async () => ok([view])), setConversationLabel: vi.fn(async (_id, label) => ok({ ...view, userConversationLabel: label, displayConversationName: label ?? view.sourceConversationName! })) }
    const providerState = frame()
    const renderProvider = () => renderFrame(providerState, () => ConversationLabelProvider({ children: null, api: labelApi }))
    renderProvider(); await flush()
    let provider = renderProvider(); hooks.context = provider.props.value
    const h = setup(); let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    provider.props.value.edit(view); provider = renderProvider()
    const editor = elements(provider).find(element => element.type === ConversationLabelEditor)!
    await editor.props.onSave('即时同步的新名称')
    provider = renderProvider(); hooks.context = provider.props.value; tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('当前已选会话：即时同步的新名称 · 3 条消息')
    tree = openPicker(h)
    expect(button(tree, '选择会话 即时同步的新名称').checked).toBe(true)
    expect(h.api.listConversations).toHaveBeenCalledOnce()
    expect(labelApi.setConversationLabel).toHaveBeenCalledExactlyOnceWith('真实会话编号', '即时同步的新名称')
  })
  it('共享名称仍为旧Map时，新的会话列表名称不会被旧Map盖住', async () => {
    hooks.context = { names: new Map([['真实会话编号', { ...conversation('真实会话编号'), displayConversationName: '共享旧名称' }]]) }
    const h = setup()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([{ ...conversation('真实会话编号', 9), displayConversationName: '列表最新名称' }]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('列表最新名称 · 9 条消息')
    expect(renderToStaticMarkup(tree)).not.toContain('共享旧名称')
  })
  it('旧列表读取期间成功修改名称，新Map优先，旧响应不回退名称', async () => {
    hooks.context = { names: new Map() }
    const h = setup()
    let finish!: (value: Awaited<ReturnType<MarkdownExportApi['listConversations']>>) => void
    vi.mocked(h.api.listConversations).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let tree = h.render(); button(tree, '导出聊天').onClick()
    hooks.context = { names: new Map([['真实会话编号', { ...conversation('真实会话编号'), displayConversationName: '读取期间保存的新名称' }]]) }
    tree = h.render()
    finish(ok([{ ...conversation('真实会话编号', 5), displayConversationName: '读取开始时的旧名称' }]))
    await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('读取期间保存的新名称 · 5 条消息')
    expect(renderToStaticMarkup(tree)).not.toContain('读取开始时的旧名称')
  })
  it('focus与既有会话更新事件自动重读，新响应优先且保留有效选择', async () => {
    const h = setup()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲'), conversation('乙')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    tree = openPicker(h); pick(tree, '乙'); tree = h.render()
    let oldFinish!: (value: Awaited<ReturnType<MarkdownExportApi['listConversations']>>) => void
    vi.mocked(h.api.listConversations).mockImplementationOnce(() => new Promise(resolve => { oldFinish = resolve }))
    window.dispatchEvent(new Event('focus'))
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([{ ...conversation('乙', 8), displayConversationName: '自动更新名称' }]))
    window.dispatchEvent(new Event('privateradar-conversations-updated')); await flush(); tree = h.render()
    oldFinish(ok([conversation('过时列表')])); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('当前已选会话：自动更新名称 · 8 条消息')
    expect(h.api.listConversations).toHaveBeenCalledTimes(3)
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render(); button(tree, '开始导出').onClick(); await flush()
    expect(h.api.start).toHaveBeenCalledWith({ conversation_id: '乙', range: { type: 'conversation', start_date: null, end_date: null } })
  })
  it('导出忙时延后自动重读，结束后保留选择且更新消息数', async () => {
    const h = setup(); let finish!: (value: Awaited<ReturnType<MarkdownExportApi['start']>>) => void
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    vi.mocked(h.api.start).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    button(tree, '开始导出').onClick(); tree = h.render()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([{ ...conversation('真实会话编号', 6), displayConversationName: '导出后名称' }]))
    window.dispatchEvent(new Event('focus')); await flush()
    expect(h.api.listConversations).toHaveBeenCalledOnce()
    finish(ok({ status: 'created', directory: 'D:\\输出', messageCount: 3, excludedUnknownTimeCount: 0 })); await flush(); tree = h.render(); await flush(); tree = h.render()
    expect(h.api.listConversations).toHaveBeenCalledTimes(2)
    expect(renderToStaticMarkup(tree)).toContain('导出后名称 · 6 条消息')
  })
  it('卸载后忽略未完成列表响应，不再读取Vault设置', async () => {
    const h = setup(true)
    let finish!: (value: Awaited<ReturnType<MarkdownExportApi['listConversations']>>) => void
    vi.mocked(h.api.listConversations).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    h.render(); h.unmount(); finish(ok([conversation('不应写入')])); await flush()
    expect(h.vaultApi.settings).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('focus'))
    expect(h.api.listConversations).toHaveBeenCalledOnce()
  })
  it('两个保存位置有独立标题，依次更换目录互不影响且导出通道保留', async () => {
    const h = setup(true); let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = h.render()
    const html = renderToStaticMarkup(tree)
    for (const label of ['普通文件保存位置', 'Obsidian 知识库位置', '将聊天记录导出为 Markdown、JSON、TXT 或 PDF 文件，保存到指定文件夹。', '此功能始终生成 .md 文件，与上方普通文件导出相互独立。']) expect(html).toContain(label)
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    vi.mocked(h.api.chooseDirectory).mockResolvedValueOnce(ok('F:\\普通文件新位置'))
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('F:\\普通文件新位置')
    expect(renderToStaticMarkup(tree)).toContain('D:\\已有Vault')
    expect(h.vaultApi.chooseVault).not.toHaveBeenCalled()
    vi.mocked(h.vaultApi.chooseVault).mockResolvedValueOnce(ok('C:\\Vault新位置'))
    button(tree, '选择 Vault').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('F:\\普通文件新位置')
    expect(renderToStaticMarkup(tree)).toContain('C:\\Vault新位置')
    elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: 'pdf' } }); tree = h.render()
    button(tree, '开始导出').onClick(); await flush(); tree = h.render(); button(tree, '导出到 Obsidian').onClick(); await flush()
    expect(h.api.start).toHaveBeenCalledExactlyOnceWith({ format: 'pdf', conversation_id: '真实会话编号', conversation_ids: ['真实会话编号'], range: { type: 'conversation', start_date: null, end_date: null } })
    expect(h.vaultApi.start).toHaveBeenCalledExactlyOnceWith({ conversation_ids: ['真实会话编号'], range: { type: 'conversation', start_date: null, end_date: null } })
  })
})

describe('统一会话复选集合', () => {
  const conversation = (id: string, count = 1) => ({ conversationId: id, sourceConversationName: id, userConversationLabel: null, displayConversationName: id, messageCount: count })
  it.each(['markdown', 'json', 'txt', 'pdf'] as const)('%s 普通导出与Vault使用相同选择及日期范围，不因格式切换丢失选择', async format => {
    const h = setup(true)
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲'), conversation('乙')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = openPicker(h)
    pick(tree, '乙'); tree = h.render()
    button(tree, '选择会话 乙').onKeyDown({ key: 'Escape', preventDefault: vi.fn() }); tree = h.render()
    elements(tree).find(element => element.props['aria-label'] === '导出格式')!.props.onChange({ target: { value: format } }); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('已选择 2 个会话')
    elements(tree).find(element => element.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); tree = h.render()
    const dates = elements(tree).filter(element => element.props.type === 'date')
    dates[0].props.onChange({ target: { value: '2026-10-01' } }); dates[1].props.onChange({ target: { value: '2026-10-02' } }); tree = h.render()
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render(); button(tree, '开始导出').onClick(); await flush(); tree = h.render()
    const range = { type: 'date_range', start_date: '2026-10-01', end_date: '2026-10-02' }
    expect(h.api.start).toHaveBeenCalledExactlyOnceWith({ ...(format === 'markdown' ? {} : { format }), conversation_id: '甲', conversation_ids: ['甲', '乙'], range })
    button(tree, '导出到 Obsidian').onClick(); await flush()
    expect(h.vaultApi.start).toHaveBeenCalledExactlyOnceWith({ conversation_ids: ['甲', '乙'], range })
  })
  it('超过50个仅提示，不阻止继续选择或两个导出入口', async () => {
    const h = setup(true), ids = Array.from({ length: 52 }, (_, index) => '会话' + index)
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok(ids.map(id => conversation(id))))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = openPicker(h)
    for (const id of ids.slice(1, 50)) { pick(tree, id); tree = h.render() }
    expect(renderToStaticMarkup(tree)).toContain('已选择 50 个会话')
    expect(renderToStaticMarkup(tree)).not.toContain('已选择超过 50 个会话')
    for (const id of ids.slice(50)) { pick(tree, id); tree = h.render() }
    expect(button(tree, '选择会话')['aria-expanded']).toBe(true)
    expect(renderToStaticMarkup(tree)).toContain('已选择 52 个会话')
    expect(renderToStaticMarkup(tree)).toContain('已选择超过 50 个会话，导出可能耗时更长')
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    expect(button(tree, '开始导出').disabled).toBe(false)
    expect(button(tree, '导出到 Obsidian').disabled).toBe(false)
    button(tree, '开始导出').onClick(); await flush(); tree = h.render(); button(tree, '导出到 Obsidian').onClick(); await flush()
    expect(vi.mocked(h.api.start).mock.calls[0][0].conversation_ids).toEqual(ids)
    expect(vi.mocked(h.vaultApi.start).mock.calls[0][0].conversation_ids).toEqual(ids)
  })
  it('点击列表外部关闭后重新打开，勾选状态仍保留', async () => {
    const documentEvents = new EventTarget(); vi.stubGlobal('document', documentEvents)
    const h = setup()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲'), conversation('乙')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = openPicker(h)
    pick(tree, '乙'); tree = h.render()
    const picker = elements(tree).find(element => element.props.className === 'markdown-export-conversation-picker')!
    picker.props.ref.current = { contains: () => false }
    documentEvents.dispatchEvent(new Event('pointerdown')); tree = h.render()
    expect(button(tree, '选择会话')['aria-expanded']).toBe(false)
    tree = openPicker(h)
    expect(button(tree, '选择会话 甲').checked).toBe(true)
    expect(button(tree, '选择会话 乙').checked).toBe(true)
  })
  it('普通多会话结果展示成功、失败和未处理数量，错误保留来源名称', async () => {
    const h = setup()
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲'), conversation('乙')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = openPicker(h)
    pick(tree, '乙'); tree = h.render(); button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    vi.mocked(h.api.start).mockResolvedValueOnce(ok({ status: 'partial', directory: 'D:\\输出', messageCount: 1, excludedUnknownTimeCount: 0,
      batch: { requested: 2, succeeded: 1, created: 1, unchanged: 0, empty: 0, failed: 1, remaining: 0,
        errors: [{ conversationId: '乙', code: 'EXPORT_IO_ERROR', message: '保存失败，原文件保留。' }] } }))
    button(tree, '开始导出').onClick(); await flush(); tree = h.render()
    const html = renderToStaticMarkup(tree)
    for (const text of ['普通文件 导出结束', '成功：1', '失败：1', '未处理：0', '乙：保存失败']) expect(html).toContain(text)
    expect(html).toContain('role="alert"')
  })
  it('Vault部分失败或容量停止明确展示已处理、未处理和安全错误，保留已完成结果', async () => {
    const h = setup(true)
    vi.mocked(h.api.listConversations).mockResolvedValueOnce(ok([conversation('甲'), conversation('乙'), conversation('丙')]))
    let tree = h.render(); button(tree, '导出聊天').onClick(); await flush(); tree = openPicker(h)
    pick(tree, '乙'); tree = h.render(); pick(tree, '丙'); tree = h.render()
    vi.mocked(h.vaultApi.start).mockResolvedValueOnce(ok({ status: 'completed', directory: 'D:\\已有Vault\\PrivateRadar',
      conversationCount: 1, created: 1, updated: 0, skipped: 0, preserved: 0, failed: 1, manifestRecovered: false, userModifiedFilePreserved: false,
      batch: { requested: 3, processed: 2, remaining: 1, errors: [{ conversationId: '乙', code: 'EXPORT_LIMIT_EXCEEDED', message: '本次导出达到安全容量，已完成内容保留。' }] } }))
    button(tree, '导出到 Obsidian').onClick(); await flush(); tree = h.render()
    const html = renderToStaticMarkup(tree)
    for (const value of ['Obsidian 导出结束，部分文件未完成', '新建：1', '失败：1', '已处理：2', '未处理：1', '乙：本次导出达到安全容量，已完成内容保留。']) expect(html).toContain(value)
    expect(html).toContain('role="alert"')
    expect(h.vaultApi.start).toHaveBeenCalledExactlyOnceWith({ conversation_ids: ['甲', '乙', '丙'], range: { type: 'conversation', start_date: null, end_date: null } })
    expect(h.api.start).not.toHaveBeenCalled()
  })
})
