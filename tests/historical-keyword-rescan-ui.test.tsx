import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoricalKeywordScan } from '../src/renderer/src/historical-keyword-scan'
import { KeywordHitCard, KeywordContext } from '../src/renderer/src/keyword-radar-page'
import type { HistoricalRescanApi, HistoricalRescanState } from '../src/shared/historical-keyword-rescan'
import type { KeywordHitView, KeywordRadarDesktopApi } from '../src/shared/keyword-radar'

interface Frame { slots: any[]; cursor: number; effects: Array<() => void | (() => void)> }
const hooks = vi.hoisted(() => ({ active: null as Frame | null }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual,
    useState(initial: unknown) {
      if (!hooks.active) return actual.useState(initial)
      const f = hooks.active, n = f.cursor++
      if (!(n in f.slots)) f.slots[n] = typeof initial === 'function' ? initial() : initial
      return [f.slots[n], (next: any) => { f.slots[n] = typeof next === 'function' ? next(f.slots[n]) : next }]
    },
    useRef(initial: unknown) {
      if (!hooks.active) return actual.useRef(initial)
      const f = hooks.active, n = f.cursor++
      if (!(n in f.slots)) f.slots[n] = { current: initial }
      return f.slots[n]
    },
    useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
      if (hooks.active) hooks.active.effects.push(effect); else actual.useEffect(effect, dependencies)
    }
  }
})
afterEach(() => { hooks.active = null; vi.useRealTimers(); vi.restoreAllMocks() })
function host() {
  const frame: Frame = { slots: [], cursor: 0, effects: [] }
  return { frame, render(props: Parameters<typeof HistoricalKeywordScan>[0]) {
    frame.cursor = 0; frame.effects = []; hooks.active = frame
    try { return HistoricalKeywordScan(props) } finally { hooks.active = null }
  } }
}
function elements(node: ReactNode): Array<ReactElement<any>> {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<any>
  return [element, ...elements(element.props.children)]
}
const state: HistoricalRescanState = { id: '任务', groupId: '规则', status: 'running', scannedMessages: 0, totalMessages: 300,
  matchedHits: 0, newHits: 0, existingHits: 0, removedHits: 0, startedAt: '2026-10-29', finishedAt: null, error: null }
const ok = <T,>(value: T) => ({ ok: true as const, value })
function api() {
  return { start: vi.fn(async () => ok(state)), status: vi.fn(async () => ok<HistoricalRescanState | null>(null)), cancel: vi.fn(async () => ok(null)) } satisfies HistoricalRescanApi
}
async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve() }

describe('历史扫描桌面交互', () => {
  it('进入界面只查询状态，不启动扫描；停用组不能点击扫描', async () => {
    const h = host(), client = api(), props = { api: client, groupId: '规则', enabled: true, onComplete: vi.fn(async () => {}) }
    const tree = h.render(props)
    const cleanup = h.frame.effects[0](); await flush()
    expect(client.status).toHaveBeenCalledExactlyOnceWith('规则'); expect(client.start).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(tree)).toContain('扫描历史聊天')
    expect(elements(h.render({ ...props, enabled: false })).find(element => element.type === 'button')!.props.disabled).toBe(true)
    if (typeof cleanup === 'function') cleanup()
  })
  it('点击后准备态防双击，扫描展示进度和取消，完成后仅刷新一次', async () => {
    vi.useFakeTimers()
    const h = host(), client = api(), completed = vi.fn(async () => {}), props = { api: client, groupId: '规则', enabled: true, onComplete: completed }
    let release!: (value: ReturnType<typeof ok<HistoricalRescanState>>) => void
    client.start.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = elements(h.render(props)).find(element => element.type === 'button')!
    first.props.onClick(); first.props.onClick()
    expect(client.start).toHaveBeenCalledTimes(1)
    expect(renderToStaticMarkup(h.render(props))).toContain('准备扫描')
    release(ok(state)); await flush()
    client.status.mockResolvedValueOnce(ok({ ...state, scannedMessages: 128, matchedHits: 12, newHits: 10, existingHits: 2 }))
    h.render(props); const cleanup = h.frame.effects[0](); await flush()
    const progress = h.render(props), html = renderToStaticMarkup(progress)
    expect(html).toContain('已扫描 128 / 300 条消息'); expect(html).toContain('value="128"')
    expect(html).toContain('命中 12 处'); expect(html).toContain('新增 10'); expect(html).toContain('已有 2')
    elements(progress).find(element => element.type === 'button' && element.props.children === '取消扫描')!.props.onClick(); await flush()
    expect(client.cancel).toHaveBeenCalledExactlyOnceWith('任务')
    client.status.mockResolvedValue(ok({ ...state, status: 'complete', scannedMessages: 300, matchedHits: 20, newHits: 12, existingHits: 8, removedHits: 3 }))
    await vi.advanceTimersByTimeAsync(250)
    expect(renderToStaticMarkup(h.render(props))).toContain('历史扫描完成')
    expect(renderToStaticMarkup(h.render(props))).toContain('移除失效 3')
    expect(completed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000); expect(completed).toHaveBeenCalledTimes(1)
    if (typeof cleanup === 'function') cleanup()
  })
  it('后台拒绝并发时显示明确错误并恢复按钮', async () => {
    const h = host(), client = api(), props = { api: client, groupId: '规则', enabled: true, onComplete: vi.fn(async () => {}) }
    client.start.mockResolvedValueOnce({ ok: false, error: { code: 'RESCAN_BUSY', message: '已有历史扫描正在运行，请等待结束。' } } as any)
    elements(h.render(props)).find(element => element.type === 'button')!.props.onClick(); await flush()
    const tree = h.render(props)
    expect(renderToStaticMarkup(tree)).toContain('已有历史扫描正在运行')
    expect(elements(tree).find(element => element.type === 'button')!.props.disabled).toBe(false)
  })
  it('规则变化停止与取消结果可见，再次扫描入口仍可用；卸载取消轮询', async () => {
    vi.useFakeTimers()
    const h = host(), client = api(), props = { api: client, groupId: '规则', enabled: true, onComplete: vi.fn(async () => {}) }
    client.status.mockResolvedValue(ok({ ...state, status: 'failed', scannedMessages: 128, error: '规则已发生变化，请重新扫描。' }))
    h.render(props); const cleanup = h.frame.effects[0](); await flush()
    const tree = h.render(props)
    expect(renderToStaticMarkup(tree)).toContain('规则已发生变化'); expect(elements(tree).find(e => e.type === 'button')!.props.disabled).toBe(false)
    if (typeof cleanup === 'function') cleanup()
    const running = host(); client.status.mockResolvedValue(ok(state)); running.render(props)
    const stop = running.frame.effects[0](); await flush(); const calls = client.status.mock.calls.length
    if (typeof stop === 'function') stop()
    await vi.advanceTimersByTimeAsync(1000); expect(client.status).toHaveBeenCalledTimes(calls)
  })
  it('无附件旧命中展示原文和自定义名，明确禁用不存在的 Evidence', () => {
    const hit: KeywordHitView = { id: '命中', groupId: '规则', groupName: '工具', matchedTerms: ['Codex'], matchedAt: '2026-10-29',
      batchItemId: null, sourcePosition: null, messageId: '原文', body: 'Codex 原始正文', senderName: '原发送人', chatTimestamp: null, timestampSource: 'unknown',
      conversationId: '会话', conversationName: '来源名称', sourceConversationName: '来源名称', userConversationLabel: '我的项目', displayConversationName: '我的项目',
      source: { batchItemId: null, attachmentName: null, ordinal: null, evidenceKind: null, evidenceStatus: 'missing', evidenceRecorded: false } }
    const html = renderToStaticMarkup(createElement(KeywordHitCard, { hit, api: {} as KeywordRadarDesktopApi }))
    for (const text of ['我的项目', 'Codex 原始正文', '未绑定附件', '查看上下文', '聊天时间未知']) expect(html).toContain(text)
    expect(html).toContain('<button type="button" disabled="">查看证据</button>')
    expect(html).not.toContain('附件 #')
    const context = renderToStaticMarkup(createElement(KeywordContext, { context: { hitId: hit.id, batchItemId: null, entries: [{ ...hit, isCurrent: true }] } }))
    expect(context).toContain('原始消息上下文'); expect(context).not.toContain('来源位置 null')
  })
})
