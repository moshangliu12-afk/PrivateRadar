import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import { WindowsPathLease } from '../src/main/batch-import/windows-path-lease'
import { registerMarkdownExportIpc } from '../src/main/export/markdown-export'
import type { MarkdownExportApi } from '../src/shared/markdown-export'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'

const electron = vi.hoisted(() => ({ invoke: vi.fn(), exposeInMainWorld: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: { invoke: electron.invoke } }))

// 通信、取消及只读查询使用真实临时数据库。非 Windows runner 只替换目录
// 选择的词法依赖，避免在到达通信断言前失败；不模拟任何原生租约或文件发布。
vi.mock('../src/main/batch-import/windows-path-lease', async original => {
  const actual = await original<typeof import('../src/main/batch-import/windows-path-lease')>()
  return { ...actual, safeAbsolutePath: (value: string) => {
    if (process.platform === 'win32') return actual.safeAbsolutePath(value)
    if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f]/.test(value) || value.split(/[\\/]/).includes('..')) throw new Error('测试路径必须位于本机绝对目录')
    return resolve(value)
  } }
})
afterEach(() => { vi.restoreAllMocks(); cleanupExportFixtures() })
function setup() {
  const f = exportFixture(); f.add('消息')
  const handlers = new Map<string, (event: unknown, ...args: any[]) => any>()
  const desktop = { chooseDirectory: vi.fn(async (): Promise<string | null> => f.output), openDirectory: vi.fn(async () => '') }
  registerMarkdownExportIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, f.db, f.databasePath, '测试版本', desktop)
  const call = (name: string, ...args: any[]) => handlers.get('markdown-export:' + name)!(null, ...args)
  return { ...f, call, desktop }
}
describe('导出桌面通信边界', () => {
  it('会话列表使用现有标签，读取不修改源库，目录只能来自原生选择器', async () => {
    const f = setup(), before = sourceFingerprint(f.db)
    expect(await f.call('conversations')).toMatchObject({ ok: true, value: [{ conversationId: '导出会话', sourceConversationName: '来源群', userConversationLabel: '用户项目组', displayConversationName: '用户项目组', messageCount: 1 }] })
    expect(await f.call('start', f.request)).toMatchObject({ ok: false, error: { code: 'INVALID_SELECTION' } })
    f.desktop.chooseDirectory.mockResolvedValueOnce(null)
    expect(await f.call('choose-directory', 'C:\\来自界面的路径')).toEqual({ ok: true, value: null })
    expect(await f.call('start', f.request)).toMatchObject({ ok: false })
    expect(sourceFingerprint(f.db)).toEqual(before)
  })
  it('单任务防重入、取消释放读取事务，输出打开不接受界面提供的任意路径', async () => {
    const lock = vi.spyOn(WindowsPathLease.prototype, 'lock')
    const f = setup()
    await f.call('choose-directory')
    const first = f.call('start', f.request)
    expect(await f.call('start', f.request)).toMatchObject({ ok: false, error: { code: 'EXPORT_BUSY' } })
    expect(await f.call('cancel')).toEqual({ ok: true, value: null })
    expect(await first).toMatchObject({ ok: true, value: { status: 'cancelled', directory: null } })
    expect(await f.call('open-output', 'C:\\不应打开')).toMatchObject({ ok: false })
    expect(f.desktop.openDirectory).not.toHaveBeenCalled()
    expect(lock).not.toHaveBeenCalled()
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  })
  it('无效输入或缺失会话返回安全错误，不向界面泄漏数据库路径或 SQL', async () => {
    const f = setup(); await f.call('choose-directory')
    const result = await f.call('start', { ...f.request, conversation_id: "' OR 1=1 --" })
    expect(result).toMatchObject({ ok: false, error: { code: 'CONVERSATION_NOT_FOUND' } })
    expect(JSON.stringify(result)).not.toContain(f.databasePath)
    expect(await f.call('start', null)).toMatchObject({ ok: false, error: { code: 'INVALID_SELECTION' } })
  })
  it('preload 只转发选择条件和操作，不接收输出路径或数据库路径', async () => {
    await import('../src/preload/index')
    const api = electron.exposeInMainWorld.mock.calls[0][1].markdownExport as MarkdownExportApi
    const request = { conversation_id: '会话', range: { type: 'conversation' as const, start_date: null, end_date: null } }
    await api.listConversations(); await api.chooseDirectory(); await api.start(request); await api.cancel(); await api.openOutput()
    expect(electron.invoke.mock.calls).toEqual([['markdown-export:conversations'], ['markdown-export:choose-directory'], ['markdown-export:start', request], ['markdown-export:cancel'], ['markdown-export:open-output']])
    await api.start({ ...request, format: 'json' }); await api.start({ ...request, format: 'txt' })
    expect(electron.invoke.mock.calls.slice(-2)).toEqual([['markdown-export:start', { ...request, format: 'json' }], ['markdown-export:start', { ...request, format: 'txt' }]])
  })
  it.skipIf(process.platform !== 'win32')('桌面完整成功链只打开刚刚生成的结果目录，不接受调用方替换路径', async () => {
    const f = setup(); await f.call('choose-directory')
    const result = await f.call('start', f.request)
    expect(result).toMatchObject({ ok: true, value: { status: 'created', messageCount: 1 } })
    expect(await f.call('open-output', 'C:\\其他目录')).toEqual({ ok: true, value: null })
    expect(f.desktop.openDirectory).toHaveBeenCalledExactlyOnceWith(result.value.directory)
  })
})
