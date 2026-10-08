import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeywordHitContext, KeywordRadarDesktopApi, KeywordRadarResult } from '../src/shared/keyword-radar'
import type { TodayKeywordInterest, TodayKeywordInterestItem } from '../src/shared/today-keyword-interest'
import { TodayKeywordInterestCard, TodayKeywordInterestContent, TodayKeywordInterestSection } from '../src/renderer/src/today-keyword-interest-section'
import type { TodayKeywordInterestState } from '../src/renderer/src/today-keyword-interest-section'
import { App, MissingImportantFeedback } from '../src/renderer/src/App'
import { KeywordRadarPage } from '../src/renderer/src/keyword-radar-page'
import { getTodayKeywordInterest } from '../src/main/intelligence/daily/keyword-interest'
import { getKeywordHitContext, safeKeywordRadarAction } from '../src/main/keyword-radar/desktop'
import { openKeywordHitEvidence } from '../src/main/keyword-radar/evidence-navigation'
import { cleanupRadarFixtures } from './keyword-radar-fixture'
import { interestFixture, todayClock, interestDatabaseFingerprint, interestEvidence, interestEvidenceFingerprint } from './today-keyword-interest-fixture'

interface HookFrame {
  slots: unknown[]; cursor: number; tasks: Array<() => void>
  effects: Map<number, { dependencies: unknown[]; cleanup?: () => void }>
}
const hooks = vi.hoisted(() => ({ active: null as HookFrame | null }))
// 沿用既有钩子宿主方式，执行真实组件、按钮和异步请求；不安装额外浏览器依赖。
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual,
    useState(initial: unknown) {
      if (!hooks.active) return actual.useState(initial)
      const frame = hooks.active, position = frame.cursor++
      if (!(position in frame.slots)) frame.slots[position] = typeof initial === 'function' ? initial() : initial
      return [frame.slots[position], (next: unknown) => {
        frame.slots[position] = typeof next === 'function' ? next(frame.slots[position]) : next
      }]
    },
    useRef(initial: unknown) {
      if (!hooks.active) return actual.useRef(initial)
      const frame = hooks.active, position = frame.cursor++
      if (!(position in frame.slots)) frame.slots[position] = { current: initial }
      return frame.slots[position]
    },
    useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
      if (!hooks.active) return actual.useEffect(effect, dependencies)
      const frame = hooks.active, position = frame.cursor++, old = frame.effects.get(position)
      if (!old || dependencies.some((value, index) => !Object.is(value, old.dependencies[index]))) {
        frame.tasks.push(() => {
          old?.cleanup?.()
          const cleanup = effect()
          frame.effects.set(position, { dependencies, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
        })
      }
    }
  }
})
function host() {
  const frame: HookFrame = { slots: [], cursor: 0, tasks: [], effects: new Map() }
  return {
    render<T>(component: (props: T) => React.JSX.Element, props: T) {
      frame.cursor = 0; frame.tasks = []; hooks.active = frame
      try { return component(props) } finally { hooks.active = null }
    },
    effects() { for (const task of frame.tasks.splice(0)) task() },
    dispose() { for (const entry of frame.effects.values()) entry.cleanup?.() }
  }
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(element => element.type === 'button' &&
    (element.props.children === label || elements(element.props.children as ReactNode).some(child => child.type === 'span' && child.props.children === label)))
  if (!found) throw new Error('未找到按钮：' + label)
  return found.props as { disabled?: boolean; onClick: () => void }
}
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve() }
const html = (tree: ReactNode) => renderToStaticMarkup(tree)
const ok = <T>(value: T): KeywordRadarResult<T> => ({ ok: true, value })
const failure = { ok: false as const, error: { code: 'OPERATION_FAILED', message: '私有错误' } }
const item: TodayKeywordInterestItem = {
  batchItemId: '附件乙', sourcePosition: 5, messageId: '共享规范消息', body: '原始消息 <b>不改写</b>',
  senderName: '来源发言人', chatTimestamp: '2026-10-08T01:00:00Z', timestampSource: 'source_native', conversationName: '来源会话',
  representativeHitId: '稳定代表命中', matchedTerms: ['Codex', '消息'],
  matches: [{ hitId: '稳定代表命中', groupId: '原始组编号', termId: '原始词编号', term: 'Codex' }],
  source: { batchItemId: '附件乙', attachmentName: '乙卡片.zip', ordinal: 1, evidenceKind: 'zip', evidenceStatus: 'available', evidenceRecorded: true }
}
const data: TodayKeywordInterest = { todayDate: '2026-10-08', items: [item] }
function keywordApi() {
  return {
    getHitContext: vi.fn(async id => ok<KeywordHitContext>({ hitId: id, batchItemId: item.batchItemId, entries: [{ ...item, isCurrent: true }] })),
    openHitEvidence: vi.fn(async () => ok({ batchItemId: item.batchItemId, opened: true as const })),
    listRecentHits: vi.fn(), retryFailedRuns: vi.fn(), listGroups: vi.fn()
  } as unknown as KeywordRadarDesktopApi
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanupRadarFixtures() })

describe('独立区块与原文卡片', () => {
  it.each([
    { status: 'loading' }, { status: 'error' },
    { status: 'empty', value: { todayDate: data.todayDate, items: [] } }, { status: 'ready', value: data }
  ] as TodayKeywordInterestState[])('明确区分 $status，错误不冒充空结果，日期来自独立查询', state => {
    const text = html(createElement(TodayKeywordInterestContent, { state, api: keywordApi(), onRefresh: vi.fn(), onViewAll: vi.fn() }))
    expect(text).toContain('你关注的关键词今天有新消息')
    if (state.status === 'loading') expect(text).toContain('正在读取关注词新消息')
    if (state.status === 'error') {
      expect(text).toContain('role="alert"'); expect(text).toContain('重新加载'); expect(text).not.toContain('暂无关注词')
    }
    if ('value' in state) expect(text).toContain('今天 / 2026-10-08')
    if (state.status === 'ready') {
      expect(text).toContain('&lt;b&gt;不改写&lt;/b&gt;')
      for (const value of ['来源发言人', '来源会话', '乙卡片.zip', '命中你关注的关键词：Codex、消息', '查看上下文', '查看证据']) expect(text).toContain(value)
      expect(text).not.toMatch(/发现时间|原始组编号|高优先级|为什么值得关注|<h3/)
    }
  })
  it.each(['missing', 'corrupt', 'error'] as const)('Evidence %s 卡片仍显示，正文不丢失', evidenceStatus => {
    const text = html(createElement(TodayKeywordInterestCard, { item: { ...item, source: { ...item.source, evidenceStatus } }, api: keywordApi() }))
    expect(text).toContain('证据暂不可用'); expect(text).toContain('原始消息'); expect(text).toContain('查看上下文')
  })
  it('Context / Evidence 使用代表 Hit，快速重复点击只请求一次，失败保留原文', async () => {
    const api = keywordApi(), view = host(), render = () => view.render(TodayKeywordInterestCard, { item, api })
    render(); view.effects()
    const context = button(render(), '查看上下文'); context.onClick(); context.onClick(); await settle()
    expect(api.getHitContext).toHaveBeenCalledExactlyOnceWith(item.representativeHitId)
    expect(html(render())).toContain('当前命中')
    vi.mocked(api.openHitEvidence).mockResolvedValueOnce(failure)
    const evidence = button(render(), '查看证据'); evidence.onClick(); evidence.onClick(); await settle()
    expect(api.openHitEvidence).toHaveBeenCalledExactlyOnceWith(item.representativeHitId)
    expect(html(render())).toContain('证据暂不可用'); expect(html(render())).toContain('原始消息')
    expect(api.listRecentHits).not.toHaveBeenCalled(); expect(api.retryFailedRuns).not.toHaveBeenCalled()
    view.dispose()
  })
})

describe('独立读取、刷新与导航行为', () => {
  it('IPC 错误独立显示、重新加载成功，不读取旧摘要或启动处理', async () => {
    const api = { getTodayKeywordInterest: vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(ok(data)) }
    const view = host(), props = { api, keywordApi: keywordApi(), onViewAll: vi.fn() }
    const render = () => view.render(TodayKeywordInterestSection, props)
    render(); view.effects(); await settle()
    expect(html(render())).toContain('关注词新消息暂时无法读取')
    const content = render().props as Parameters<typeof TodayKeywordInterestContent>[0]
    button(TodayKeywordInterestContent(content), '重新加载').onClick()
    render(); view.effects(); await settle()
    expect(html(render())).toContain('原始消息')
    expect(api.getTodayKeywordInterest).toHaveBeenCalledTimes(2)
    view.dispose()
  })
  it('进入或刷新重新读取；迟到旧请求与卸载后的结果不会覆盖新结果', async () => {
    let late!: (result: KeywordRadarResult<TodayKeywordInterest>) => void
    const api = { getTodayKeywordInterest: vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
      .mockResolvedValueOnce(ok(data)) }
    const view = host(), props = { api, keywordApi: keywordApi(), onViewAll: vi.fn(), refreshRevision: 0 }
    view.render(TodayKeywordInterestSection, props); view.effects()
    props.refreshRevision++
    view.render(TodayKeywordInterestSection, props); view.effects(); await settle()
    late(failure); await settle()
    expect(html(view.render(TodayKeywordInterestSection, props))).toContain('原始消息')
    expect(api.getTodayKeywordInterest).toHaveBeenCalledTimes(2)
    let after!: (result: KeywordRadarResult<TodayKeywordInterest>) => void
    api.getTodayKeywordInterest.mockImplementationOnce(() => new Promise(resolve => { after = resolve }))
    props.refreshRevision++
    view.render(TodayKeywordInterestSection, props); view.effects(); view.dispose()
    after(ok(data)); await settle()
    expect(html(view.render(TodayKeywordInterestSection, props))).toContain('正在读取关注词新消息')
  })
  it('旧 Today 重要项为空或摘要读取失败仍挂载独立 section；查看全部使用现有 keywords routing', async () => {
    const root = {
      getDashboardSummary: vi.fn(async () => ({
        date: '2026-10-07', items: [], demoMode: false, messageCount: 1, conversationCount: 1,
        totalMessageCount: 1, candidateCount: 0, finalIntelligenceCount: 0, telemetry: null, mode: 'rule'
      })),
      getFirstUseStatus: vi.fn(async () => ({ firstLaunch: false, latestImport: null, dataStatus: { latestMessageDate: '2026-10-07' } })),
      getTodayKeywordInterest: vi.fn(async () => ok(data)), keywordRadar: keywordApi()
    }
    vi.stubGlobal('window', { privateRadar: root, setInterval: vi.fn(() => 1), clearInterval: vi.fn() })
    const view = host(), render = () => view.render(App, {})
    render(); view.effects(); await settle()
    expect(html(render())).toContain('今天没有值得关注的情报')
    const section = elements(render()).find(element => element.type === TodayKeywordInterestSection)!
    expect(section).toBeDefined()
    expect(html(render())).toContain('class="highlights highlights-empty"')
    const order = elements(render())
    expect(order.findIndex(element => element.props.className === 'highlights highlights-empty'))
      .toBeLessThan(order.findIndex(element => element.type === TodayKeywordInterestSection))
    expect(order.findIndex(element => element.type === TodayKeywordInterestSection))
      .toBeLessThan(order.findIndex(element => element.type === MissingImportantFeedback))
    const child = host(), props = { ...section.props, api: root, keywordApi: root.keywordRadar, onViewAll: section.props.onViewAll as () => void }
    child.render(TodayKeywordInterestSection, props); child.effects(); await settle()
    const text = html(child.render(TodayKeywordInterestSection, props))
    expect(text).toContain('今天 / 2026-10-08'); expect(text).toContain('原始消息')
    button(render(), '今日情报').onClick(); await settle()
    const nextSection = elements(render()).find(element => element.type === TodayKeywordInterestSection)!
    expect(nextSection.props.refreshRevision).toBe(1)
    vi.mocked(root.getDashboardSummary).mockRejectedValueOnce(new Error('旧摘要暂不可用'))
    button(render(), '今日情报').onClick(); await settle()
    expect(html(render())).toContain('旧摘要暂不可用')
    expect(elements(render()).some(element => element.type === TodayKeywordInterestSection)).toBe(true)
    const content = child.render(TodayKeywordInterestSection, props).props as Parameters<typeof TodayKeywordInterestContent>[0]
    button(TodayKeywordInterestContent(content), '查看全部').onClick()
    expect(elements(render()).some(element => element.type === KeywordRadarPage)).toBe(true)
    expect(elements(render()).some(element => element.type === TodayKeywordInterestSection)).toBe(false)
    expect(root.getDashboardSummary).toHaveBeenCalledTimes(3)
    child.dispose(); view.dispose()
  })
  it('真实重要项保留既有卡片结构，空态紧凑样式不应用于非空重要项', async () => {
    const root = {
      getDashboardSummary: vi.fn(async () => ({
        date: '2026-10-08', demoMode: false, messageCount: 1, conversationCount: 1,
        totalMessageCount: 1, candidateCount: 1, finalIntelligenceCount: 1, telemetry: null, mode: 'rule',
        items: [{ candidateId: '真实重要项', title: '重要情报原有标题', summary: '重要情报原有摘要',
          whyItMatters: '重要情报原有依据', category: '产品 / 技术', importanceLevel: 'high',
          reasonCodes: [], conversationCount: 1, messageCount: 1, firstSeenAt: '2026-10-08T01:00:00Z' }]
      })),
      getFirstUseStatus: vi.fn(async () => ({ firstLaunch: false, latestImport: null, dataStatus: { latestMessageDate: '2026-10-08' } })),
      getTodayKeywordInterest: vi.fn(async () => ok(data)), keywordRadar: keywordApi()
    }
    vi.stubGlobal('window', { privateRadar: root, setInterval: vi.fn(() => 1), clearInterval: vi.fn() })
    const view = host(), render = () => view.render(App, {})
    render(); view.effects(); await settle()
    const tree = render(), text = html(tree), order = elements(tree)
    expect(text).toContain('class="highlights"')
    expect(text).not.toContain('highlights-empty')
    expect(text).not.toContain('daily-important-empty-heading')
    for (const preserved of ['candidate-wrap', 'class="rank">01', 'card-copy', 'candidate-heading',
      '重要情报原有标题', '重要情报原有摘要', '重要情报原有依据', 'candidate-actions', '查看依据']) expect(text).toContain(preserved)
    expect(order.findIndex(element => element.props.className === 'highlights'))
      .toBeLessThan(order.findIndex(element => element.type === TodayKeywordInterestSection))
    expect(order.findIndex(element => element.type === TodayKeywordInterestSection))
      .toBeLessThan(order.findIndex(element => element.type === MissingImportantFeedback))
    view.dispose()
  })
  it('移动后的遗漏反馈仍支持选择、取消和通过原 IPC 保存日期与说明', async () => {
    const save = vi.fn(async () => undefined)
    vi.stubGlobal('window', { privateRadar: { saveMissingImportantFeedback: save } })
    const view = host(), render = () => view.render(MissingImportantFeedback, { dateKey: '2026-10-08' })
    button(render(), '没有').onClick()
    expect(save).not.toHaveBeenCalled()
    button(render(), '有').onClick()
    expect(html(render())).toContain('遗漏重要内容说明')
    button(render(), '取消').onClick()
    expect(html(render())).not.toContain('遗漏重要内容说明')
    button(render(), '有').onClick()
    const input = elements(render()).find(element => element.type === 'input')!
    ;(input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '隔离反馈说明' } })
    button(render(), '记录反馈').onClick(); await settle()
    expect(save).toHaveBeenCalledExactlyOnceWith({ dateKey: '2026-10-08', note: '隔离反馈说明' })
    expect(html(render())).toContain('感谢反馈')
    view.dispose()
  })
  it('实际临时 DB 的 section打开、刷新、Context、Evidence、查看全部全链零写入', async () => {
    const f = interestFixture(); await interestEvidence(f, 0)
    const before = interestDatabaseFingerprint(f), evidence = interestEvidenceFingerprint(f), open = vi.fn(async () => '')
    const api = { getTodayKeywordInterest: vi.fn(async () => ok(getTodayKeywordInterest(f.db, todayClock()))) }
    const keyword = {
      getHitContext: (id: string) => safeKeywordRadarAction(() => getKeywordHitContext(f.db, id)),
      openHitEvidence: (id: string) => safeKeywordRadarAction(() => openKeywordHitEvidence(f.db, f.path, id, open))
    } as KeywordRadarDesktopApi
    const page = host(), onViewAll = vi.fn(), props = { api, keywordApi: keyword, onViewAll }
    page.render(TodayKeywordInterestSection, props); page.effects(); await settle()
    let content = page.render(TodayKeywordInterestSection, props).props as Parameters<typeof TodayKeywordInterestContent>[0]
    button(TodayKeywordInterestContent(content), '刷新').onClick()
    page.render(TodayKeywordInterestSection, props); page.effects(); await settle()
    content = page.render(TodayKeywordInterestSection, props).props as Parameters<typeof TodayKeywordInterestContent>[0]
    expect(content.state.status).toBe('ready')
    const row = (content.state as { value: TodayKeywordInterest }).value.items[0]
    const card = host(), renderCard = () => card.render(TodayKeywordInterestCard, { item: row, api: keyword })
    renderCard(); card.effects()
    button(renderCard(), '查看上下文').onClick(); await settle()
    button(renderCard(), '查看证据').onClick()
    // 证据校验包含文件异步读取，等待真实导航完成。
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1), { timeout: 10000 })
    button(TodayKeywordInterestContent(content), '查看全部').onClick()
    expect(onViewAll).toHaveBeenCalledTimes(1)
    expect(api.getTodayKeywordInterest).toHaveBeenCalledTimes(2)
    expect(interestDatabaseFingerprint(f)).toEqual(before)
    expect(interestEvidenceFingerprint(f)).toEqual(evidence)
    card.dispose(); page.dispose()
  }, 15000)
})
