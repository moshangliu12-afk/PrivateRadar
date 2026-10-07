export type CommitmentCandidateStatus = 'pending' | 'confirmed' | 'ignored'
export type CommitmentResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface CommitmentOccurrenceView {
  batchItemId: string; sourcePosition: number; messageId: string; body: string
  senderName: string | null; chatTimestamp: string | null; timestampSource: string | null
  conversationName: string | null
}
export interface CommitmentCandidateSource {
  batchItemId: string; attachmentName: string | null; ordinal: number
  evidenceKind: 'zip' | 'directory'
  evidenceStatus: 'pending' | 'available' | 'missing' | 'corrupt' | 'error'
  evidenceRecorded: boolean
}
export interface CommitmentCandidateReview {
  id: string; status: CommitmentCandidateStatus; reviewedAt: string | null
}
export interface CommitmentCandidateView extends CommitmentOccurrenceView, CommitmentCandidateReview {
  reasonCode: string; ruleId: string; ruleVersion: string; source: CommitmentCandidateSource
}
export interface CommitmentCandidateContext {
  candidateId: string; batchItemId: string
  entries: Array<CommitmentOccurrenceView & { isCurrent: boolean }>
}
export interface CommitmentDesktopApi {
  listCommitmentCandidates: () => Promise<CommitmentResult<CommitmentCandidateView[]>>
  confirmCommitmentCandidate: (id: string) => Promise<CommitmentResult<CommitmentCandidateReview>>
  ignoreCommitmentCandidate: (id: string) => Promise<CommitmentResult<CommitmentCandidateReview>>
  getCommitmentCandidateContext: (id: string) => Promise<CommitmentResult<CommitmentCandidateContext>>
  openCommitmentCandidateEvidence: (id: string) => Promise<CommitmentResult<{ batchItemId: string; opened: true }>>
}
