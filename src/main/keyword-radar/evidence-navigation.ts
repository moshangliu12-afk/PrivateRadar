import type { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { getKeywordHitSource, KeywordRadarDesktopError } from './desktop'
import { verifyBatchEvidence } from '../batch-import/evidence'
import { WindowsPathLease, withRequestScopedWindowsPathLeaseRuntime } from '../batch-import/windows-path-lease'

/** 只接受 Hit 身份；从它的 Item 定位证据，绝不接受渲染层传来的文件路径。 */
export async function openKeywordHitEvidence(
  db: DatabaseSync, databasePath: string, hitId: unknown, openPath: (path: string) => Promise<string>
): Promise<{ batchItemId: string; opened: true }> {
  const source = getKeywordHitSource(db, hitId)
  if (!source.evidenceRecorded) throw new KeywordRadarDesktopError('EVIDENCE_UNAVAILABLE')
  return openBatchItemEvidence(db, databasePath, source.batchItemId, openPath)
}

/** 复用既有附件证据验证和导航；身份由各产品的来源适配器确定。 */
export async function openBatchItemEvidence(
  db: DatabaseSync, databasePath: string, batchItemId: string, openPath: (path: string) => Promise<string>
): Promise<{ batchItemId: string; opened: true }> {
  try {
    return await withRequestScopedWindowsPathLeaseRuntime(async () => {
      const verified = await verifyBatchEvidence(db, databasePath, batchItemId)
      if (verified.status !== 'available') throw new KeywordRadarDesktopError('EVIDENCE_UNAVAILABLE')
      const directory = join(resolve(dirname(databasePath)), 'evidence', batchItemId)
      const lease = new WindowsPathLease()
      try {
        // 打开固定的附件目录而非执行源文件；复用原生路径防护直到导航结束。
        await lease.lock(directory, true)
        if (await openPath(directory)) throw new KeywordRadarDesktopError('EVIDENCE_UNAVAILABLE')
        return { batchItemId, opened: true as const }
      } finally { await lease.close(); lease.assertReleased() }
    })
  } catch { throw new KeywordRadarDesktopError('EVIDENCE_UNAVAILABLE') }
}
