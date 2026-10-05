import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { BatchImportSession } from '../batch-import/repository'

export type CollectionStatus = 'collecting' | 'completed'

export interface Collection {
  id: string
  display_name: string
  status: CollectionStatus
  created_at: string
  completed_at: string | null
}

export const collectionIdSchema = z.uuid({ error: 'INVALID_COLLECTION_ID: 归集身份必须是完整 UUID' })

export function assertCollectingCollection(db: DatabaseSync, id: string): Collection {
  collectionIdSchema.parse(id)
  const collection = getCollection(db, id)
  if (!collection) throw new Error('COLLECTION_NOT_FOUND: 归集不存在')
  if (collection.status !== 'collecting') throw new Error('COLLECTION_COMPLETED: 已完成的归集不能新增导入会话')
  return collection
}

export function getCollection(db: DatabaseSync, id: string): Collection | null {
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id)
  return row ? row as unknown as Collection : null
}

export function listCollections(db: DatabaseSync): Collection[] {
  return db.prepare('SELECT * FROM collections ORDER BY created_at DESC, id').all() as unknown as Collection[]
}

export function listCollectionSessions(db: DatabaseSync, collectionId: string): BatchImportSession[] {
  return db.prepare(`
    SELECT * FROM batch_import_sessions WHERE collection_id = ? ORDER BY created_at, id
  `).all(collectionId) as unknown as BatchImportSession[]
}
