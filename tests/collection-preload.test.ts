import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollectionDesktopApi } from '../src/shared/collections'

const electron = vi.hoisted(() => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(async () => ({ isolated: true })) } }))
vi.mock('electron', () => electron)

beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
describe('归集预加载只暴露最小类型化 API', () => {
  it('五个方法原样转交完整 ID 或名称，既有 API 保留，无任意 SQL 或重试接口', async () => {
    await import('../src/preload/index')
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledOnce()
    const [name, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as unknown as [string, CollectionDesktopApi & Record<string, unknown>]
    expect(name).toBe('privateRadar')
    const id = '0a984d5c-f82f-432b-a2cb-d9f0de465993'
    await api.createCollection('  同名  '); await api.listCollections(); await api.getCollection(id)
    await api.listCollectionSessions(id); await api.completeCollection(id)
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['collections:create', '  同名  '], ['collections:list'], ['collections:get', id], ['collections:sessions', id], ['collections:complete', id]
    ])
    for (const key of ['askChat', 'getDashboardSummary', 'getTopicRadarSummary', 'getFirstUseStatus', 'chooseAndImportFile']) expect(api[key]).toBeTypeOf('function')
    for (const key of ['deleteCollection', 'bindSession', 'retryItem', 'executeSql']) expect(api).not.toHaveProperty(key)
  })
})
