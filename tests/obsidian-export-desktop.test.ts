import { DatabaseSync } from 'node:sqlite'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OBSIDIAN_VAULT_SETTING, readObsidianVaultPath, registerObsidianExportIpc } from '../src/main/export/obsidian-desktop'
import type { ObsidianExportApi } from '../src/shared/obsidian-export'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'

const electron = vi.hoisted(() => ({ invoke: vi.fn(), exposeInMainWorld: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: { invoke: electron.invoke } }))
afterEach(() => { cleanupExportFixtures(); vi.restoreAllMocks() })
function setup() {
  const f = exportFixture(); f.add('消息')
  const handlers = new Map<string, (event: unknown, ...args: any[]) => any>()
  const desktop = { chooseDirectory: vi.fn(async (): Promise<string | null> => f.output), openDirectory: vi.fn(async () => '') }
  registerObsidianExportIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, f.db, f.databasePath, desktop)
  const call = (name: string, ...args: any[]) => handlers.get('obsidian-export:' + name)!(null, ...args)
  const request = { conversation_ids: ['导出会话'], range: f.request.range }
  return { ...f, desktop, call, request }
}
describe('Obsidian 桌面通信边界', () => {
  it('预加载只传递选择范围，不接收界面提供的 Vault 或数据库路径', async () => {
    await import('../src/preload/index')
    const api = electron.exposeInMainWorld.mock.calls[0][1].obsidianExport as ObsidianExportApi
    const request = { conversation_ids: ['会话'], range: { type: 'conversation' as const, start_date: null, end_date: null } }
    await api.settings(); await api.chooseVault(); await api.start(request); await api.cancel(); await api.openOutput()
    expect(electron.invoke.mock.calls).toEqual([
      ['obsidian-export:settings'], ['obsidian-export:choose-vault'], ['obsidian-export:start', request],
      ['obsidian-export:cancel'], ['obsidian-export:open-output']
    ])
  })
})
describe.skipIf(process.platform !== 'win32')('Vault 设置及真实导出接线', () => {
  it('未选目录时拒绝导出；取消选择保留原设置且不触碰源消息', async () => {
    const f = setup(), before = sourceFingerprint(f.db)
    expect(await f.call('settings')).toEqual({ ok: true, value: { path: null, supported: true } })
    expect(await f.call('start', f.request)).toMatchObject({ ok: false, error: { code: 'INVALID_SELECTION' } })
    f.desktop.chooseDirectory.mockResolvedValueOnce(null)
    expect(await f.call('choose-vault', 'C:\\不应使用界面路径')).toEqual({ ok: true, value: null })
    expect(readObsidianVaultPath(f.db)).toBe(null)
    expect(sourceFingerprint(f.db)).toEqual(before)
  })
  it('经原生选择和校验后只写 app_settings；新连接加载同一设置', async () => {
    const f = setup(), before = sourceFingerprint(f.db)
    const previousSettings = f.db.prepare('SELECT * FROM app_settings WHERE key<>? ORDER BY key').all(OBSIDIAN_VAULT_SETTING)
    expect(await f.call('choose-vault', 'C:\\忽略')).toEqual({ ok: true, value: f.output })
    const reopened = new DatabaseSync(f.databasePath)
    try { expect(readObsidianVaultPath(reopened)).toBe(f.output) } finally { reopened.close() }
    expect(f.db.prepare('SELECT * FROM app_settings WHERE key<>? ORDER BY key').all(OBSIDIAN_VAULT_SETTING)).toEqual(previousSettings)
    expect(sourceFingerprint(f.db)).toEqual(before)
    f.desktop.chooseDirectory.mockResolvedValueOnce(null)
    await f.call('choose-vault')
    expect(readObsidianVaultPath(f.db)).toBe(f.output)
    const result = await f.call('start', { ...f.request, vault: 'C:\\忽略', databasePath: 'C:\\忽略.db' })
    expect(result).toMatchObject({ ok: true, value: { created: 1, failed: 0 } })
    expect(await f.call('open-output', 'C:\\忽略')).toEqual({ ok: true, value: null })
    expect(f.desktop.openDirectory).toHaveBeenCalledExactlyOnceWith(join(f.output, 'PrivateRadar'))
  }, 30000)
  it('失效的已保存目录明确失败，不改路径，不建立替代数据库', async () => {
    const f = setup(); await f.call('choose-vault')
    const moved = join(f.root, '迁走的Vault')
    expect(moved.startsWith(f.root + '\\')).toBe(true)
    renameSync(f.output, moved)
    const result = await f.call('start', f.request)
    expect(result).toMatchObject({ ok: false, error: { code: 'EXPORT_PATH_UNSAFE' } })
    expect(result.error.message).toContain('Vault 不可用')
    expect(readObsidianVaultPath(f.db)).toBe(f.output)
    expect(JSON.stringify(result)).not.toContain(f.databasePath)
  })
  it('拒绝并发任务，取消不遗留读取连接或伪成功', async () => {
    const f = setup(); await f.call('choose-vault')
    const first = f.call('start', f.request)
    expect(await f.call('start', f.request)).toMatchObject({ ok: false, error: { code: 'EXPORT_BUSY' } })
    expect(await f.call('choose-vault')).toMatchObject({ ok: false, error: { code: 'EXPORT_BUSY' } })
    expect(await f.call('cancel')).toEqual({ ok: true, value: null })
    expect(await first).toMatchObject({ ok: true, value: { status: 'cancelled', created: 0 } })
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }, 30000)
  it('无效选择返回有限错误且不向界面泄漏数据库路径', async () => {
    const f = setup(); await f.call('choose-vault')
    for (const request of [null, { ...f.request, conversation_ids: [] }, { ...f.request, conversation_ids: ['导出会话', '导出会话'] },
      { ...f.request, range: { type: 'date_range', start_date: '错误', end_date: '2026-10-01' } }]) {
      const result = await f.call('start', request)
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_SELECTION' } })
      expect(JSON.stringify(result)).not.toContain(f.databasePath)
    }
  })
})
