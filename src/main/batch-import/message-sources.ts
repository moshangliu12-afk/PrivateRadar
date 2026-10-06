import type { DatabaseSync } from 'node:sqlite'

export interface BatchItemMessageSource {
  batch_item_id: string
  source_position: number
  message_id: string
  created_at: string
}

export function listMessageSources(db: DatabaseSync, messageId: string): BatchItemMessageSource[] {
  return db.prepare(`SELECT * FROM batch_item_message_sources WHERE message_id = ?
    ORDER BY created_at, batch_item_id, source_position`).all(messageId) as unknown as BatchItemMessageSource[]
}

export function listItemMessageSources(db: DatabaseSync, batchItemId: string): BatchItemMessageSource[] {
  return db.prepare(`SELECT * FROM batch_item_message_sources WHERE batch_item_id = ?
    ORDER BY source_position`).all(batchItemId) as unknown as BatchItemMessageSource[]
}

export function bindItemMessageSource(
  db: DatabaseSync, batchItemId: string, sourcePosition: number, messageId: string, createdAt: string
): void {
  if (!Number.isSafeInteger(sourcePosition) || sourcePosition < 0) throw new Error('SOURCE_RELATION_CONFLICT: 来源位置无效')
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    // 只允许同一绑定幂等重放；绝不更新已有来源的消息身份或登记时间。
    db.prepare(`INSERT INTO batch_item_message_sources (batch_item_id, source_position, message_id, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(batch_item_id, source_position) DO NOTHING`)
      .run(batchItemId, sourcePosition, messageId, createdAt)
    const stored = db.prepare(`SELECT message_id FROM batch_item_message_sources
      WHERE batch_item_id = ? AND source_position = ?`).get(batchItemId, sourcePosition) as { message_id: string } | undefined
    if (stored?.message_id !== messageId) throw new Error('SOURCE_RELATION_CONFLICT: 来源位置已绑定其他消息')
    if (ownsTransaction) db.exec('COMMIT')
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/** 来源出现数不同于新增 canonical 数；每个来源位置分别参与索引一致性验证。 */
export function countItemMessageSources(db: DatabaseSync, batchItemId: string, indexed = false): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM batch_item_message_sources s
    JOIN messages m ON m.id = s.message_id
    ${indexed ? 'JOIN messages_fts f ON f.rowid = m.rowid' : ''}
    WHERE s.batch_item_id = ?`).get(batchItemId) as { count: number }).count
}

/** 固定别名由代码调用方提供；有 Item 的批次使用来源成员关系，旧式批次保留 ownership 查询。 */
export function batchMessageMembershipSql(alias = 'm'): string {
  return `(EXISTS (SELECT 1 FROM batch_item_message_sources s
    JOIN batch_import_items i ON i.id = s.batch_item_id
    WHERE s.message_id = ${alias}.id AND i.source_batch_id = ?)
    OR (${alias}.source_batch_id = ? AND NOT EXISTS (
      SELECT 1 FROM batch_import_items i WHERE i.source_batch_id = ?)))`
}
