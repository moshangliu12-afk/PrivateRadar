import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BatchImportSession } from '../batch-import/repository'
import { getCollection, type Collection } from './repository'

export { getCollection, listCollections, listCollectionSessions } from './repository'

export function createCollection(db: DatabaseSync, displayName: string): Collection {
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    throw new Error('归集名称不能为空')
  }
  const id = randomUUID()
  db.prepare(`
    INSERT INTO collections (id, display_name, status, created_at)
    VALUES (?, ?, 'collecting', ?)
  `).run(id, displayName.trim(), new Date().toISOString())
  return getCollection(db, id)!
}

export function bindSession(db: DatabaseSync, collectionId: string, sessionId: string): BatchImportSession {
  return inTransaction(db, () => {
    const collection = requireCollection(db, collectionId)
    if (collection.status !== 'collecting') throw new Error('已完成的归集不能绑定会话')
    const session = db.prepare('SELECT * FROM batch_import_sessions WHERE id = ?').get(sessionId) as
      unknown as BatchImportSession | undefined
    if (!session) throw new Error('导入会话不存在')
    if (session.collection_id === collectionId) return session
    if (session.collection_id !== null) throw new Error('导入会话已绑定其他归集')
    const result = db.prepare(`
      UPDATE batch_import_sessions SET collection_id = ? WHERE id = ? AND collection_id IS NULL
    `).run(collectionId, sessionId)
    if (result.changes !== 1) throw new Error('导入会话绑定失败')
    return { ...session, collection_id: collectionId }
  })
}

export function completeCollection(db: DatabaseSync, collectionId: string): Collection {
  return inTransaction(db, () => {
    const collection = requireCollection(db, collectionId)
    if (collection.status === 'completed') return collection
    // preparing 同样尚未终结，不能在附件准备过程中完成归集。
    const unfinished = db.prepare(`
      SELECT 1 FROM batch_import_sessions
      WHERE collection_id = ? AND status IN ('pending', 'preparing', 'in_progress') LIMIT 1
    `).get(collectionId)
    if (unfinished) throw new Error('归集中仍有未终结的导入会话')
    const completedAt = new Date().toISOString()
    const result = db.prepare(`
      UPDATE collections SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'collecting'
    `).run(completedAt, collectionId)
    if (result.changes !== 1) throw new Error('归集完成失败')
    return { ...collection, status: 'completed', completed_at: completedAt }
  })
}

function requireCollection(db: DatabaseSync, id: string): Collection {
  const collection = getCollection(db, id)
  if (!collection) throw new Error('归集不存在')
  return collection
}

function inTransaction<T>(db: DatabaseSync, operation: () => T): T {
  // 先取得 SQLite 写事务，再读取状态；两个连接不能基于过期状态分别通过检查。
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
