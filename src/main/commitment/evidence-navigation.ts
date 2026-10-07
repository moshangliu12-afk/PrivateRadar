import type { DatabaseSync } from 'node:sqlite'
import { openBatchItemEvidence } from '../keyword-radar/evidence-navigation'
import { CommitmentDesktopError, getCommitmentCandidateSource } from './desktop'

/** 候选项只适配当前来源附件；验证与打开沿用已有附件证据后端。 */
export async function openCommitmentCandidateEvidence(
  db: DatabaseSync, databasePath: string, id: unknown, openPath: (path: string) => Promise<string>
): Promise<{ batchItemId: string; opened: true }> {
  const source = getCommitmentCandidateSource(db, id)
  if (!source.evidenceRecorded) throw new CommitmentDesktopError('EVIDENCE_UNAVAILABLE')
  try { return await openBatchItemEvidence(db, databasePath, source.batchItemId, openPath) }
  catch { throw new CommitmentDesktopError('EVIDENCE_UNAVAILABLE') }
}
