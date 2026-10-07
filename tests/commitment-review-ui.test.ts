import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { CommitmentCandidateContext, CommitmentCandidateReview, CommitmentCandidateView, CommitmentDesktopApi, CommitmentResult } from '../src/shared/commitment'
import { CommitmentCandidateCard, CommitmentCandidatesContent, CommitmentCandidatesPage, CommitmentContext, commitmentCandidateError, commitmentCandidateReason } from '../src/renderer/src/commitment-candidates-page'

interface HookFrame { slots: unknown[]; cursor: number; effects: Array<() => void | (() => void)> }
const hooks = vi.hoisted(() => ({ active: null as HookFrame | null }))
// 行为测试只替换组件钩子的宿主，直接执行产品中的按钮处理函数；静态渲染仍使用真实 React。
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState(initial: unknown) {
      const frame = hooks.active
      if (!frame) return actual.useState(initial)
      const position = frame.cursor++
      if (!(position in frame.slots)) frame.slots[position] = typeof initial === 'function' ? initial() : initial
      return [frame.slots[position], (next: unknown) => { frame.slots[position] = typeof next === 'function' ? next(frame.slots[position]) : next }]
    },
    useRef(initial: unknown) {
      const frame = hooks.active
      if (!frame) return actual.useRef(initial)
      const position = frame.cursor++
      if (!(position in frame.slots)) frame.slots[position] = { current: initial }
      return frame.slots[position]
    },
    useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
      if (!hooks.active) return actual.useEffect(effect, dependencies)
      hooks.active.effects.push(effect)
    }
  }
})
const candidate: CommitmentCandidateView = {
  id: '候选乙', status: 'pending', reviewedAt: null, batchItemId: '附件乙', sourcePosition: 5, messageId: '共享规范消息',
  body: '我稍后整理资料。', senderName: '来源乙发送人', chatTimestamp: '2026-10-07T02:20:00Z', timestampSource: 'source_native', conversationName: '乙会话',
  ruleId: 'self_future_action', reasonCode: 'explicit_self_future_action', ruleVersion: 'commitment-v1',
  source: { batchItemId: '附件乙', attachmentName: '乙卡片.zip', ordinal: 1, evidenceKind: 'zip', evidenceStatus: 'available', evidenceRecorded: true }
}
const ok = <T>(value: T): CommitmentResult<T> => ({ ok: true, value })
function makeApi(): CommitmentDesktopApi {
  return {
    listCommitmentCandidates: vi.fn(async () => ok([candidate])),
    confirmCommitmentCandidate: vi.fn(async (id: string) => ok<CommitmentCandidateReview>({ id, status: 'confirmed', reviewedAt: '2035-01-01T01:00:00Z' })),
    ignoreCommitmentCandidate: vi.fn(async (id: string) => ok<CommitmentCandidateReview>({ id, status: 'ignored', reviewedAt: '2035-01-02T01:00:00Z' })),
    getCommitmentCandidateContext: vi.fn(async candidateId => ok({ candidateId, batchItemId: candidate.batchItemId, entries: [{ ...candidate, isCurrent: true }] })),
    openCommitmentCandidateEvidence: vi.fn(async () => ok({ batchItemId: candidate.batchItemId, opened: true as const }))
  }
}
const renderCard = (changes: Partial<CommitmentCandidateView> = {}) => renderToStaticMarkup(createElement(CommitmentCandidateCard, { candidate: { ...candidate, ...changes }, api: makeApi(), onReviewed: vi.fn() }))
function host() {
  const frame: HookFrame = { slots: [], cursor: 0, effects: [] }
  return { frame, render<T>(component: (props: T) => React.JSX.Element, props: T) {
    frame.cursor = 0; frame.effects = []; hooks.active = frame
    try { return component(props) } finally { hooks.active = null }
  } }
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function button(tree: ReactNode, text: string) {
  const found = elements(tree).find(element => element.type === 'button' && element.props.children === text)
  if (!found) throw new Error(`未找到按钮：${text}`)
  return found.props as { disabled?: boolean; onClick: () => void }
}
async function settle() { for (let count = 0; count < 8; count++) await Promise.resolve() }
function cardHost(api = makeApi(), initial = candidate) {
  const view = host(); let current = { ...initial }
  const onReviewed = vi.fn((review: CommitmentCandidateReview) => { current = { ...current, ...review } })
  return { api, onReviewed, render: () => view.render(CommitmentCandidateCard, { candidate: current, api, onReviewed }), current: () => current }
}

describe('承诺候选最小展示契约', () => {
  it('空列表明确人工审核与后续新导入边界，不提供处理任务或其他功能', () => {
    const html = renderToStaticMarkup(createElement(CommitmentCandidatesContent, { candidates: [], api: makeApi(), onReviewed: vi.fn() }))
    for (const text of ['还没有承诺候选', '之后新导入的聊天', '确认仅表示这条原话表达了承诺']) expect(html).toContain(text)
    expect(html).not.toMatch(/仪表盘|提醒|优先级|负责人|截止时间|看板|置信|概率|重新处理|已完成/)
  })
  it.each([['pending', '待审核'], ['confirmed', '已确认'], ['ignored', '已忽略']] as const)('显示 %s、来源原文和 occurrence 元数据', (status, label) => {
    const html = renderCard({ status })
    for (const text of [label, candidate.body, candidate.senderName!, candidate.conversationName!, '乙卡片.zip', '来源位置 5', '查看上下文', '查看证据', '确认', '忽略']) expect(html).toContain(text)
    expect(html).not.toContain('共享规范消息')
  })
  it.each(['source_native', 'user_supplied'])('仅可靠来源 %s 显示聊天时间，审核时间不充当聊天时间', timestampSource => {
    const html = renderCard({ timestampSource, reviewedAt: '2035-01-01T01:00:00Z' })
    expect(html).toContain('2026/10/07')
    expect(html).not.toContain('聊天时间未知')
    expect(html).not.toContain('2035')
  })
  it.each(['inferred', 'unknown', null, 'system'])('不可靠时间来源 %s 即使有值也显示未知', timestampSource => {
    const html = renderCard({ timestampSource, reviewedAt: '2035-01-01T01:00:00Z' })
    expect(html).toContain('聊天时间未知')
    expect(html).not.toContain('2026/10/07')
    expect(html).not.toContain('2035')
  })
  it.each([null, '', '无效日期'])('缺失或无效原始聊天时间 %s 不补时间', chatTimestamp => {
    expect(renderCard({ chatTimestamp })).toContain('聊天时间未知')
  })
  it('发送人、会话未知明确提示，附加创建时间不能冒充聊天时间', () => {
    const html = renderCard({ senderName: null, conversationName: ' ', chatTimestamp: null, ...{ createdAt: '2099-01-01T12:00:00Z' } })
    for (const text of ['发送人未知', '会话未知', '聊天时间未知']) expect(html).toContain(text)
    expect(html).not.toContain('2099')
  })
  it.each([
    ['self_responsibility', 'explicit_self_responsibility', '由“我”负责'],
    ['self_future_action', 'explicit_self_future_action', '在稍后采取'],
    ['self_will_action', 'explicit_self_will_action', '“我会”'],
    ['self_take_action', 'explicit_self_take_action', '“我来”']
  ])('已保存规则 %s 使用稳定可读说明并保留三项规则信息', (ruleId, reasonCode, label) => {
    const html = renderCard({ ruleId, reasonCode })
    for (const text of [ruleId, reasonCode, 'commitment-v1', label]) expect(html).toContain(text)
  })
  it.each([
    { ruleVersion: '未来版本' }, { ruleId: '未知规则' }, { reasonCode: '未知原因' }, { ruleId: 'constructor' }, { ruleId: '__proto__' }
  ])('未知规则信息 %j 不冒充当前规则解释', changes => {
    const html = renderCard(changes)
    expect(html).toContain('匹配依据尚无可读说明')
    expect(html).not.toContain('在稍后采取具体行动')
    for (const value of Object.values(changes)) expect(html).toContain(value)
    expect(commitmentCandidateReason({ ...candidate, ...changes })).toContain('已保存的规则信息')
  })
  it('长原文可展开，原文及来源名字转义，不注入标记或解释', () => {
    const html = renderCard({ body: '<script>原文</script>' + '正文'.repeat(400), senderName: '<b>发送人</b>' })
    expect(html).toContain('展开原文'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;b&gt;')
    expect(html).not.toMatch(/<script>|<mark>/)
  })
  it('上下文按真实来源位置标出中心，未知时间不补齐', () => {
    const context: CommitmentCandidateContext = { candidateId: candidate.id, batchItemId: candidate.batchItemId, entries: [0, 3, 5].map(sourcePosition => ({ ...candidate, sourcePosition, isCurrent: sourcePosition === 5, timestampSource: 'inferred' })) }
    const html = renderToStaticMarkup(createElement(CommitmentContext, { context }))
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
    for (const text of ['来源位置 0', '来源位置 3', '来源位置 5', '当前候选原话', '同一附件及会话中的上下文']) expect(html).toContain(text)
    expect(html.match(/聊天时间未知/g)).toHaveLength(3)
    expect(html).not.toContain('来源位置 1')
  })
  it.each(['missing', 'corrupt', 'error'] as const)('证据 %s 明确不可用且保留候选和审核入口', evidenceStatus => {
    const html = renderCard({ source: { ...candidate.source, evidenceStatus } })
    expect(html).toContain('证据不可用'); expect(html).toContain('候选仍保留'); expect(html).toContain(candidate.body)
    expect(html).toMatch(/<button[^>]*>确认<\/button>/)
    expect(html).toMatch(/<button[^>]*>忽略<\/button>/)
  })
  it('证据未登记禁用打开且明确保留候选', () => {
    const html = renderCard({ source: { ...candidate.source, evidenceRecorded: false } })
    expect(html).toContain('证据不可用：未登记'); expect(html).toContain('候选仍保留')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>查看证据<\/button>/)
  })
  it('固定错误映射隐藏正文、内部路径和数据库异常', () => {
    expect(commitmentCandidateError(new Error('EVIDENCE_UNAVAILABLE'))).toBe('该附件的证据不可用，候选仍保留。')
    for (const message of ['constructor', '__proto__', 'toString', 'SQLite C:\\私密目录 私聊正文']) expect(commitmentCandidateError(new Error(message))).toBe('承诺候选操作未完成，请稍后重试。')
  })
  it('复用应用样式变量，并保留焦点和禁用按钮样式', () => {
    const css = readFileSync(new URL('../src/renderer/src/commitment-candidates-page.css', import.meta.url), 'utf8')
    const shared = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    for (const match of css.matchAll(/var\((--[\w-]+)\)/g)) expect(shared).toContain(match[1] + ':')
    expect(css).toContain(':focus-visible'); expect(css).toContain('button:disabled')
  })
  it('只接入独立页面，页面不匹配、不恢复、不创建历史记录', () => {
    const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain(".concat('承诺候选')")
    expect(app).toContain("page === 'commitments' && <CommitmentCandidatesPage />")
    const source = readFileSync(new URL('../src/renderer/src/commitment-candidates-page.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/setInterval|setTimeout|matchCommitment|processPending|retryCommitment|node:sqlite|askChat|verifyBatchEvidence|readFile/)
    expect(source).toContain('api.listCommitmentCandidates()')
    expect(source).not.toMatch(/createdAt|created_at/)
  })
})

describe('承诺候选按钮实际行为', () => {
  it('点击确认精确传候选编号，采用服务端审核返回并显示确认状态', async () => {
    const view = cardHost()
    button(view.render(), '确认').onClick(); await settle()
    expect(view.api.confirmCommitmentCandidate).toHaveBeenCalledExactlyOnceWith(candidate.id)
    expect(view.api.ignoreCommitmentCandidate).not.toHaveBeenCalled()
    expect(view.onReviewed).toHaveBeenCalledWith({ id: candidate.id, status: 'confirmed', reviewedAt: '2035-01-01T01:00:00Z' })
    const tree = view.render()
    expect(renderToStaticMarkup(tree)).toContain('已确认')
    expect(button(tree, '确认').disabled).toBe(true)
    expect(button(tree, '忽略').disabled).toBe(false)
  })
  it('忽略与确认允许互相切换，每次只调用相应审核接口', async () => {
    const view = cardHost()
    for (const [label, status] of [['忽略', 'ignored'], ['确认', 'confirmed'], ['忽略', 'ignored']] as const) {
      button(view.render(), label).onClick(); await settle()
      expect(view.current().status).toBe(status)
    }
    expect(view.api.ignoreCommitmentCandidate).toHaveBeenCalledTimes(2)
    expect(view.api.confirmCommitmentCandidate).toHaveBeenCalledExactlyOnceWith(candidate.id)
    expect(renderToStaticMarkup(view.render())).toContain('已忽略')
  })
  it.each([['confirmed', '确认'], ['ignored', '忽略']] as const)('同状态 %s 按钮禁用，即使重复触发也不调用审核接口', async (status, label) => {
    const reviewedAt = '2035-01-01T01:00:00Z'; const view = cardHost(makeApi(), { ...candidate, status, reviewedAt })
    const action = button(view.render(), label); expect(action.disabled).toBe(true)
    action.onClick(); await settle()
    expect(view.api.confirmCommitmentCandidate).not.toHaveBeenCalled(); expect(view.api.ignoreCommitmentCandidate).not.toHaveBeenCalled()
    expect(view.onReviewed).not.toHaveBeenCalled(); expect(view.current().reviewedAt).toBe(reviewedAt)
  })
  it('快速重复点击在接口完成前仅发送一次请求', async () => {
    const api = makeApi(); let resolve!: (result: CommitmentResult<CommitmentCandidateReview>) => void
    vi.mocked(api.confirmCommitmentCandidate).mockImplementation(() => new Promise(next => { resolve = next }))
    const view = cardHost(api); const action = button(view.render(), '确认')
    action.onClick(); action.onClick()
    expect(api.confirmCommitmentCandidate).toHaveBeenCalledTimes(1)
    expect(button(view.render(), '确认中…').disabled).toBe(true)
    resolve(ok({ id: candidate.id, status: 'confirmed', reviewedAt: '2035-01-01T01:00:00Z' })); await settle()
    expect(view.current().status).toBe('confirmed')
  })
  it('审核失败保留状态和原文，不假报审核成功', async () => {
    const api = makeApi(); vi.mocked(api.confirmCommitmentCandidate).mockResolvedValue({ ok: false, error: { code: 'OPERATION_FAILED', message: '内部敏感异常' } })
    const view = cardHost(api); button(view.render(), '确认').onClick(); await settle()
    const html = renderToStaticMarkup(view.render())
    expect(view.onReviewed).not.toHaveBeenCalled(); expect(view.current().status).toBe('pending')
    expect(html).toContain('待审核'); expect(html).toContain(candidate.body); expect(html).toContain('操作未完成')
    expect(html).not.toContain('内部敏感异常'); expect(html).not.toContain('已确认这条原话')
  })
  it('上下文按钮只传候选编号，展示返回的真实中心，折叠再次展开复用查看结果', async () => {
    const view = cardHost(); button(view.render(), '查看上下文').onClick(); await settle()
    expect(view.api.getCommitmentCandidateContext).toHaveBeenCalledExactlyOnceWith(candidate.id)
    expect(renderToStaticMarkup(view.render())).toContain('当前候选原话')
    button(view.render(), '收起上下文').onClick(); expect(renderToStaticMarkup(view.render())).not.toContain('当前候选原话')
    button(view.render(), '查看上下文').onClick(); expect(renderToStaticMarkup(view.render())).toContain('当前候选原话')
    expect(view.api.getCommitmentCandidateContext).toHaveBeenCalledTimes(1)
    expect(view.onReviewed).not.toHaveBeenCalled()
  })
  it('证据按钮只请求当前候选，失败后原文与状态保留且无其他来源导航', async () => {
    const api = makeApi(); vi.mocked(api.openCommitmentCandidateEvidence).mockResolvedValue({ ok: false, error: { code: 'EVIDENCE_UNAVAILABLE', message: '不展示路径' } })
    const view = cardHost(api); button(view.render(), '查看证据').onClick(); await settle()
    expect(api.openCommitmentCandidateEvidence).toHaveBeenCalledExactlyOnceWith(candidate.id)
    expect(view.onReviewed).not.toHaveBeenCalled(); expect(view.current()).toEqual(candidate)
    const html = renderToStaticMarkup(view.render())
    expect(html).toContain('该附件的证据不可用，候选仍保留。'); expect(html).toContain(candidate.body)
    expect(html).not.toContain('不展示路径')
    expect(api.getCommitmentCandidateContext).not.toHaveBeenCalled(); expect(api.listCommitmentCandidates).not.toHaveBeenCalled()
  })
  it('未登记证据即使手动触发处理函数也不请求打开', async () => {
    const api = makeApi(); const view = cardHost(api, { ...candidate, source: { ...candidate.source, evidenceRecorded: false } })
    const action = button(view.render(), '查看证据'); expect(action.disabled).toBe(true)
    action.onClick(); await settle(); expect(api.openCommitmentCandidateEvidence).not.toHaveBeenCalled()
  })
  it('页面挂载只读取已有列表，手动刷新只重复读取列表', async () => {
    const api = makeApi(); const view = host()
    view.render(CommitmentCandidatesPage, { api }); const effect = view.frame.effects[0]; effect(); await settle()
    let tree = view.render(CommitmentCandidatesPage, { api })
    expect(renderToStaticMarkup(tree)).toContain(candidate.body)
    button(tree, '刷新').onClick(); await settle(); tree = view.render(CommitmentCandidatesPage, { api })
    expect(api.listCommitmentCandidates).toHaveBeenCalledTimes(2)
    for (const method of [api.confirmCommitmentCandidate, api.ignoreCommitmentCandidate, api.getCommitmentCandidateContext, api.openCommitmentCandidateEvidence]) expect(method).not.toHaveBeenCalled()
    expect(renderToStaticMarkup(tree)).toContain('只读取已有候选，不扫描以前的聊天记录。')
  })
  it('刷新返回的旧列表不能覆盖已成功返回的审核结果', async () => {
    const api = makeApi(); const view = host()
    view.render(CommitmentCandidatesPage, { api }); view.frame.effects[0](); await settle()
    let resolve!: (result: CommitmentResult<CommitmentCandidateView[]>) => void
    vi.mocked(api.listCommitmentCandidates).mockImplementation(() => new Promise(next => { resolve = next }))
    const tree = view.render(CommitmentCandidatesPage, { api }); button(tree, '刷新').onClick()
    const content = elements(tree).find(element => element.type === CommitmentCandidatesContent)!
    ;(content.props.onReviewed as (review: CommitmentCandidateReview) => void)({ id: candidate.id, status: 'confirmed', reviewedAt: '2035-01-01T01:00:00Z' })
    resolve(ok([candidate])); await settle()
    const html = renderToStaticMarkup(view.render(CommitmentCandidatesPage, { api }))
    expect(html).toContain('已确认'); expect(html).not.toContain('待审核')
    expect(button(view.render(CommitmentCandidatesPage, { api }), '刷新').disabled).toBe(false)
  })
})
