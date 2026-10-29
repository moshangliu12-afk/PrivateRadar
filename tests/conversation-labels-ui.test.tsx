import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationName, ConversationLabelEditor, ConversationLabelProvider } from '../src/renderer/src/conversation-labels'
import type { ConversationLabelApi, ConversationLabelView, ConversationNameInput } from '../src/shared/conversation-labels'
import { DatabaseSync } from 'node:sqlite'
import { initializeDatabase } from '../src/main/schema'
import { listConversations, setConversationLabel } from '../src/main/conversation-labels'

interface Frame { slots: any[]; cursor: number; effects: Array<() => void | (() => void)>; context?: { names: Map<string, ConversationLabelView>; edit: (value: ConversationNameInput) => void } }
const hooks = vi.hoisted(() => ({ active: null as Frame | null }))
const electron = vi.hoisted(() => ({ invoke: vi.fn(), exposeInMainWorld: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: { invoke: electron.invoke } }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual,
    useContext<T>(context: import('react').Context<T>): T { return hooks.active?.context ? hooks.active.context as T : actual.useContext(context) },
    useState(initial: unknown) {
      if (!hooks.active) return actual.useState(initial)
      const f = hooks.active, at = f.cursor++
      if (!(at in f.slots)) f.slots[at] = typeof initial === 'function' ? initial() : initial
      return [f.slots[at], (next: any) => { f.slots[at] = typeof next === 'function' ? next(f.slots[at]) : next }]
    },
    useRef(initial: unknown) {
      if (!hooks.active) return actual.useRef(initial)
      const f = hooks.active, at = f.cursor++
      if (!(at in f.slots)) f.slots[at] = { current: initial }
      return f.slots[at]
    },
    useCallback<T extends (...args: any[]) => any>(callback: T, dependencies: unknown[]) { return hooks.active ? callback : actual.useCallback(callback, dependencies) },
    useEffect(effect: () => void | (() => void), dependencies: unknown[]) { if (hooks.active) hooks.active.effects.push(effect); else actual.useEffect(effect, dependencies) }
  }
})
afterEach(() => { hooks.active = null; vi.unstubAllGlobals(); vi.restoreAllMocks() })
function host() {
  const frame: Frame = { slots: [], cursor: 0, effects: [] }
  return { frame, render<T>(component: (props: T) => React.JSX.Element, props: T) {
    frame.cursor = 0; frame.effects = []; hooks.active = frame
    try { return component(props) } finally { hooks.active = null }
  } }
}
function elements(node: ReactNode): Array<ReactElement<any>> {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<any>
  return [element, ...elements(element.props.children)]
}
async function flush() { for (let n = 0; n < 6; n++) await Promise.resolve() }
const view: ConversationLabelView = { conversationId: '会话一', sourceConversationName: '微信群123', userConversationLabel: 'PrivateRadar 项目组', displayConversationName: 'PrivateRadar 项目组' }

describe('会话名称编辑与全局展示', () => {
  it('未知会话仍有铅笔、明确修改提示和可点击的编辑入口', () => {
    const h = host(), edit = vi.fn(), value = { conversationId: '未知来源会话', sourceConversationName: null, userConversationLabel: null }
    h.frame.context = { names: new Map(), edit }
    const tree = h.render(ConversationName, { value }), button = elements(tree).find(element => element.type === 'button')!
    expect(button.props.title).toBe('修改会话名称')
    expect(button.props['aria-label']).toBe('修改会话名称：未知会话')
    expect(button.props['aria-haspopup']).toBe('dialog')
    const icon = elements(button).find(element => element.type === 'svg')!
    expect(icon.props.className).toBe('conversation-name-edit-icon')
    expect(icon.props['aria-hidden']).toBe('true')
    expect(renderToStaticMarkup(tree)).toContain('未知会话<svg')
    button.props.onClick()
    expect(edit).toHaveBeenCalledExactlyOnceWith(value)
  })
  it('Evidence 显示用户名称，并明确保留来源说明；内容自动转义', () => {
    const html = renderToStaticMarkup(createElement(ConversationName, { value: { ...view, userConversationLabel: '<项目组>' }, evidence: true }))
    expect(html).toContain('&lt;项目组&gt;'); expect(html).toContain('用户自定义名称；来源：'); expect(html).toContain('微信群123')
  })
  it('编辑入口包含保存、清空、取消及来源说明', () => {
    const html = renderToStaticMarkup(createElement(ConversationLabelEditor, { view, onSave: vi.fn(async () => {}), onClose: vi.fn() }))
    for (const text of ['修改会话显示名称', '微信群123', '自定义会话名称', '清空自定义名称', '未知会话', 'aria-modal="true"']) expect(html).toContain(text)
  })
  it('Evidence 当前来源名与历史原始记录不同时，两者保持可见和可区分', () => {
    const html = renderToStaticMarkup(createElement(ConversationName, { value: { ...view, conversationName: '历史附件原始群名' }, evidence: true }))
    expect(html).toContain('PrivateRadar 项目组'); expect(html).toContain('微信群123'); expect(html).toContain('原始记录会话名称：'); expect(html).toContain('历史附件原始群名')
  })
  it('用户输入和空白保存分别提交规范名称及 null，双击保存不重复请求', async () => {
    let finish!: () => void
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve })), h = host()
    const props = { view, onSave: save, onClose: vi.fn() }
    let tree = h.render(ConversationLabelEditor, props)
    elements(tree).find(e => e.type === 'input')!.props.onChange({ target: { value: '  新项目名  ' } })
    tree = h.render(ConversationLabelEditor, props)
    const submit = elements(tree).find(e => e.type === 'form')!.props.onSubmit
    submit({ preventDefault: vi.fn() }); submit({ preventDefault: vi.fn() })
    expect(save).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledWith('新项目名'); finish(); await flush()
    tree = h.render(ConversationLabelEditor, props)
    elements(tree).find(e => e.type === 'input')!.props.onChange({ target: { value: '   ' } })
    tree = h.render(ConversationLabelEditor, props); elements(tree).find(e => e.type === 'form')!.props.onSubmit({ preventDefault: vi.fn() })
    expect(save).toHaveBeenLastCalledWith(null); finish(); await flush()
  })
  it('清空按钮提交 null，失败保留编辑内容并显示错误', async () => {
    const save = vi.fn(async () => { throw new Error('会话已不存在，请刷新后重试。') }), h = host(), props = { view, onSave: save, onClose: vi.fn() }
    const tree = h.render(ConversationLabelEditor, props)
    elements(tree).find(e => e.type === 'button' && e.props.children === '清空自定义名称')!.props.onClick()
    await flush(); expect(save).toHaveBeenCalledWith(null)
    const next = h.render(ConversationLabelEditor, props)
    expect(elements(next).find(e => e.props.role === 'alert')!.props.children).toBe('会话已不存在，请刷新后重试。')
    expect(elements(next).find(e => e.type === 'input')!.props.value).toBe('PrivateRadar 项目组')
  })
  it('取消和 Escape 关闭不保存', () => {
    const h = host(), close = vi.fn(), save = vi.fn(async () => {}), tree = h.render(ConversationLabelEditor, { view, onSave: save, onClose: close })
    elements(tree).find(e => e.type === 'button' && e.props.children === '取消')!.props.onClick()
    elements(tree).find(e => e.props.role === 'dialog')!.props.onKeyDown({ key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled()
  })
  it('全局 Provider 的真实保存结果同步现有卡片，清空恢复来源而无需重启', async () => {
    const db = new DatabaseSync(':memory:'); initializeDatabase(db)
    db.prepare("INSERT INTO conversations(id,platform,name,created_at) VALUES('会话一','wechat','微信群123','2026-10-28')").run()
    const api: ConversationLabelApi = { listConversations: async () => ({ ok: true, value: listConversations(db) }), setConversationLabel: async (id, label) => ({ ok: true, value: setConversationLabel(db, id, label) }) }
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const h = host(), props = { api, children: createElement(ConversationName, { value: { conversationId: '会话一', conversationName: '历史来源名' }, evidence: true }) }
    try {
      let tree = h.render(ConversationLabelProvider, props); const cleanup = h.frame.effects[0](); await flush()
      tree = h.render(ConversationLabelProvider, props)
      tree.props.value.edit({ conversationId: '会话一' })
      tree = h.render(ConversationLabelProvider, props)
      await elements(tree).find(e => e.type === ConversationLabelEditor)!.props.onSave('项目显示名')
      tree = h.render(ConversationLabelProvider, props)
      expect(renderToStaticMarkup(tree)).toMatch(/>项目显示名<svg/)
      expect(renderToStaticMarkup(tree)).toContain('原始记录会话名称：历史来源名')
      tree.props.value.edit({ conversationId: '会话一' }); tree = h.render(ConversationLabelProvider, props)
      await elements(tree).find(e => e.type === ConversationLabelEditor)!.props.onSave(null)
      tree = h.render(ConversationLabelProvider, props)
      expect(renderToStaticMarkup(tree)).toContain('微信群123'); expect(renderToStaticMarkup(tree)).not.toContain('项目显示名')
      expect(db.prepare('SELECT name,user_conversation_label FROM conversations').get()).toEqual({ name: '微信群123', user_conversation_label: null })
      if (typeof cleanup === 'function') cleanup()
    } finally { db.close() }
  })
  it('preload 只转发会话编号和用户标签，未新增数据库连接', async () => {
    await import('../src/preload/index')
    const api = electron.exposeInMainWorld.mock.calls[0][1].conversationLabels as ConversationLabelApi
    await api.listConversations(); await api.setConversationLabel('会话一', '项目'); await api.setConversationLabel('会话一', null)
    expect(electron.invoke.mock.calls).toEqual([['conversation-labels:list'], ['conversation-labels:set', '会话一', '项目'], ['conversation-labels:set', '会话一', null]])
  })
})
