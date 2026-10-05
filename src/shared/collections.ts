export interface CollectionRecord {
  id: string
  display_name: string
  status: 'collecting' | 'completed'
  created_at: string
  completed_at: string | null
}

export type CollectionImportStatus = 'pending' | 'preparing' | 'in_progress' | 'success' | 'partial_success' | 'failed'

export interface CollectionListEntry extends CollectionRecord {
  sessionCount: number
  itemCount: number
  successfulItems: number
  failedItems: number
  activeItems: number
  partialItems: number
}

export interface CollectionJobStats {
  imported: number
  duplicate: number
  updated: number
  invalid: number
}

export interface CollectionItemView {
  id: string
  ordinal: number
  attachment_name: string | null
  source_hint: string | null
  status: CollectionImportStatus
  error_summary: string | null
  evidence_source_kind: 'zip' | 'directory'
  evidence_status: 'pending' | 'available' | 'missing' | 'corrupt' | 'error'
  evidenceRecorded: boolean
  job: (CollectionJobStats & { id: string; status: string }) | null
}

export interface CollectionSessionView {
  id: string
  collection_id: string | null
  status: CollectionImportStatus
  created_at: string
  completed_at: string | null
  items: CollectionItemView[]
  // 仅当前有效任务的结果，不是历次任务累计值，也不是归集唯一消息数。
  stats: CollectionJobStats | null
}

export interface CollectionDetail {
  collection: CollectionRecord
  sessions: CollectionSessionView[]
}

export interface CollectionDesktopApi {
  createCollection: (displayName: string) => Promise<CollectionRecord>
  listCollections: () => Promise<CollectionListEntry[]>
  getCollection: (collectionId: string) => Promise<CollectionDetail | null>
  listCollectionSessions: (collectionId: string) => Promise<CollectionSessionView[]>
  completeCollection: (collectionId: string) => Promise<CollectionRecord>
}
