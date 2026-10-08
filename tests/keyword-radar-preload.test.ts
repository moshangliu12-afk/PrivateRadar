import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeywordRadarDesktopApi } from '../src/shared/keyword-radar'
const electron = vi.hoisted(() => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(async () => ({ ok: true })) } }))
vi.mock('electron', () => electron)
beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })
describe('关键词雷达类型化预加载边界', () => {
  it('关注词 Today 使用独立窄通道，不读取旧摘要或触发处理', async () => {
    await import('../src/preload/index')
    const [, root] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as unknown as [string, Record<string, any>]
    await root.getTodayKeywordInterest()
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([['dashboard:keyword-interest']])
  })
  it('仅开放 13 个产品动作，原接口保留，不开放路径或 SQL', async () => {
    await import('../src/preload/index')
    const [name, root] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as unknown as [string, Record<string, any>]
    expect(name).toBe('privateRadar')
    const api = root.keywordRadar as KeywordRadarDesktopApi, id = '0a984d5c-f82f-432b-a2cb-d9f0de465993'
    await api.listGroups(); await api.createGroup('拼车'); await api.renameGroup(id, '出行'); await api.setGroupEnabled(id, false)
    await api.archiveGroup(id); await api.addTerm(id, '南京'); await api.setTermEnabled(id, true)
    await api.listRecentHits(100); await api.getStatusCounts(); await api.retryFailedRuns(); await api.getHitContext(id); await api.getHitSource(id); await api.openHitEvidence(id)
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['keyword-radar:groups'], ['keyword-radar:create-group', '拼车'], ['keyword-radar:rename-group', id, '出行'], ['keyword-radar:group-enabled', id, false],
      ['keyword-radar:archive-group', id], ['keyword-radar:add-term', id, '南京'], ['keyword-radar:term-enabled', id, true], ['keyword-radar:hits', 100],
      ['keyword-radar:status'], ['keyword-radar:retry-failed'], ['keyword-radar:context', id], ['keyword-radar:source', id], ['keyword-radar:open-evidence', id]
    ])
    expect(Object.keys(api)).toHaveLength(13)
    for (const key of ['executeSql', 'readFile', 'markComplete', 'markFailed', 'replaceSnapshot', 'match']) expect(api).not.toHaveProperty(key)
    for (const key of ['askChat', 'getDashboardSummary', 'getTopicRadarSummary', 'listCollections']) expect(root[key]).toBeTypeOf('function')
  })
})
