import type { DatabaseSync } from 'node:sqlite'
import type { BatchImportSession } from '../batch-import/repository'

export type CollectionStatus = 'collecting' | 'completed'

export interface Collection {
  id: string
  display_name: string
  status: CollectionStatus
  created_at: string
  completed_at: string | null
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
