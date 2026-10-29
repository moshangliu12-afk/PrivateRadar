import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { AddContextButton, ContextHandoffEntry, ContextHandoffPanel, ContextHandoffProvider } from '../src/renderer/src/context-handoff'
import type { ContextHandoffApi, ContextPreview } from '../src/shared/context-handoff'
import type { MarkdownExportOutcome, MarkdownExportResult } from '../src/shared/markdown-export'

interface Frame { slots: any[]; cursor: number; cleanup: (() => void)[] }
const hooks = vi.hoisted(() => ({ active: null as Frame | null, context: undefined as any }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useState(initial: unknown) {
      if (!hooks.active) return actual.useState(initial)
      const frame = hooks.active, index = frame.cursor++
      if (!(index in frame.slots)) frame.slots[index] = typeof initial === 'function' ? initial() : initial
      return [frame.slots[index], (value: any) => { frame.slots[index] = typeof value === 'function' ? value(frame.slots[index]) : value }]
    },
    useRef(initial: unknown) {
      if (!hooks.active) return actual.useRef(initial)
      const frame = hooks.active, index = frame.cursor++
      if (!(index in frame.slots)) frame.slots[index] = { current: initial }
      return frame.slots[index]
    },
    useEffect(effect: () => (() => void) | undefined) {
      if (!hooks.active) return actual.useEffect(effect)
      const frame = hooks.active, index = frame.cursor++
      if (!(index in frame.slots)) { frame.slots[index] = true; const cleanup = effect(); if (cleanup) frame.cleanup.push(cleanup) }
    },
    useContext(context: any) { return hooks.context === undefined ? actual.useContext(context) : hooks.context }
  }
})
afterEach(() => { hooks.active = null; hooks.context = undefined; vi.restoreAllMocks() })
const ok = <T,>(value: T): MarkdownExportResult<T> => ({ ok: true, value })
function frame() { return { slots: [], cursor: 0, cleanup: [] } as Frame }
function render<T>(state: Frame, action: () => T): T { state.cursor = 0; hooks.active = state; try { return action() } finally { hooks.active = null } }
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<any>
  return [element, ...elements(element.props.children)]
}
function button(tree: ReactNode, label: string) {
  const item = elements(tree).find(element => element.type === 'button' && (element.props.children === label || element.props['aria-label'] === label))
  if (!item) throw new Error('缺少按钮：' + label)
  return item.props
}
async function flush() { for (let index = 0; index < 14; index++) await Promise.resolve() }
function api(): ContextHandoffApi {
  return { preview: vi.fn(async () => ok(preview())), copyMarkdown: vi.fn(async () => ok(null)), chooseDirectory: vi.fn(async () => ok<string | null>('D:\\上下文输出')),
    export: vi.fn(async () => ok<MarkdownExportOutcome>({ status: 'created', directory: 'D:\\上下文输出\\PrivateRadar\\上下文', messageCount: 1, excludedUnknownTimeCount: 0 })),
    cancel: vi.fn(async () => ok(null)), openOutput: vi.fn(async () => ok(null)) }
}
function preview(large = false): ContextPreview {
  return { snapshot: { schema_version: 1, generated_at: '2026-10-29T12:00:00.000Z', timezone: 'Asia/Shanghai',
    items: [{ type: 'message', id: '消息一', conversationId: '会话一', displayConversationName: '用户标签', sourceConversationName: '真实来源群', userConversationLabel: '用户标签', platform: 'wechat',
      sender: '张三', timestamp: '2026-10-18T04:08:00.000Z', localDate: '2026-10-18', localTime: '12:08:00', content: '完整正文😀\n下一行', evidenceIds: ['证据一'],
      provenance: { canonicalOrigin: { source_batch_id: '导入一', source_position: 0 }, senderSource: 'source_native', timestampSource: 'source_native', contentSource: 'source_native', sourceMessageId: '来源消息', occurrences: [] } }],
    evidence: [{ type: 'evidence', id: '证据一', kind: 'zip', status: 'available', snapshotSha256: null, sourceMessageIds: ['消息一'], occurrences: [] }],
    statistics: { message_count: 1, evidence_count: 1, character_count: large ? 20001 : 12, large_context: large } },
    markdown: '# 交接\n用户标签\n真实来源群\n张三\n完整正文😀\n```js\nconst x = "<script>"\n```\n' }
}
function setup(initial = ['消息一']) {
  let ids = initial, revision = 0
  const state = frame(), supplied = api()
  const remove = vi.fn((id: string) => { ids = ids.filter(value => value !== id); revision++ })
  const clear = vi.fn(() => { ids = []; revision++ })
  return { api: supplied, remove, clear, change(next: string[]) { ids = next; revision++ }, unmount() { state.cleanup.forEach(action => action()) },
    render: () => render(state, () => ContextHandoffPanel({ api: supplied, ids, getRevision: () => revision, onRemove: remove, onClear: clear })) }
}
async function loadPreview(h: ReturnType<typeof setup>) { button(h.render(), '生成预览').onClick(); await flush(); return h.render() }

describe('AI 上下文临时选择与页面入口', () => {
  it('单会话与Search跨入口按消息编号去重，入口显示选择数量', () => {
    const supplied = api(), state = frame()
    const provider = () => render(state, () => ContextHandoffProvider({ api: supplied, children: createElement('span') })) as ReactElement<any>
    let tree = provider(); hooks.context = tree.props.value
    button(AddContextButton({ messageId: '同一消息' }), '加入 AI 上下文').onClick()
    tree = provider(); hooks.context = tree.props.value
    expect(button(AddContextButton({ messageId: '同一消息' }), '已加入 AI 上下文').disabled).toBe(true)
    tree.props.value.add('同一消息'); tree.props.value.add('另一会话消息')
    tree = provider(); hooks.context = tree.props.value
    expect(tree.props.value.ids).toEqual(['同一消息', '另一会话消息'])
    expect(renderToStaticMarkup(ContextHandoffEntry()!)).toContain('AI 上下文（2）')
    expect(supplied.preview).not.toHaveBeenCalled()
  })
  it('200条上限明确拒绝继续加入，不删除或总结已选正文', () => {
    const state = frame(), supplied = api()
    const provider = () => render(state, () => ContextHandoffProvider({ api: supplied, children: createElement('span') })) as ReactElement<any>
    let tree = provider()
    for (let index = 0; index < 201; index++) tree.props.value.add('消息' + index)
    tree = provider()
    expect(tree.props.value.ids).toHaveLength(200)
    expect(renderToStaticMarkup(tree)).toContain('每次最多选择 200 条消息')
  })
  it('提供器缺席时轻量按钮与入口安全隐藏，旧页面不增加行为', () => {
    hooks.context = null
    expect(AddContextButton({ messageId: '消息' })).toBeNull()
    expect(ContextHandoffEntry()).toBeNull()
  })
  it('搜索两类结果、单会话前后文与Evidence原始消息均有按编号加入入口', () => {
    const source = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(source.match(/<AddContextButton messageId=\{result\.messageId\}/g)).toHaveLength(2)
    expect(source.match(/<AddContextButton messageId=\{message\.messageId\}/g)).toHaveLength(2)
    expect(source).toContain('<AddContextButton messageId={item.messageId}')
    expect(source).toContain('<ContextHandoffEntry />')
  })
})

describe('AI 上下文托盘与预览', () => {
  it('单条移除与清空使预览失效，不修改来源数据', async () => {
    const h = setup(['消息一', '消息二']); let tree = await loadPreview(h)
    button(tree, '移除消息 消息一').onClick(); tree = h.render()
    expect(h.remove).toHaveBeenCalledExactlyOnceWith('消息一')
    expect(renderToStaticMarkup(tree)).not.toContain('Markdown 预览')
    expect(button(tree, '复制 Markdown').disabled).toBe(true)
    button(tree, '清空全部').onClick(); tree = h.render()
    expect(h.clear).toHaveBeenCalledOnce()
    expect(button(tree, '生成预览').disabled).toBe(true)
  })
  it('预览请求仅传真实编号，名称与发送人来自主进程快照；正文按纯文本展示', async () => {
    const h = setup(), tree = await loadPreview(h)
    expect(h.api.preview).toHaveBeenCalledExactlyOnceWith({ message_ids: ['消息一'] })
    const html = renderToStaticMarkup(tree)
    for (const text of ['用户标签', '真实来源群', '张三', '完整正文😀', '下一行', '&lt;script&gt;']) expect(html).toContain(text)
    expect(html).not.toContain('<script>')
  })
  it('显示关联Evidence与字符数量，长上下文明确警告且完整保留内容', async () => {
    const h = setup(); vi.mocked(h.api.preview).mockResolvedValueOnce(ok(preview(true)))
    const html = renderToStaticMarkup(await loadPreview(h))
    expect(html).toContain('1 条关联证据')
    expect(html).toContain((20001).toLocaleString())
    expect(html).toContain('当前上下文较长')
    expect(html).toContain('所有已选内容均完整保留')
    expect(html).toContain('完整正文😀')
  })
  it('一键复制Markdown走本地专用API并给出成功反馈', async () => {
    const h = setup(); let tree = await loadPreview(h)
    button(tree, '复制 Markdown').onClick(); await flush(); tree = h.render()
    expect(h.api.copyMarkdown).toHaveBeenCalledExactlyOnceWith({ message_ids: ['消息一'] })
    expect(renderToStaticMarkup(tree)).toContain('已复制 AI 上下文')
  })
  it('剪贴板失败明确显示错误，未预览时不允许复制或导出', async () => {
    const h = setup()
    expect(button(h.render(), '复制 Markdown').disabled).toBe(true)
    expect(button(h.render(), '导出 JSON').disabled).toBe(true)
    let tree = await loadPreview(h)
    vi.mocked(h.api.copyMarkdown).mockResolvedValueOnce({ ok: false, error: { code: 'EXPORT_IO_ERROR', message: '系统剪贴板不可用' } })
    button(tree, '复制 Markdown').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('系统剪贴板不可用')
    expect(renderToStaticMarkup(tree)).not.toContain('已复制 AI 上下文')
  })
  it.each(['markdown', 'json'] as const)('复用目录选择后导出%s，展示位置并可打开输出', async format => {
    const h = setup(); let tree = await loadPreview(h)
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    button(tree, format === 'markdown' ? '导出 Markdown' : '导出 JSON').onClick(); await flush(); tree = h.render()
    expect(h.api.export).toHaveBeenCalledExactlyOnceWith({ message_ids: ['消息一'] }, format)
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('AI 上下文导出成功')
    expect(html).toContain('D:\\上下文输出\\PrivateRadar\\上下文')
    button(tree, '打开导出目录').onClick(); await flush()
    expect(h.api.openOutput).toHaveBeenCalledOnce()
  })
  it('目录选择取消保留现有位置，相同文件反馈已有完整导出', async () => {
    const h = setup(); let tree = await loadPreview(h)
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    vi.mocked(h.api.chooseDirectory).mockResolvedValueOnce(ok(null))
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('已取消选择输出目录')
    expect(renderToStaticMarkup(tree)).toContain('D:\\上下文输出')
    vi.mocked(h.api.export).mockResolvedValueOnce(ok({ status: 'unchanged', directory: 'D:\\已有结果', messageCount: 1, excludedUnknownTimeCount: 0 }))
    button(tree, '导出 Markdown').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('已有相同且完整的上下文')
  })
  it('导出取消与错误明确反馈，重复点击不会开启第二次任务', async () => {
    const h = setup(); let tree = await loadPreview(h)
    button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
    let finish!: (result: MarkdownExportResult<MarkdownExportOutcome>) => void
    vi.mocked(h.api.export).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const start = button(tree, '导出 Markdown').onClick; start(); start(); tree = h.render()
    expect(h.api.export).toHaveBeenCalledOnce()
    button(tree, '取消导出').onClick(); await flush()
    expect(h.api.cancel).toHaveBeenCalledOnce()
    finish(ok({ status: 'cancelled', directory: null, messageCount: 0, excludedUnknownTimeCount: 0 })); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('导出已取消，已有文件已保留')
    vi.mocked(h.api.export).mockRejectedValueOnce(new Error('目标目录不可写'))
    button(tree, '导出 JSON').onClick(); await flush(); tree = h.render()
    expect(renderToStaticMarkup(tree)).toContain('目标目录不可写')
  })
  it('加入或移除消息后，延迟返回的旧预览不能覆盖当前选择', async () => {
    const h = setup(); let finish!: (result: MarkdownExportResult<ContextPreview>) => void
    vi.mocked(h.api.preview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    button(h.render(), '生成预览').onClick()
    h.change(['消息二']); h.render()
    finish(ok(preview())); await flush()
    const tree = h.render()
    expect(renderToStaticMarkup(tree)).not.toContain('Markdown 预览')
    expect(button(tree, '复制 Markdown').disabled).toBe(true)
    expect(renderToStaticMarkup(tree)).toContain('已选消息 1')
  })
  it.each(['copy', 'export'])('新增消息后旧%s成功反馈和旧预览立即失效', async operation => {
    const h = setup(); let tree = await loadPreview(h)
    if (operation === 'copy') {
      button(tree, '复制 Markdown').onClick(); await flush(); tree = h.render()
      expect(renderToStaticMarkup(tree)).toContain('已复制 AI 上下文')
    } else {
      button(tree, '选择输出目录').onClick(); await flush(); tree = h.render()
      button(tree, '导出 Markdown').onClick(); await flush(); tree = h.render()
      expect(renderToStaticMarkup(tree)).toContain('AI 上下文导出成功')
    }
    h.change(['消息一', '消息二']); tree = h.render()
    const html = renderToStaticMarkup(tree)
    expect(html).not.toContain('已复制 AI 上下文')
    expect(html).not.toContain('AI 上下文导出成功')
    expect(html).not.toContain('Markdown 预览')
    expect(html).not.toContain('打开导出目录')
    expect(button(tree, '复制 Markdown').disabled).toBe(true)
    expect(html).toContain('生成预览后可查看所选消息的来源与正文')
  })
  it('清空进行中的预览使旧响应失效，退出托盘不再更新状态', async () => {
    const h = setup(); let finish!: (result: MarkdownExportResult<ContextPreview>) => void
    vi.mocked(h.api.preview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let tree = h.render(); button(tree, '生成预览').onClick(); tree = h.render()
    button(tree, '清空全部').onClick(); h.unmount(); finish(ok(preview())); await flush()
    expect(h.clear).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(h.render())).not.toContain('完整正文😀')
  })
})
