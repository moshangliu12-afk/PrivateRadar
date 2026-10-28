import type { ConversationNameInput } from './conversation-labels'
export type KeywordRadarResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export interface KeywordTermView { id: string; term: string; enabled: boolean }
export interface KeywordGroupView {
  id: string; name: string; enabled: boolean; archivedAt: string | null; terms: KeywordTermView[]
}
export interface KeywordRadarStatus { pending: number; failed: number }
export interface KeywordOccurrenceView extends ConversationNameInput {
  batchItemId: string; sourcePosition: number; messageId: string; body: string
  senderName: string | null; chatTimestamp: string | null; timestampSource: string | null
  conversationName: string | null
}
export interface KeywordHitSource {
  batchItemId: string; attachmentName: string | null; ordinal: number
  evidenceKind: 'zip' | 'directory'
  evidenceStatus: 'pending' | 'available' | 'missing' | 'corrupt' | 'error'
  evidenceRecorded: boolean
}
export interface KeywordHitView extends KeywordOccurrenceView {
  id: string; groupId: string; groupName: string; matchedTerms: string[]; matchedAt: string; source: KeywordHitSource
}
export interface KeywordHitContext {
  hitId: string; batchItemId: string; entries: Array<KeywordOccurrenceView & { isCurrent: boolean }>
}
export interface KeywordRetryResult { attempted: number; completed: number; status: KeywordRadarStatus }
export interface KeywordRadarDesktopApi {
  listGroups: () => Promise<KeywordRadarResult<KeywordGroupView[]>>
  createGroup: (name: string) => Promise<KeywordRadarResult<string>>
  renameGroup: (id: string, name: string) => Promise<KeywordRadarResult<null>>
  setGroupEnabled: (id: string, enabled: boolean) => Promise<KeywordRadarResult<null>>
  archiveGroup: (id: string) => Promise<KeywordRadarResult<null>>
  addTerm: (groupId: string, term: string) => Promise<KeywordRadarResult<{ id: string; outcome: 'created' | 'exists' | 'reenabled' }>>
  setTermEnabled: (id: string, enabled: boolean) => Promise<KeywordRadarResult<null>>
  listRecentHits: (limit?: number) => Promise<KeywordRadarResult<KeywordHitView[]>>
  getStatusCounts: () => Promise<KeywordRadarResult<KeywordRadarStatus>>
  retryFailedRuns: () => Promise<KeywordRadarResult<KeywordRetryResult>>
  getHitContext: (hitId: string) => Promise<KeywordRadarResult<KeywordHitContext>>
  getHitSource: (hitId: string) => Promise<KeywordRadarResult<KeywordHitSource>>
  openHitEvidence: (hitId: string) => Promise<KeywordRadarResult<{ batchItemId: string; opened: true }>>
}
