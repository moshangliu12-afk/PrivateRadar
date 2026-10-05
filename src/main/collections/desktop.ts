import type { DatabaseSync } from 'node:sqlite'
import type { CollectionDetail, CollectionItemView, CollectionListEntry, CollectionSessionView } from '../../shared/collections'
import { collectionIdSchema } from './repository'
import { createCollection, completeCollection, getCollection, listCollectionSessions } from './service'

export function listDesktopCollections(db: DatabaseSync): CollectionListEntry[] {
  return db.prepare(`
    SELECT c.*,
      COUNT(DISTINCT s.id) AS sessionCount, COUNT(i.id) AS itemCount,
      SUM(CASE WHEN i.status = 'success' THEN 1 ELSE 0 END) AS successfulItems,
      SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failedItems,
      SUM(CASE WHEN i.status IN ('pending', 'preparing', 'in_progress') THEN 1 ELSE 0 END) AS activeItems,
      SUM(CASE WHEN i.status = 'partial_success' THEN 1 ELSE 0 END) AS partialItems
    FROM collections c
    LEFT JOIN batch_import_sessions s ON s.collection_id = c.id
    LEFT JOIN batch_import_items i ON i.batch_session_id = s.id
    GROUP BY c.id ORDER BY c.created_at DESC, c.id
  `).all() as unknown as CollectionListEntry[]
}

export function getDesktopCollection(db: DatabaseSync, collectionId: string): CollectionDetail | null {
  collectionIdSchema.parse(collectionId)
  // 短只读事务保证归集状态、会话和附件来自同一数据库快照，不验证或访问物理证据。
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN')
  try {
    const collection = getCollection(db, collectionId)
    const result = collection ? { collection, sessions: listDesktopCollectionSessions(db, collectionId) } : null
    if (ownsTransaction) db.exec('COMMIT')
    return result
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK')
    throw error
  }
}

export function listDesktopCollectionSessions(db: DatabaseSync, collectionId: string): CollectionSessionView[] {
  collectionIdSchema.parse(collectionId)
  return listCollectionSessions(db, collectionId).map((session) => {
    const rows = db.prepare(`
      SELECT i.id, i.ordinal, i.attachment_name, i.source_hint, i.status, i.error_summary,
        i.evidence_source_kind, i.evidence_status,
        i.evidence_relative_path IS NOT NULL AS evidenceRecorded,
        j.id AS jobId, j.status AS jobStatus, j.imported_count AS imported,
        j.duplicate_count AS duplicate, j.updated_count AS updated, j.error_count AS invalid
      FROM batch_import_items i
      LEFT JOIN import_jobs j ON j.id = i.effective_job_id AND j.batch_item_id = i.id
      WHERE i.batch_session_id = ? ORDER BY i.ordinal, i.id
    `).all(session.id) as unknown as Array<Omit<CollectionItemView, 'job' | 'evidenceRecorded'> & {
      evidenceRecorded: number; jobId: string | null; jobStatus: string | null
      imported: number; duplicate: number; updated: number; invalid: number
    }>
    const items: CollectionItemView[] = rows.map(({ jobId, jobStatus, imported, duplicate, updated, invalid, evidenceRecorded, ...item }) => ({
      ...item, evidenceRecorded: Boolean(evidenceRecorded),
      job: jobId ? { id: jobId, status: jobStatus!, imported, duplicate, updated, invalid } : null
    }))
    const jobs = items.flatMap((item) => item.job ? [item.job] : [])
    const stats = jobs.length ? jobs.reduce((sum, job) => ({
      imported: sum.imported + job.imported, duplicate: sum.duplicate + job.duplicate,
      updated: sum.updated + job.updated, invalid: sum.invalid + job.invalid
    }), { imported: 0, duplicate: 0, updated: 0, invalid: 0 }) : null
    return { id: session.id, collection_id: session.collection_id, status: session.status,
      created_at: session.created_at, completed_at: session.completed_at, items, stats }
  })
}

interface IpcRegistrar {
  handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => unknown
}

export function registerCollectionIpc(ipc: IpcRegistrar, db: DatabaseSync): void {
  ipc.handle('collections:create', (_event, name: string) => createCollection(db, name))
  ipc.handle('collections:list', () => listDesktopCollections(db))
  ipc.handle('collections:get', (_event, id: string) => getDesktopCollection(db, id))
  ipc.handle('collections:sessions', (_event, id: string) => listDesktopCollectionSessions(db, id))
  ipc.handle('collections:complete', (_event, id: string) => {
    collectionIdSchema.parse(id)
    return completeCollection(db, id)
  })
}
