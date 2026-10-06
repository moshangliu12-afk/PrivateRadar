import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { KeywordGroupView, KeywordHitContext, KeywordHitView, KeywordRadarDesktopApi } from '../src/shared/keyword-radar'
import { KeywordRadarContent, KeywordHitCard, KeywordContext, keywordRadarError } from '../src/renderer/src/keyword-radar-page'

const api = {} as KeywordRadarDesktopApi
const group: KeywordGroupView = { id: '组', name: '拼车', enabled: true, archivedAt: null, terms: [{ id: '词', term: '南京', enabled: true }] }
const hit: KeywordHitView = { id: '命中', groupId: '组', groupName: '历史工具组', matchedTerms: ['Codex', 'MCP'], matchedAt: '2026-10-06T12:00:00Z', batchItemId: '附件乙', sourcePosition: 5,
  messageId: '共享正文', body: '真实 fixture 正文 [图片]', senderName: '来源乙', chatTimestamp: '2026-10-06T02:20:00Z', timestampSource: 'source_native', conversationName: '乙群',
  source: { batchItemId: '附件乙', attachmentName: '乙卡片.zip', ordinal: 1, evidenceKind: 'zip', evidenceStatus: 'available', evidenceRecorded: true } }
const render = (groups: KeywordGroupView[] = [], hits: KeywordHitView[] = [], pending = 0, failed = 0, retrying = false) => renderToStaticMarkup(createElement(KeywordRadarContent, {
  groups, hits, status: { pending, failed }, api, refreshGroups: async () => {}, retry: () => {}, retrying
}))
describe('关键词雷达展示契约', () => {
  it('只有关键词设置和最近命中两区，空状态解释未来匹配边界', () => {
    const html = render()
    expect(html.match(/<section /g)).toHaveLength(2)
    for (const text of ['关键词设置', '最近命中', '还没有设置关键词', '还没有命中记录', '不扫描以前的聊天记录', '规则修改只影响之后新导入的聊天']) expect(html).toContain(text)
    expect(html).not.toMatch(/keyword-pending|keyword-failed|热度|趋势图|仪表盘/)
  })
  it('关键词组和词可启停，停用状态、表单标签、归档入口明确，无关键词原地编辑', () => {
    const html = render([group, { ...group, id: '停用组', enabled: false, terms: [{ id: '停用词', term: '光山', enabled: false }] }])
    for (const text of ['已启用', '已停用', '停用组', '启用组', '添加关键词', '改组名', '归档', 'aria-pressed="true"', 'aria-pressed="false"', '启用关键词 光山']) expect(html).toContain(text)
    expect(html).not.toContain('修改关键词')
  })
  it('归档保留折叠卡片，但无启用、恢复或编辑入口', () => {
    const html = render([{ ...group, archivedAt: '2026-10-06T12:00Z', enabled: false }])
    expect(html).toContain('已归档关键词组（1）')
    expect(html).toContain('南京')
    expect(html).not.toMatch(/>启用组<|>恢复<|>改组名<|>添加<|aria-label="停用关键词/)
  })
  it('B 来源卡片完整展示全部历史词、组名、正文与 B 的事实', () => {
    const html = render([group], [hit])
    for (const text of ['历史工具组', 'Codex', 'MCP', '来源乙', '乙群', '乙卡片.zip', '[图片]', '发现时间', '查看上下文', '查看证据']) expect(html).toContain(text)
    expect(html).not.toContain('<h3>拼车</h3><small>发现时间')
  })
  it('unknown sender/time/conversation 明确展示，不拿发现时间补聊天时间', () => {
    const html = renderToStaticMarkup(createElement(KeywordHitCard, { hit: { ...hit, senderName: null, chatTimestamp: null, conversationName: null }, api }))
    for (const text of ['发送人未知', '聊天时间未知', '会话未知']) expect(html).toContain(text)
  })
  it('未登记 Evidence 禁用导航，不宣称可用', () => {
    const html = renderToStaticMarkup(createElement(KeywordHitCard, { hit: { ...hit, source: { ...hit.source, evidenceRecorded: false } }, api }))
    expect(html).toContain('证据未登记')
    expect(html).toContain('<button type="button" disabled="">查看证据</button>')
    expect(html).not.toContain('证据已登记可用')
  })
  it('长正文可展开，正文和名字转义，不做关键词 offset 高亮或 OCR', () => {
    const html = renderToStaticMarkup(createElement(KeywordHitCard, { hit: { ...hit, body: '<script>危险</script>' + '正文'.repeat(350) }, api }))
    expect(html).toContain('展开正文')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toMatch(/<script>|<mark>|OCR/)
  })
  it('pending=2 和 failed=3 提示分离，只明确说关键词处理失败', () => {
    const html = render([group], [], 2, 3)
    expect(html).toContain('有 2 个导入批次正在等待关键词检查。')
    expect(html).toContain('有 3 个导入批次的关键词处理失败。')
    expect(html).toContain('重新处理')
    expect(html).not.toContain('聊天导入失败')
  })
  it('重试忙状态禁用按钮，不重复触发', () => {
    expect(render([group], [], 0, 3, true)).toContain('<button type="button" disabled="">处理中…</button>')
  })
  it('上下文使用真实 source_position，高亮当前 occurrence 而非关键词', () => {
    const context: KeywordHitContext = { hitId: hit.id, batchItemId: hit.batchItemId, entries: [0, 2, 5].map(position => ({ ...hit, sourcePosition: position, isCurrent: position === 5 })) }
    const html = renderToStaticMarkup(createElement(KeywordContext, { context }))
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
    for (const position of [0, 2, 5]) expect(html).toContain(`来源位置 ${position}`)
    expect(html).not.toContain('来源位置 1')
    expect(html).toContain('当前命中')
  })
  it('固定错误词表，未知异常不暴露 SQLite、路径或正文', () => {
    expect(keywordRadarError(new Error('EVIDENCE_UNAVAILABLE'))).toBe('该附件的证据暂不可用，未打开其他来源。')
    expect(keywordRadarError(new Error('SQLite C:\\秘密目录 私聊正文'))).toBe('关键词雷达操作未完成，请稍后重试。')
    for (const message of ['constructor', '__proto__', 'toString']) expect(keywordRadarError(new Error(message))).toBe('关键词雷达操作未完成，请稍后重试。')
  })
  it('复用真实样式变量，焦点与停用状态明确', () => {
    const css = readFileSync(new URL('../src/renderer/src/keyword-radar-page.css', import.meta.url), 'utf8')
    const shared = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    for (const match of css.matchAll(/var\((--[\w-]+)\)/g)) expect(shared).toContain(match[1] + ':')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('button:disabled')
    expect(css).toContain('.keyword-chip.is-disabled')
  })
  it('独立导航接入，Renderer 不访问 SQLite、不匹配、不轮询或启动 recovery', () => {
    const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain("'关键词雷达'")
    expect(app).toContain("page === 'keywords' && <KeywordRadarPage />")
    const source = readFileSync(new URL('../src/renderer/src/keyword-radar-page.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/setInterval|setTimeout|substring|matchKeyword|processPending|retryKeywordRadarRun|node:sqlite|askChat|getTopicRadar|getDashboard/)
    expect(source).toContain('api.retryFailedRuns()')
    expect(source).toContain('api.listRecentHits(100)')
    expect(source).toContain('归档后不会再匹配新的聊天，已有命中记录仍会保留。')
  })
})
