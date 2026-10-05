import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { CollectionDetail, CollectionListEntry } from '../src/shared/collections'
import { CollectionDetailView, CollectionList, collectionErrorMessage, collectionImportCommand, copyCollectionText } from '../src/renderer/src/collection-page'

const id = '0a984d5c-f82f-432b-a2cb-d9f0de465993'
const entry: CollectionListEntry = { id, display_name: '同名收集', status: 'collecting', created_at: '2026-10-05T01:00:00Z', completed_at: null,
  sessionCount: 2, itemCount: 4, successfulItems: 2, failedItems: 1, activeItems: 1, partialItems: 0 }
function detail(completed = false): CollectionDetail {
  return { collection: { ...entry, status: completed ? 'completed' : 'collecting', completed_at: completed ? '2026-10-05T02:00:00Z' : null },
    sessions: [{ id: '真实会话甲', collection_id: id, status: 'pending', created_at: entry.created_at, completed_at: null, stats: null,
      items: [{ id: '真实附件甲', ordinal: 0, status: 'failed', attachment_name: null, source_hint: null, error_summary: '真实失败信息',
        evidence_source_kind: 'directory', evidence_status: 'missing', evidenceRecorded: true, job: null }] },
    { id: '真实会话乙', collection_id: id, status: 'success', created_at: entry.created_at, completed_at: entry.created_at,
      stats: { imported: 12, duplicate: 3, updated: 2, invalid: 1 },
      items: [{ id: '真实附件乙', ordinal: 1, status: 'success', attachment_name: '卡片乙.zip', source_hint: '来源元数据', error_summary: null,
        evidence_source_kind: 'zip', evidence_status: 'available', evidenceRecorded: true,
        job: { id: '有效任务乙', status: 'success', imported: 12, duplicate: 3, updated: 2, invalid: 1 } }] }] }
}
function renderDetail(value = detail(), busy = false) {
  return renderToStaticMarkup(createElement(CollectionDetailView, { detail: value, busy, onCopy: vi.fn(), onComplete: vi.fn() }))
}

describe('批量收集最小界面契约', () => {
  it('空列表展示真实空态和开始按钮', () => {
    const html = renderToStaticMarkup(createElement(CollectionList, { entries: [], busy: false, onOpen: vi.fn(), onStart: vi.fn() }))
    expect(html).toContain('还没有批量收集记录'); expect(html).toContain('开始收集')
  })
  it('同名记录独立显示完整身份、真实时间与统计', () => {
    const another = { ...entry, id: 'd18ee2cb-40ab-4650-9d2a-9b90e3a59c1f' }
    const html = renderToStaticMarkup(createElement(CollectionList, { entries: [entry, another], busy: false, onOpen: vi.fn(), onStart: vi.fn() }))
    expect(html.match(/同名收集/g)).toHaveLength(2)
    expect(html).toContain(id); expect(html).toContain(another.id)
    expect(html).toContain('2 次导入 · 4 个附件')
    expect(html).toContain('成功 2 · 失败 1 · 待结束 1 · 部分成功 0')
    expect(html).toContain(entry.created_at)
  })
  it('详情显示完整 UUID，复制控件不使用短 ID', () => {
    const html = renderDetail()
    expect(html).toContain(`<code>${id}</code>`)
    expect(html).toContain('复制 Collection ID')
    expect(html).toContain(collectionImportCommand(id))
    expect(html).toContain('复制导入口令')
  })
  it.each([false, true])('复制内容精确使用完整身份，导入口令=%s', async (command) => {
    const clipboard = { writeText: vi.fn(async () => undefined) }
    await copyCollectionText(clipboard, id, command)
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(command ? `把本次两张聊天卡加入 Collection ${id}` : id)
  })
  it('剪贴板拒绝时不假报复制成功', async () => {
    await expect(copyCollectionText({ writeText: vi.fn(async () => { throw new Error('隔离复制失败') }) }, id)).rejects.toThrow('隔离复制失败')
  })
  it('多个真实会话、附件、当前有效任务与失败信息正确显示，不猜群名', () => {
    const html = renderDetail()
    for (const text of ['真实会话甲', '真实会话乙', '附件 1', '卡片乙.zip', '真实失败信息', '有效任务乙', '新增消息 12 · 重复 3 · 更新 2 · 无效 1', '尚无可用的导入任务统计', '导入任务：尚未创建', '目录快照 · 登记为缺失', 'ZIP 文件 · 已登记可用']) expect(html).toContain(text)
    expect(html.match(/<details/g)).toHaveLength(2)
    expect(html).toContain('不代表跨批去重后的唯一消息数')
    expect(html).not.toContain('群名')
  })
  it('收集中即使存在待处理会话也保留完成按钮，由服务端判定而非前端禁用', () => {
    const html = renderDetail()
    expect(html).toContain('收集中')
    expect(html).toMatch(/<button[^>]*>完成收集<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>完成收集/)
  })
  it('已完成显示完成时间与拒绝继续加入提示，仍保留历史但无完成和导入口令按钮', () => {
    const html = renderDetail(detail(true))
    expect(html).toContain('已完成'); expect(html).toContain('完成时间：')
    expect(html).toContain('此 Collection 已完成，不能继续加入新的聊天批次。')
    expect(html).toContain('真实会话甲')
    expect(html).not.toContain('>完成收集<'); expect(html).not.toContain('复制导入口令')
  })
  it('只将服务端未结束或已完成错误转成用户提示，不重新实现完成规则', () => {
    expect(collectionErrorMessage(new Error("Error invoking remote method 'collections:complete': 归集中仍有未终结的导入会话")))
      .toBe('还有导入任务未结束，暂时不能完成。')
    expect(collectionErrorMessage(new Error('COLLECTION_COMPLETED: 已完成的归集不能新增导入会话')))
      .toBe('此 Collection 已完成，不能继续加入新的聊天批次。')
    expect(collectionErrorMessage(new Error('其他真实错误'))).toBe('其他真实错误')
  })
  it('不增加删除、移动、重命名、重新打开、重试或物理 Evidence 导航', () => {
    const html = renderDetail()
    expect(html).not.toMatch(/>[^<]*(删除|移动|重命名|重新打开|重试|打开 Evidence)[^<]*<\/button>/)
    expect(html).not.toContain('<a ')
  })
  it('仅新增批量收集导航及创建入口，原四页和既有操作保留', () => {
    const source = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(source).toContain("['今日情报', '话题雷达', '问我的聊天', '设置', '批量收集']")
    expect(source).toContain("page === 'collections' && <CollectionPage />")
    for (const component of ['SearchPage', 'SettingsPage', 'RadarPage', 'MissingImportantFeedback']) expect(source).toContain(`export function ${component}`)
    const pageSource = readFileSync(new URL('../src/renderer/src/collection-page.tsx', import.meta.url), 'utf8')
    expect(pageSource).not.toMatch(/setInterval|askChat|SQLite|ingest|bindSession/)
    expect(pageSource).toContain('api.getCollection(id)')
    expect(pageSource).toContain('refresh(collection.id)')
  })
})
