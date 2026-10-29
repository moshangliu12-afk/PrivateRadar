import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App, SearchPage } from '../src/renderer/src/App'
import { RecentSearches, useSearchHistory } from '../src/renderer/src/search-history'
import type { SearchHistoryApi, SearchHistoryResult } from '../src/shared/search-history'
import { addSearchHistory, removeSearchHistory } from '../src/shared/search-history'

interface Frame { slots: any[]; cursor: number; effects: Array<() => void>; cleanups: Array<() => void> }
const hooks = vi.hoisted(() => ({ active: null as Frame | null }))
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
    useEffect(effect: () => void | (() => void), dependencies?: unknown[]) {
      if (!hooks.active) return actual.useEffect(effect, dependencies)
      const frame = hooks.active, index = frame.cursor++, previous = frame.slots[index]
      if (previous && dependencies && previous.dependencies?.length === dependencies.length && dependencies.every((value, at) => Object.is(value, previous.dependencies[at]))) return
      frame.slots[index] = { dependencies }
      frame.effects.push(() => {
        previous?.cleanup?.()
        const cleanup = effect()
        frame.slots[index].cleanup = cleanup
        if (cleanup) frame.cleanups.push(cleanup)
      })
    }
  }
})
afterEach(() => { hooks.active = null; vi.restoreAllMocks(); vi.unstubAllGlobals() })
const ok = <T,>(value: T): SearchHistoryResult<T> => ({ ok: true, value })
function host<T>(component: () => T) {
  const state: Frame = { slots: [], cursor: 0, effects: [], cleanups: [] }
  return { render() {
    state.cursor = 0; hooks.active = state
    let result: T
    try { result = component() } finally { hooks.active = null }
    const effects = state.effects.splice(0); effects.forEach(effect => effect())
    return result
  }, unmount() { state.cleanups.forEach(cleanup => cleanup()) } }
}
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<any>
  return [element, ...elements(element.props.children)]
}
function button(tree: ReactNode, label: string) {
  const item = elements(tree).find(element => element.type === 'button' && (element.props.children === label || element.props['aria-label'] === label))
  if (!item) throw Error('缺少按钮：' + label)
  return item.props
}
async function flush() { for (let n = 0; n < 22; n++) await Promise.resolve() }
function persisted(initial: string[] = []) {
  let stored = [...initial]
  const api: SearchHistoryApi = {
    list: vi.fn(async () => ok([...stored])),
    record: vi.fn(async query => { stored = addSearchHistory(stored, query); return ok([...stored]) }),
    remove: vi.fn(async query => { stored = removeSearchHistory(stored, query); return ok([...stored]) }),
    clear: vi.fn(async () => { stored = []; return ok([]) })
  }
  return { api, get: () => stored }
}
const searchProps = () => ({ status: null, question: '', querying: false, response: null, openMessageId: '', context: null,
  onQuestionChange: vi.fn(), onSubmit: vi.fn(async () => {}), onToggleContext: vi.fn(async () => {}) })

describe('最近搜索界面与本地持久化接线', () => {
  it('只读取历史不创建记录，六个原始搜索词由本地接口返回', async () => {
    const data = persisted(['旧词']), h = host(() => useSearchHistory(data.api))
    h.render(); await flush()
    expect(h.render().entries).toEqual(['旧词'])
    expect(data.api.list).toHaveBeenCalledOnce()
    expect(data.api.record).not.toHaveBeenCalled()
  })
  it('记录、单删和清空同步本地结果，重新挂载后保留', async () => {
    const data = persisted(['旧词']), h = host(() => useSearchHistory(data.api))
    h.render(); await flush(); await h.render().record('新查询😀')
    expect(h.render().entries).toEqual(['新查询😀', '旧词'])
    await h.render().remove('旧词'); expect(h.render().entries).toEqual(['新查询😀'])
    h.unmount()
    const reopened = host(() => useSearchHistory(data.api)); reopened.render(); await flush()
    expect(reopened.render().entries).toEqual(['新查询😀'])
    await reopened.render().clear()
    expect(reopened.render().entries).toEqual([]); expect(data.get()).toEqual([])
  })
  it('延迟的初始列表不会覆盖后提交的新搜索', async () => {
    const data = persisted(['旧词'])
    let finish!: (result: SearchHistoryResult<string[]>) => void
    vi.mocked(data.api.list).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const h = host(() => useSearchHistory(data.api)); h.render()
    await h.render().record('新词'); finish(ok(['旧词'])); await flush()
    expect(h.render().entries).toEqual(['新词', '旧词'])
  })
  it('旧操作回包不会撤销较新的清空或删除', async () => {
    const data = persisted(['旧词'])
    let finish!: (result: SearchHistoryResult<string[]>) => void
    vi.mocked(data.api.record).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const h = host(() => useSearchHistory(data.api)); h.render(); await flush()
    const pending = h.render().record('待完成')
    await h.render().clear(); finish(ok(['待完成', '旧词'])); await pending
    expect(h.render().entries).toEqual([])
  })
  it('失败显示可读提示并保留现有历史，不让记录错误向搜索链抛出', async () => {
    const data = persisted(['旧词']), h = host(() => useSearchHistory(data.api)); h.render(); await flush()
    vi.mocked(data.api.record).mockRejectedValueOnce(new Error('历史暂未保存'))
    await expect(h.render().record('新词')).resolves.toBeUndefined()
    expect(h.render().entries).toEqual(['旧词']); expect(h.render().error).toBe('历史暂未保存')
  })
  it('本地读取失败后仍允许正常提交记录，卸载后的回包无界面写入', async () => {
    const data = persisted()
    vi.mocked(data.api.list).mockRejectedValueOnce(new Error('历史读取失败'))
    const h = host(() => useSearchHistory(data.api)); h.render(); await flush()
    expect(h.render().error).toBe('历史读取失败')
    await h.render().record('正常提交'); expect(h.render().entries).toEqual(['正常提交'])
    let finish!: (result: SearchHistoryResult<string[]>) => void
    vi.mocked(data.api.remove).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = h.render().remove('正常提交'); h.unmount(); finish(ok([])); await pending
    expect(h.render().entries).toEqual(['正常提交'])
  })
  it('历史按钮直接重搜原词，删除与清空不会发起查询', () => {
    const search = vi.fn(async () => {}), remove = vi.fn(), clear = vi.fn()
    const tree = RecentSearches({ entries: ['"保留  双空格" 😀'], querying: false, onSearch: search, onRemove: remove, onClear: clear })
    button(tree, '"保留  双空格" 😀').onClick()
    expect(search).toHaveBeenCalledExactlyOnceWith('"保留  双空格" 😀')
    button(tree, '删除最近搜索："保留  双空格" 😀').onClick(); button(tree, '清空历史').onClick()
    expect(remove).toHaveBeenCalledExactlyOnceWith('"保留  双空格" 😀'); expect(clear).toHaveBeenCalledOnce(); expect(search).toHaveBeenCalledOnce()
  })
  it('空历史不渲染空列表，原输入、回车和示例问题保持', () => {
    const props = searchProps(), tree = SearchPage(props)
    const markup = renderToStaticMarkup(tree)
    expect(markup).not.toContain('aria-label="最近搜索"')
    expect(markup).toContain('上个月谁推荐过 AI 工具？'); expect(markup).toContain('最近大家怎么评价 Claude Code？')
    const form = elements(tree).find(element => element.type === 'form')!, prevent = vi.fn()
    form.props.onSubmit({ preventDefault: prevent }); expect(prevent).toHaveBeenCalledOnce(); expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith()
    elements(tree).find(element => element.type === 'input')!.props.onChange({ target: { value: '仅输入' } })
    expect(props.onQuestionChange).toHaveBeenCalledExactlyOnceWith('仅输入'); expect(props.onSubmit).toHaveBeenCalledOnce()
  })
  it('已有历史保持示例问题、查询中禁用快捷重搜，历史词仅作文本展示', () => {
    const props = searchProps(), tree = SearchPage({ ...props, recentSearches: ['<script>内容</script>'], querying: true })
    const markup = renderToStaticMarkup(tree)
    expect(markup).toContain('最近搜索'); expect(markup).toContain('&lt;script&gt;内容&lt;/script&gt;'); expect(markup).not.toContain('<script>')
    expect(markup).toContain('上个月谁推荐过 AI 工具？')
    const history = elements(tree).find(element => element.type === RecentSearches)!
    expect(button(RecentSearches(history.props), '<script>内容</script>').disabled).toBe(true)
  })
  it('本地历史的增删清空不产生网络请求或保存结果正文', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('禁止联网'))
    const data = persisted(), h = host(() => useSearchHistory(data.api)); h.render(); await flush()
    await h.render().record('用户搜索词'); await h.render().remove('用户搜索词'); await h.render().clear()
    expect(network).not.toHaveBeenCalled()
    expect(data.api.record).toHaveBeenCalledExactlyOnceWith('用户搜索词')
    expect(data.get()).toEqual([])
  })
  it('App只在实际提交时记录，原trim查询完整传给检索，历史失败不阻断搜索', async () => {
    const data = persisted(), ask = vi.fn(async () => null)
    const desktop = { searchHistory: data.api, askChat: ask,
      getDashboardSummary: vi.fn(async () => ({ date: null, items: [], mode: 'rule', demoMode: false })),
      getFirstUseStatus: vi.fn(async () => ({ firstLaunch: false, latestImport: null, dataStatus: { latestAttempt: null, latestMessageDate: null } })) }
    vi.stubGlobal('window', { privateRadar: desktop, dispatchEvent: vi.fn(), setInterval: vi.fn(() => 1), clearInterval: vi.fn() })
    const h = host(App); h.render(); await flush(); let tree = h.render()
    const navigation = elements(tree).find(element => element.type === 'button' && elements(element.props.children).some(child => child.props.children === '问我的聊天'))!
    navigation.props.onClick(); tree = h.render()
    let search = elements(tree).find(element => element.type === SearchPage)!
    search.props.onQuestionChange('  "保留  双空格"  '); tree = h.render(); search = elements(tree).find(element => element.type === SearchPage)!
    expect(ask).not.toHaveBeenCalled(); expect(data.api.record).not.toHaveBeenCalled()
    await search.props.onSubmit(); await flush(); tree = h.render()
    expect(ask).toHaveBeenCalledExactlyOnceWith('"保留  双空格"')
    expect(data.api.record).toHaveBeenCalledExactlyOnceWith('"保留  双空格"')
    search = elements(tree).find(element => element.type === SearchPage)!
    expect(search.props.recentSearches).toEqual(['"保留  双空格"'])
    vi.mocked(data.api.record).mockRejectedValueOnce(Error('保存失败'))
    await search.props.onSubmit('第二次'); await flush(); tree = h.render()
    expect(ask).toHaveBeenLastCalledWith('第二次')
    expect(elements(tree).find(element => element.type === SearchPage)!.props.searchHistoryError).toBe('保存失败')
    await elements(tree).find(element => element.type === SearchPage)!.props.onSubmit('   ')
    expect(ask).toHaveBeenCalledTimes(2); expect(data.api.record).toHaveBeenCalledTimes(2)
    h.unmount()
  })
})
