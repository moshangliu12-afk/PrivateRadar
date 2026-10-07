import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitmentDesktopApi } from '../src/shared/commitment'

const electron = vi.hoisted(() => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(async () => ({ ok: true })) } }))
vi.mock('electron', () => electron)
beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })

describe('承诺候选项预加载边界', () => {
  it('只暴露五个候选项动作，编号按固定通道传递，并保留既有接口', async () => {
    await import('../src/preload/index')
    const [name, root] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as unknown as [string, Record<string, any>]
    expect(name).toBe('privateRadar')
    const api = root.commitmentCandidates as CommitmentDesktopApi
    const id = '0a984d5c-f82f-432b-a2cb-d9f0de465993'
    await api.listCommitmentCandidates(); await api.confirmCommitmentCandidate(id); await api.ignoreCommitmentCandidate(id)
    await api.getCommitmentCandidateContext(id); await api.openCommitmentCandidateEvidence(id)
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      ['commitment-candidates:list'], ['commitment-candidates:confirm', id], ['commitment-candidates:ignore', id],
      ['commitment-candidates:context', id], ['commitment-candidates:open-evidence', id]
    ])
    expect(Object.keys(api)).toEqual([
      'listCommitmentCandidates', 'confirmCommitmentCandidate', 'ignoreCommitmentCandidate',
      'getCommitmentCandidateContext', 'openCommitmentCandidateEvidence'
    ])
    for (const key of ['executeSql', 'readFile', 'match', 'retryFailedRuns', 'reset', 'complete', 'replaceSnapshot']) expect(api).not.toHaveProperty(key)
    for (const key of ['askChat', 'getDashboardSummary', 'getTopicRadarSummary', 'listCollections']) expect(root[key]).toBeTypeOf('function')
    expect(root.keywordRadar.listRecentHits).toBeTypeOf('function')
  })
})
