import { sharedCoreItems, ingestSharedCore, sharedRows, drainSharedDerived } from './shared-core-fixture'
import { sharedJsonFixture, importSharedJson, sharedEvidenceBytes } from './shared-json-evidence-fixture'
import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommitmentCandidateContext, CommitmentCandidateReview, CommitmentCandidateView, CommitmentDesktopApi, CommitmentResult } from '../src/shared/commitment'
import type { SearchHistoryApi, SearchHistoryResult } from '../src/shared/search-history'
import { useSearchHistory } from '../src/renderer/src/search-history'
import { ConfirmedCommitmentCard, ConfirmedCommitmentsContent, ConfirmedCommitmentsPage, selectConfirmedCommitments } from '../src/renderer/src/confirmed-commitments-page'
import { CommitmentCandidatesContent, CommitmentCandidatesPage } from '../src/renderer/src/commitment-candidates-page'
import { App } from '../src/renderer/src/App'
import { registerCommitmentCandidateIpc, confirmCommitmentCandidate, ignoreCommitmentCandidate, listCommitmentCandidates } from '../src/main/commitment/desktop'
import { openCommitmentCandidateEvidence } from '../src/main/commitment/evidence-navigation'
import * as matcher from '../src/main/commitment/matcher'
import * as processor from '../src/main/commitment/processor'
import { reviewFixture, reviewDatabaseFingerprint, saveReviewEvidence } from './commitment-review-fixture'
import { cleanupRadarFixtures, ingestRadarItem } from './keyword-radar-fixture'
import { commitmentMessages } from './commitment-processing-fixture'

interface EffectSlot { dependencies?: readonly unknown[]; cleanup?: () => void }
interface HookFrame {
  slots: unknown[]; cursor: number; effects: Array<() => void>
  effectSlots: Map<number, EffectSlot>; stateUpdates: number
}
const hooks = vi.hoisted(() => ({ active: null as HookFrame | null }))
const mountedHosts = new Set<() => void>()
// 沿用既有行为测试方式，仅替换钩子宿主；按钮处理函数和静态渲染使用产品组件。
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual,
    useState(initial: unknown) {
      if (!hooks.active) return actual.useState(initial)
      const frame = hooks.active, position = frame.cursor++
      if (!(position in frame.slots)) frame.slots[position] = typeof initial === 'function' ? initial() : initial
      return [frame.slots[position], (next: unknown) => {
        frame.stateUpdates++
        frame.slots[position] = typeof next === 'function' ? next(frame.slots[position]) : next
      }]
    },
    useRef(initial: unknown) {
      if (!hooks.active) return actual.useRef(initial)
      const frame = hooks.active, position = frame.cursor++
      if (!(position in frame.slots)) frame.slots[position] = { current: initial }
      return frame.slots[position]
    },
    useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
      if (!hooks.active) return actual.useEffect(effect, dependencies)
      const frame = hooks.active, position = frame.cursor++, previous = frame.effectSlots.get(position)
      if (previous && dependencies && previous.dependencies?.length === dependencies.length &&
        dependencies.every((value, at) => Object.is(value, previous.dependencies![at]))) return
      const current: EffectSlot = { dependencies: dependencies ? [...dependencies] : undefined }
      frame.effectSlots.set(position, current)
      frame.effects.push(() => {
        previous?.cleanup?.()
        if (previous) previous.cleanup = undefined
        const cleanup = effect()
        if (typeof cleanup === 'function') current.cleanup = cleanup
      })
    }
  }
})
afterEach(() => {
  for (const unmount of mountedHosts) unmount()
  hooks.active = null
  vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanupRadarFixtures()
})
const candidate: CommitmentCandidateView = {
  id: '候选乙', status: 'confirmed', reviewedAt: '2035-01-02T01:00:00Z', batchItemId: '附件乙', sourcePosition: 5, messageId: '共享规范消息',
  body: '这个问题我来处理', senderName: '来源乙发言人', chatTimestamp: '2026-10-07T02:20:00Z', timestampSource: 'source_native', conversationName: '乙会话',
  ruleId: 'self_take_action', reasonCode: 'explicit_self_take_action', ruleVersion: 'commitment-v1',
  source: { batchItemId: '附件乙', attachmentName: '乙卡片.zip', ordinal: 1, evidenceKind: 'zip', evidenceStatus: 'available', evidenceRecorded: true }
}
const ok = <T>(value: T): CommitmentResult<T> => ({ ok: true, value })
const historyOk = (value: string[]): SearchHistoryResult<string[]> => ({ ok: true, value })
function makeApi(): CommitmentDesktopApi {
  return {
    listCommitmentCandidates: vi.fn(async () => ok([candidate])),
    confirmCommitmentCandidate: vi.fn(async id => ok<CommitmentCandidateReview>({ id, status: 'confirmed', reviewedAt: candidate.reviewedAt })),
    ignoreCommitmentCandidate: vi.fn(async id => ok<CommitmentCandidateReview>({ id, status: 'ignored', reviewedAt: candidate.reviewedAt })),
    getCommitmentCandidateContext: vi.fn(async id => ok<CommitmentCandidateContext>({ candidateId: id, batchItemId: candidate.batchItemId, entries: [{ ...candidate, isCurrent: true }] })),
    openCommitmentCandidateEvidence: vi.fn(async () => ok({ batchItemId: candidate.batchItemId, opened: true as const }))
  }
}
function host() {
  const frame: HookFrame = { slots: [], cursor: 0, effects: [], effectSlots: new Map(), stateUpdates: 0 }
  let unmounted = false
  const unmount = () => {
    if (unmounted) return
    unmounted = true
    for (const effect of frame.effectSlots.values()) { effect.cleanup?.(); effect.cleanup = undefined }
    frame.effects = []
    mountedHosts.delete(unmount)
  }
  mountedHosts.add(unmount)
  return { frame, unmount, render<T, R>(component: (props: T) => R, props: T): R {
    if (unmounted) throw new Error('不能重新渲染已卸载的测试宿主')
    frame.cursor = 0; hooks.active = frame
    let result: R
    try { result = component(props) } finally { hooks.active = null }
    for (const effect of frame.effects.splice(0)) effect()
    return result
  } }
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(element => element.type === 'button' && (element.props.children === label || elements(element.props.children as ReactNode).some(child => child.type === 'span' && child.props.children === label)))
  if (!found) throw new Error('未找到按钮：' + label)
  return found.props as { disabled?: boolean; onClick: () => void; 'aria-current'?: string }
}
async function settle() { for (let count = 0; count < 12; count++) await Promise.resolve() }
const html = (tree: ReactNode) => renderToStaticMarkup(tree)
const renderCard = (patch: Partial<CommitmentCandidateView> = {}) => html(createElement(ConfirmedCommitmentCard, { candidate: { ...candidate, ...patch }, api: makeApi() }))

describe('承诺表达的只读选择与卡片', () => {
  it('只展示已确认项，按真实确认时间倒序，同时间稳定且不改变输入，不合并共享规范消息', () => {
    const rows = [
      { ...candidate, id: '候选03', reviewedAt: '2035-01-01T01:00:00Z' },
      { ...candidate, id: '待审核原话', status: 'pending' as const, reviewedAt: null },
      { ...candidate, id: '候选01' }, { ...candidate, id: '候选02' },
      { ...candidate, id: '已忽略原话', status: 'ignored' as const }
    ]
    const snapshot = structuredClone(rows)
    expect(selectConfirmedCommitments(rows).candidates.map(row => row.id)).toEqual(['候选01', '候选02', '候选03'])
    expect(selectConfirmedCommitments([...rows].reverse()).candidates.map(row => row.id)).toEqual(['候选01', '候选02', '候选03'])
    expect(rows).toEqual(snapshot)
    const rendered = html(createElement(ConfirmedCommitmentsContent, { candidates: rows, api: makeApi() }))
    expect(rendered).not.toContain('待审核原话'); expect(rendered).not.toContain('已忽略原话')
    expect(rendered.match(/data-candidate-id=/g)).toHaveLength(3)
  })
  it.each([null, '', '不是确认时间', '2035-02-30T01:00:00Z'])('确认时间无效 %s 保守提示，不补时间、不显示正常空结果', reviewedAt => {
    const rows = [{ ...candidate, reviewedAt }]
    expect(selectConfirmedCommitments(rows)).toEqual({ candidates: [], unavailableCount: 1 })
    const rendered = html(createElement(ConfirmedCommitmentsContent, { candidates: rows, api: makeApi() }))
    expect(rendered).toContain('role="alert"'); expect(rendered).toContain('缺少有效确认时间')
    expect(rendered).not.toContain('还没有已确认'); expect(rendered).not.toContain('你确认于')
  })
  it('原文是卡片首个主文本，来源紧凑，原因折叠，不生成标题或执行操作', () => {
    const rendered = renderCard({ body: '<b>真实原话</b>' })
    expect(rendered).toContain('&lt;b&gt;真实原话&lt;/b&gt;')
    expect(rendered.indexOf('真实原话')).toBeLessThan(rendered.indexOf('commitment-occurrence'))
    for (const text of [candidate.senderName!, candidate.conversationName!, '乙卡片.zip', '你确认于：', '为什么出现']) expect(rendered).toContain(text)
    expect(rendered).toMatch(/<details[^>]*><summary>为什么出现<\/summary>/)
    expect(rendered).not.toMatch(/<h3|<input|<select|<form|查看来源候选|来源筛选|时间筛选|日期筛选|添加待办|行动建议|归档|完成时间|承诺时间/)
    expect(rendered).not.toMatch(/>确认<|>忽略<|>完成<|>归档</)
    expect(rendered).toMatch(/class="commitment-primary"[^>]*>查看上下文/)
    expect(rendered).toMatch(/class="confirmed-secondary"[^>]*>查看证据/)
  })
  it.each(['source_native', 'user_supplied'])('可靠来源 %s 使用聊天时间，确认时间单独弱化', timestampSource => {
    const rendered = renderCard({ timestampSource })
    const metadata = rendered.match(/class="commitment-occurrence">([\s\S]*?)<\/div>/)![1]
    expect(metadata).toContain('2026/10/07'); expect(metadata).not.toContain('2035')
    expect(rendered).toMatch(/class="confirmed-review-time">你确认于：2035/)
  })
  it.each(['unknown', 'inferred', null])('非可靠来源 %s 不借用确认时间', timestampSource => {
    const rendered = renderCard({ timestampSource, ...{ createdAt: '2040-01-01T01:00:00Z' } })
    const metadata = rendered.match(/class="commitment-occurrence">([\s\S]*?)<\/div>/)![1]
    expect(metadata).toContain('聊天时间未知'); expect(metadata).not.toMatch(/2026|2035|2040/)
  })
  it('缺失聊天时间和确认时间都不补造，未知会话沿用弱化来源行', () => {
    const rendered = renderCard({ senderName: null, chatTimestamp: null, reviewedAt: null, conversationName: null })
    expect(rendered).toContain('发送人未知'); expect(rendered).toContain('聊天时间未知')
    expect(rendered).not.toContain('你确认于'); expect(rendered).not.toContain('<h3')
  })
  it.each(['missing', 'corrupt', 'error'] as const)('证据 %s 不可用仍保留原话和上下文入口', evidenceStatus => {
    const rendered = renderCard({ source: { ...candidate.source, evidenceStatus } })
    expect(rendered).toContain(candidate.body); expect(rendered).toContain('证据不可用，原话仍保留')
    expect(rendered).toContain('查看上下文')
  })
  it('长原文可完整展开，展开不请求任何接口', () => {
    const api = makeApi(), view = host(), body = '原话'.repeat(400)
    const render = () => view.render(ConfirmedCommitmentCard, { candidate: { ...candidate, body }, api })
    button(render(), '展开原文').onClick()
    expect(html(render())).toContain(body)
    for (const action of Object.values(api)) expect(action).not.toHaveBeenCalled()
  })
})

describe('只读按钮与刷新', () => {
  it('上下文与证据只发送当前候选身份，快速重复点击不重复请求，不调用审核', async () => {
    const api = makeApi(), view = host()
    const render = () => view.render(ConfirmedCommitmentCard, { candidate, api })
    const action = button(render(), '查看上下文'); action.onClick(); action.onClick(); await settle()
    expect(api.getCommitmentCandidateContext).toHaveBeenCalledExactlyOnceWith(candidate.id)
    expect(html(render())).toContain('当前候选原话')
    button(render(), '查看证据').onClick(); await settle()
    expect(api.openCommitmentCandidateEvidence).toHaveBeenCalledExactlyOnceWith(candidate.id)
    expect(api.confirmCommitmentCandidate).not.toHaveBeenCalled(); expect(api.ignoreCommitmentCandidate).not.toHaveBeenCalled()
  })
  it('证据打开失败保留卡片，错误不泄露内部路径，不回退其他来源', async () => {
    const api = makeApi(), view = host()
    vi.mocked(api.openCommitmentCandidateEvidence).mockResolvedValue({ ok: false, error: { code: 'EVIDENCE_UNAVAILABLE', message: 'C:\\内部证据路径' } })
    const render = () => view.render(ConfirmedCommitmentCard, { candidate, api })
    button(render(), '查看证据').onClick(); await settle()
    expect(html(render())).toContain(candidate.body); expect(html(render())).toContain('证据不可用')
    expect(html(render())).not.toContain('内部证据路径')
    expect(api.openCommitmentCandidateEvidence).toHaveBeenCalledExactlyOnceWith(candidate.id)
    expect(api.getCommitmentCandidateContext).not.toHaveBeenCalled()
  })
  it('未登记证据时禁用操作，即使直接触发也不请求接口', async () => {
    const api = makeApi(), view = host()
    const tree = view.render(ConfirmedCommitmentCard, { candidate: { ...candidate, source: { ...candidate.source, evidenceRecorded: false } }, api })
    const action = button(tree, '查看证据'); expect(action.disabled).toBe(true); action.onClick(); await settle()
    expect(api.openCommitmentCandidateEvidence).not.toHaveBeenCalled()
  })
  it('首次进入与刷新重新读取，审核修订后消失或出现，不保存审核状态', async () => {
    const api = makeApi(), view = host(), render = () => view.render(ConfirmedCommitmentsPage, { api })
    let tree = render(); expect(html(tree)).toContain('正在读取'); expect(html(tree)).not.toContain('还没有已确认')
    await settle()
    expect(html(render())).toContain(candidate.body)
    vi.mocked(api.listCommitmentCandidates).mockResolvedValue(ok([{ ...candidate, status: 'ignored' }]))
    button(render(), '刷新').onClick(); await settle()
    expect(html(render())).toContain('还没有已确认'); expect(html(render())).not.toContain(candidate.body)
    vi.mocked(api.listCommitmentCandidates).mockResolvedValue(ok([{ ...candidate, status: 'pending', reviewedAt: null }]))
    button(render(), '刷新').onClick(); await settle(); expect(html(render())).not.toContain(candidate.body)
    vi.mocked(api.listCommitmentCandidates).mockResolvedValue(ok([candidate]))
    button(render(), '刷新').onClick(); await settle(); expect(html(render())).toContain(candidate.body)
    expect(api.listCommitmentCandidates).toHaveBeenCalledTimes(4)
    expect(api.confirmCommitmentCandidate).not.toHaveBeenCalled(); expect(api.ignoreCommitmentCandidate).not.toHaveBeenCalled()
  })
  it('失败与空结果分开，刷新失败不将旧结果作为当前结果，重新加载可恢复', async () => {
    const api = makeApi(), view = host(), render = () => view.render(ConfirmedCommitmentsPage, { api })
    render(); await settle(); expect(html(render())).toContain(candidate.body)
    vi.mocked(api.listCommitmentCandidates).mockRejectedValue(new Error('SQLite C:\\内部路径'))
    button(render(), '刷新').onClick(); await settle()
    const failed = html(render()); expect(failed).toContain('加载失败'); expect(failed).not.toContain('还没有已确认')
    expect(failed).not.toContain(candidate.body); expect(failed).not.toContain('内部路径')
    vi.mocked(api.listCommitmentCandidates).mockResolvedValue(ok([]))
    button(render(), '刷新').onClick(); await settle()
    expect(html(render())).toContain('还没有已确认'); expect(html(render())).not.toContain('加载失败')
  })
  it('接口安全错误不冒充空结果，卸载前未完成的列表不能回填', async () => {
    const api = makeApi(), view = host(), render = () => view.render(ConfirmedCommitmentsPage, { api })
    vi.mocked(api.listCommitmentCandidates).mockResolvedValue({ ok: false, error: { code: 'OPERATION_FAILED', message: '敏感消息' } })
    render(); await settle()
    expect(html(render())).toContain('加载失败'); expect(html(render())).not.toContain('敏感消息')
    let resolve!: (result: CommitmentResult<CommitmentCandidateView[]>) => void
    vi.mocked(api.listCommitmentCandidates).mockImplementation(() => new Promise(next => { resolve = next }))
    button(render(), '刷新').onClick()
    expect(html(render())).not.toContain(candidate.body)
    view.unmount()
    const updatesAfterUnmount = view.frame.stateUpdates
    resolve(ok([candidate])); await settle()
    expect(view.frame.stateUpdates).toBe(updatesAfterUnmount)
  })
})

describe('审核分区与真实导航', () => {
  it('待审核在上，已确认及已忽略在下，审核后移动且反馈保留，修订能力仍在', async () => {
    const api = makeApi(), view = host(), pending = { ...candidate, status: 'pending' as const, reviewedAt: null }
    vi.mocked(api.listCommitmentCandidates).mockResolvedValue(ok([pending]))
    const render = () => view.render(CommitmentCandidatesPage, { api })
    render(); await settle()
    const update = (status: 'confirmed' | 'ignored') => {
      const content = elements(render()).find(element => element.type === CommitmentCandidatesContent)!
      ;(content.props.onReviewed as (review: CommitmentCandidateReview) => void)({ id: candidate.id, status, reviewedAt: candidate.reviewedAt })
    }
    update('confirmed')
    let rendered = html(render())
    expect(rendered.indexOf('aria-label="待审核"')).toBeLessThan(rendered.indexOf('aria-label="已审核"'))
    expect(rendered.slice(rendered.indexOf('aria-label="待审核"'), rendered.indexOf('aria-label="已审核"'))).not.toContain('data-candidate-id')
    expect(rendered).toContain('可在「承诺表达（已确认）」回看。')
    expect(rendered).not.toMatch(/已加入待办|任务已创建|行动项/)
    update('ignored'); expect(html(render())).toContain('已忽略')
    update('confirmed'); rendered = html(render()); expect(rendered).toMatch(/disabled=""[^>]*>确认<\/button>/)
    expect(rendered).toMatch(/<button type="button">忽略<\/button>/)
    const mixed = html(createElement(CommitmentCandidatesContent, { candidates: [pending, candidate, { ...candidate, id: '已忽略候选', status: 'ignored' }], api, onReviewed: vi.fn() }))
    expect(mixed.slice(mixed.indexOf('aria-label="已审核"'))).toContain('已忽略候选')
  })
  it('应用导航进入独立只读页，标题及说明准确，仍能回到审核页，不新增候选回跳', async () => {
    const api = makeApi()
    const history: SearchHistoryApi = {
      list: vi.fn(async () => historyOk(['已有搜索词'])),
      record: vi.fn(async () => historyOk([])),
      remove: vi.fn(async () => historyOk([])),
      clear: vi.fn(async () => historyOk([]))
    }
    const summary = vi.fn(async () => ({ date: null, items: [], demoMode: false, messageCount: 0, conversationCount: 0, totalMessageCount: 0, candidateCount: 0, finalIntelligenceCount: 0, telemetry: null, mode: 'rule' }))
    const firstUse = vi.fn(async () => ({ firstLaunch: false, latestImport: null, dataStatus: { latestMessageDate: null } }))
    let nextTimer = 0
    const startTimer = vi.fn(() => ++nextTimer), stopTimer = vi.fn<(_timer: number) => void>()
    vi.stubGlobal('window', { privateRadar: { commitmentCandidates: api, searchHistory: history,
      getDashboardSummary: summary, getFirstUseStatus: firstUse
    }, dispatchEvent: vi.fn(), setInterval: startTimer, clearInterval: stopTimer })
    const view = host(), render = () => view.render(App, {})
    render(); await settle()
    expect(history.list).toHaveBeenCalledOnce()
    expect(summary).toHaveBeenCalledOnce(); expect(firstUse).toHaveBeenCalledOnce()
    let tree = render(); button(tree, '承诺表达（已确认）').onClick(); tree = render()
    const activeTimers = startTimer.mock.results.map(result => result.value)
    expect(stopTimer.mock.calls.map(call => call[0])).toEqual(activeTimers.slice(0, -1))
    const timerCount = startTimer.mock.calls.length
    render(); render()
    expect(startTimer).toHaveBeenCalledTimes(timerCount)
    expect(history.list).toHaveBeenCalledOnce()
    expect(summary).toHaveBeenCalledOnce(); expect(firstUse).toHaveBeenCalledOnce()
    expect(button(tree, '承诺表达（已确认）')['aria-current']).toBe('page')
    expect(elements(tree).some(element => element.type === ConfirmedCommitmentsPage)).toBe(true)
    expect(elements(tree).some(element => element.type === 'h1' && element.props.children === '承诺表达（已确认）')).toBe(true)
    expect(html(tree)).toContain('仅表示你确认原话表达了承诺，不代表已完成或需要你执行。')
    expect(html(tree)).not.toContain('查看来源候选')
    for (const label of ['今日情报', '话题雷达', '问我的聊天', '设置', '批量收集', '关键词雷达', '承诺候选']) expect(button(tree, label)).toBeDefined()
    button(tree, '承诺候选').onClick(); tree = render()
    expect(elements(tree).some(element => element.type === CommitmentCandidatesPage)).toBe(true)
    expect(elements(tree).some(element => element.type === ConfirmedCommitmentsPage)).toBe(false)
    expect(api.confirmCommitmentCandidate).not.toHaveBeenCalled(); expect(api.ignoreCommitmentCandidate).not.toHaveBeenCalled()
    view.unmount(); view.unmount()
    expect(stopTimer.mock.calls.map(call => call[0])).toEqual(startTimer.mock.results.map(result => result.value))
  })
  it('搜索历史依赖变化重新挂载，稳定依赖不重复请求，卸载后晚回包不写状态', async () => {
    const history = (entries: string[]): SearchHistoryApi => ({
      list: vi.fn(async () => historyOk(entries)),
      record: vi.fn(async () => historyOk(entries)),
      remove: vi.fn(async () => historyOk(entries)),
      clear: vi.fn(async () => historyOk([]))
    })
    const first = history(['旧历史']), second = history(['新历史']), view = host()
    const render = (api: SearchHistoryApi) => view.render(({ api }) => useSearchHistory(api), { api })
    render(first); await settle(); expect(render(first).entries).toEqual(['旧历史'])
    expect(first.list).toHaveBeenCalledOnce()
    render(second); await settle(); expect(render(second).entries).toEqual(['新历史'])
    expect(second.list).toHaveBeenCalledOnce()
    let finish!: (result: SearchHistoryResult<string[]>) => void
    vi.mocked(second.record).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = render(second).record('卸载前搜索')
    view.unmount()
    const updatesAfterUnmount = view.frame.stateUpdates
    finish({ ok: true, value: ['卸载前搜索', '新历史'] }); await pending; await settle()
    expect(view.frame.stateUpdates).toBe(updatesAfterUnmount)
    expect(second.record).toHaveBeenCalledExactlyOnceWith('卸载前搜索')
  })
})

describe('隔离数据库与当前附件只读回源', () => {
  it.skipIf(process.platform !== 'win32')('真实列表、刷新、上下文和证据在只读数据库下工作，不执行待运行记录，不改变任何业务行或证据字节', async () => {
    const f = reviewFixture(), stored = listCommitmentCandidates(f.db)
    confirmCommitmentCandidate(f.db, stored[0].id); ignoreCommitmentCandidate(f.db, stored[1].id)
    expect(ingestRadarItem(f, 1, commitmentMessages(['我会处理历史问题']).map(message => ({ ...message, source_message_id: '隔离只读待处理身份' }))).status).toBe('success')
    const directory = await saveReviewEvidence(f)
    const current = listCommitmentCandidates(f.db).find(row => row.status === 'confirmed')!
    const evidencePaths = [join(directory, 'original.zip'), join(directory, 'messages.json')]
    const evidenceBytes = evidencePaths.map(path => readFileSync(path)), before = reviewDatabaseFingerprint(f)
    const matched = vi.spyOn(matcher, 'matchCommitmentBody'), processed = vi.spyOn(processor, 'processCommitmentExtractorRun')
    const opened = vi.fn(async () => '')
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerCommitmentCandidateIpc({ handle: (name, listener) => handlers.set(name, listener) }, f.db,
      id => openCommitmentCandidateEvidence(f.db, f.path, id, opened))
    const invoke = async <T>(name: string, ...args: unknown[]) => await handlers.get('commitment-candidates:' + name)!(null, ...args) as CommitmentResult<T>
    const api = {
      listCommitmentCandidates: () => invoke<CommitmentCandidateView[]>('list'),
      getCommitmentCandidateContext: (id: string) => invoke<CommitmentCandidateContext>('context', id),
      openCommitmentCandidateEvidence: (id: string) => invoke<{ batchItemId: string; opened: true }>('open-evidence', id)
    }
    f.db.exec('PRAGMA query_only=ON')
    const page = host(), render = () => page.render(ConfirmedCommitmentsPage, { api })
    render(); await settle(); expect(html(render())).toContain(current.body)
    button(render(), '刷新').onClick(); await settle(); expect(html(render())).toContain(current.body)
    const card = host(), renderCard = () => card.render(ConfirmedCommitmentCard, { candidate: current, api })
    button(renderCard(), '查看上下文').onClick(); await settle()
    expect(html(renderCard())).toContain('当前候选原话')
    button(renderCard(), '查看证据').onClick()
    // 等待既有原生证据验证完成，而不是替换它的来源决策。
    await vi.waitFor(() => {
      expect(opened).toHaveBeenCalledExactlyOnceWith(directory)
      expect(html(renderCard())).toContain('已打开该附件的证据目录。')
    }, { timeout: 20000 })
    expect(matched).not.toHaveBeenCalled(); expect(processed).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT status,attempt_count FROM commitment_extractor_runs WHERE batch_item_id=?').get(f.items[1].id)).toEqual({ status: 'pending', attempt_count: 0 })
    expect(reviewDatabaseFingerprint(f)).toBe(before)
    expect(evidencePaths.map(path => readFileSync(path))).toEqual(evidenceBytes)
    expect([...handlers.keys()]).toHaveLength(5)
  }, 30000)
})

// 复锁：50；保留全部 UI/只读断言，以真实 JSON Evidence 替换外部 ZIP 准备。
describe('共享真实 JSON 与只读 DB 的承诺 UI', () => {
  it('真实列表、刷新、上下文和证据在只读数据库下工作，不执行待运行记录，不改变任何业务行或证据字节', async () => {
    const f = sharedJsonFixture(), entry = await importSharedJson(f, commitmentMessages(['我会处理这个问题','我来处理这个接口','我稍后回复你']))
    await drainSharedDerived()
    const stored = listCommitmentCandidates(f.db)
    confirmCommitmentCandidate(f.db, stored[0].id); ignoreCommitmentCandidate(f.db, stored[1].id)
    const pending = sharedCoreItems(f, 1)
    expect(ingestSharedCore(pending, 0, commitmentMessages(['我会处理历史问题']).map(message => ({ ...message, source_message_id: '隔离只读待处理身份' }))).status).toBe('success')
    const directory = join(f.directory,'evidence',entry.item.id)
    const current = listCommitmentCandidates(f.db).find(row => row.status === 'confirmed')!
    const evidencePaths = [join(directory, 'original.zip'), join(directory, 'messages.json')]
    const evidenceBytes = evidencePaths.map(path => readFileSync(path)), before = reviewDatabaseFingerprint(f)
    const matched = vi.spyOn(matcher, 'matchCommitmentBody'), processed = vi.spyOn(processor, 'processCommitmentExtractorRun')
    const opened = vi.fn(async () => '')
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerCommitmentCandidateIpc({ handle: (name, listener) => handlers.set(name, listener) }, f.db,
      id => openCommitmentCandidateEvidence(f.db, f.path, id, opened))
    const invoke = async <T>(name: string, ...args: unknown[]) => await handlers.get('commitment-candidates:' + name)!(null, ...args) as CommitmentResult<T>
    const api = {
      listCommitmentCandidates: () => invoke<CommitmentCandidateView[]>('list'),
      getCommitmentCandidateContext: (id: string) => invoke<CommitmentCandidateContext>('context', id),
      openCommitmentCandidateEvidence: (id: string) => invoke<{ batchItemId: string; opened: true }>('open-evidence', id)
    }
    f.db.exec('PRAGMA query_only=ON')
    const page = host(), render = () => page.render(ConfirmedCommitmentsPage, { api })
    render(); await settle(); expect(html(render())).toContain(current.body)
    button(render(), '刷新').onClick(); await settle(); expect(html(render())).toContain(current.body)
    const card = host(), renderCard = () => card.render(ConfirmedCommitmentCard, { candidate: current, api })
    button(renderCard(), '查看上下文').onClick(); await settle()
    expect(html(renderCard())).toContain('当前候选原话')
    button(renderCard(), '查看证据').onClick()
    // 等待既有原生证据验证完成，而不是替换它的来源决策。
    await vi.waitFor(() => {
      expect(opened).toHaveBeenCalledExactlyOnceWith(directory)
      expect(html(renderCard())).toContain('已打开该附件的证据目录。')
    }, { timeout: 20000 })
    expect(matched).not.toHaveBeenCalled(); expect(processed).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT status,attempt_count FROM commitment_extractor_runs WHERE batch_item_id=?').get(pending.items[0].id)).toEqual({ status: 'pending', attempt_count: 0 })
    expect(reviewDatabaseFingerprint(f)).toBe(before)
    expect(evidencePaths.map(path => readFileSync(path))).toEqual(evidenceBytes)
    expect([...handlers.keys()]).toHaveLength(5)
  }, 30000)
})
