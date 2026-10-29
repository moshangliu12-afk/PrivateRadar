import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerContextHandoffIpc } from '../src/main/export/context-handoff-desktop'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'
import type { ContextHandoffApi } from '../src/shared/context-handoff'

const electron = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.expose }, ipcRenderer: { invoke: electron.invoke } }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanupExportFixtures() })
function setup() {
  const f = exportFixture(); f.add('消息', '中文😀\n原始正文'); f.evidence('消息')
  const handlers = new Map<string, (event: unknown, ...args: any[]) => any>()
  const desktop = { chooseDirectory: vi.fn(async (): Promise<string | null> => f.output), openDirectory: vi.fn(async () => ''), writeClipboard: vi.fn() }
  registerContextHandoffIpc({ handle: (name, fn) => handlers.set(name, fn) }, f.databasePath, '测试版本', desktop)
  const call = (name: string, ...args: any[]) => handlers.get('context-handoff:' + name)!(null, ...args)
  return { ...f, call, desktop, selection: { message_ids: ['消息'] } }
}
describe('上下文桌面边界', () => {
  it('预览只读原始消息，自动携带真实关联证据，不信任调用方正文', async () => {
    const f = setup(), before = sourceFingerprint(f.db)
    const result = await f.call('preview', { ...f.selection, content: '伪造正文', databasePath: '不存在的库' })
    expect(result.ok).toBe(true)
    expect(result.value.snapshot.items[0]).toMatchObject({ id: '消息', content: '中文😀\n原始正文', displayConversationName: '用户项目组', sourceConversationName: '来源群' })
    expect(result.value.snapshot.evidence).toHaveLength(1)
    expect(result.value.markdown).not.toContain('伪造正文')
    expect(sourceFingerprint(f.db)).toEqual(before)
  })
  it('复制仅将主进程生成的 Markdown 写入原生剪贴板适配器', async () => {
    const f = setup(), network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止联网'))
    expect(await f.call('copy-markdown', f.selection)).toEqual({ ok: true, value: null })
    const text = f.desktop.writeClipboard.mock.calls[0][0] as string
    expect(text).toContain('中文😀\n原始正文')
    expect(text).toContain('来源群')
    expect(text).toContain('消息')
    expect(network).not.toHaveBeenCalled()
  })
  it('剪贴板失败返回明确安全错误，源数据不变，之后可重试', async () => {
    const f = setup(), before = sourceFingerprint(f.db)
    f.desktop.writeClipboard.mockImplementationOnce(() => { throw Error('内部路径和权限详情') })
    const result = await f.call('copy-markdown', f.selection)
    expect(result).toMatchObject({ ok: false, error: { code: 'EXPORT_IO_ERROR' } })
    expect(JSON.stringify(result)).not.toContain('内部路径')
    expect(sourceFingerprint(f.db)).toEqual(before)
    expect(await f.call('copy-markdown', f.selection)).toMatchObject({ ok: true })
  })
  it('无效或失效选择不复制正文、不泄漏 SQL 或原库路径', async () => {
    const f = setup()
    for (const selection of [null, {}, { message_ids: [] }, { message_ids: ["' OR 1=1 --"] }]) {
      const result = await f.call('preview', selection)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(f.databasePath)
    }
    expect(f.desktop.writeClipboard).not.toHaveBeenCalled()
  })
  it('同一时刻仅一个操作，取消释放只读事务，不修改数据库', async () => {
    const f = setup(), before = sourceFingerprint(f.db)
    const first = f.call('preview', f.selection)
    expect(await f.call('copy-markdown', f.selection)).toMatchObject({ ok: false, error: { code: 'EXPORT_BUSY' } })
    expect(await f.call('cancel')).toEqual({ ok: true, value: null })
    expect(await first).toMatchObject({ ok: false, error: { code: 'EXPORT_CANCELLED' } })
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    expect(sourceFingerprint(f.db)).toEqual(before)
    expect(await f.call('preview', f.selection)).toMatchObject({ ok: true })
  })
  it('目录来自原生选择器，取消或非法格式不会发布文件', async () => {
    const f = setup()
    expect(await f.call('export', f.selection, 'markdown')).toMatchObject({ ok: false, error: { code: 'INVALID_SELECTION' } })
    f.desktop.chooseDirectory.mockResolvedValueOnce(null)
    expect(await f.call('choose-directory', 'C:\\界面任意路径')).toEqual({ ok: true, value: null })
    await f.call('choose-directory')
    expect(await f.call('export', f.selection, 'pdf')).toMatchObject({ ok: false, error: { code: 'INVALID_SELECTION' } })
    expect(readdirSync(f.output)).toEqual([])
  })
  it('preload 仅暴露最小上下文方法和选择条件，不接受数据库或输出路径', async () => {
    electron.invoke.mockClear()
    await import('../src/preload/index')
    const api = electron.expose.mock.calls[0][1].contextHandoff as ContextHandoffApi
    const selection = { message_ids: ['消息'] }
    await api.preview(selection); await api.copyMarkdown(selection); await api.chooseDirectory(); await api.export(selection, 'markdown'); await api.export(selection, 'json'); await api.cancel(); await api.openOutput()
    expect(electron.invoke.mock.calls).toEqual([
      ['context-handoff:preview', selection], ['context-handoff:copy-markdown', selection], ['context-handoff:choose-directory'],
      ['context-handoff:export', selection, 'markdown'], ['context-handoff:export', selection, 'json'], ['context-handoff:cancel'], ['context-handoff:open-output']
    ])
  })
})
describe.skipIf(process.platform !== 'win32')('上下文实际安全文件导出', () => {
  it.each(['markdown', 'json'])('%s 输出正确、重复跳过、用户修改后另存版本，原库与关系不变', async format => {
    const f = setup(), before = sourceFingerprint(f.db), network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止联网'))
    await f.call('choose-directory')
    const first = await f.call('export', { ...f.selection, directory: 'C:\\忽略路径', content: '伪造' }, format)
    expect(first).toMatchObject({ ok: true, value: { status: 'created', messageCount: 1 } })
    const target = first.value.directory as string
    const filename = readdirSync(target).find(name => name !== 'export.json')!
    expect(filename).toMatch(/^PrivateRadar-AI-Context-[a-f0-9]{12}\.(md|json)$/)
    const content = readFileSync(join(target, filename), 'utf8')
    if (format === 'json') expect(JSON.parse(content).items[0].content).toBe('中文😀\n原始正文')
    else expect(content).toContain('中文😀\n原始正文')
    const metadata = JSON.parse(readFileSync(join(target, 'export.json'), 'utf8'))
    expect(metadata.context_projection.items[0]).not.toHaveProperty('content')
    expect(metadata.context_projection.items[0].content_sha256).toMatch(/^[a-f0-9]{64}$/)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2030-01-01T02:00:00.000Z'))
    expect(await f.call('export', f.selection, format)).toMatchObject({ ok: true, value: { status: 'unchanged', directory: target } })
    writeFileSync(join(target, filename), '用户编辑内容')
    expect(await f.call('export', f.selection, format)).toMatchObject({ ok: true, value: { status: 'created', directory: target + '--v2' } })
    expect(readFileSync(join(target, filename), 'utf8')).toBe('用户编辑内容')
    expect(await f.call('open-output', 'C:\\忽略路径')).toEqual({ ok: true, value: null })
    expect(f.desktop.openDirectory).toHaveBeenCalledWith(target + '--v2')
    expect(sourceFingerprint(f.db)).toEqual(before)
    expect(readdirSync(f.data).filter(name => name.endsWith('.db'))).toEqual(['private-radar.db'])
    expect(network).not.toHaveBeenCalled()
  }, 30000)
  it('目标位于原数据目录时拒绝写入；路径穿越在选择阶段即拒绝', async () => {
    const f = setup()
    f.desktop.chooseDirectory.mockResolvedValueOnce('C:\\路径\\..\\越界')
    expect(await f.call('choose-directory')).toMatchObject({ ok: false, error: { code: 'EXPORT_PATH_UNSAFE' } })
    expect(await f.call('open-output')).toMatchObject({ ok: false })
    f.desktop.chooseDirectory.mockResolvedValueOnce(f.data)
    await f.call('choose-directory')
    expect(await f.call('export', f.selection, 'json')).toMatchObject({ ok: false, error: { code: 'EXPORT_PATH_UNSAFE' } })
  })
  it('取消导出返回取消反馈，不留下半成品', async () => {
    const f = setup(); await f.call('choose-directory')
    const first = f.call('export', f.selection, 'markdown')
    await f.call('cancel')
    expect(await first).toMatchObject({ ok: true, value: { status: 'cancelled', directory: null } })
    expect(readdirSync(f.output)).toEqual([])
  })
})
