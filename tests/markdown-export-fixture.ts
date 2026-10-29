import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { bindItemMessageSource } from '../src/main/batch-import/message-sources'

const active: Array<{ db: DatabaseSync; root: string }> = []
export function exportFixture() {
  const root = mkdtempSync(join(tmpdir(), 'privateradar-markdown-test-'))
  const data = join(root, 'data'), output = join(root, 'output')
  mkdirSync(data); mkdirSync(output)
  const databasePath = join(data, 'private-radar.db'), db = new DatabaseSync(databasePath)
  active.push({ db, root }); initializeDatabase(db)
  db.prepare('INSERT INTO conversations(id,platform,name,created_at,user_conversation_label) VALUES(?,?,?,?,?)').run('导出会话', 'wechat', '来源群', '2026-10-01', '用户项目组')
  function add(id: string, content = '原始正文', timestamp: string | null = '2026-10-01T01:00:00.000Z', position = 0) {
    db.prepare(`INSERT INTO messages(id,platform,conversation_id,conversation_name,sender_id,sender_name,timestamp,content,message_type,source,source_batch_id,source_position,timestamp_source,fingerprint,imported_at)
      VALUES(?,'wechat','导出会话','原始来源群','发言人','原发言人',?,?,'text','file:C:\\不得导出原路径','来源批次',?, ?,?,'2026-10-02')`)
      .run(id, timestamp, content, position, timestamp ? 'source_native' : 'unknown', id)
  }
  function evidence(messageId: string) {
    const session = createBatchImportSession(db, 'synthetic'), item = createBatchImportItem(db, session.id, 0)
    db.prepare("UPDATE batch_import_items SET evidence_status='available',snapshot_sha256=? WHERE id=?").run('a'.repeat(64), item.id)
    bindItemMessageSource(db, item.id, 0, messageId, '合成来源', { senderName: '原来源人', senderNameSource: 'source_native', timestamp: '2026-10-01T01:00:00.000Z', timestampSource: 'source_native', conversationName: '来源群', conversationNameSource: 'source_native' })
  }
  return { db, root, data, output, databasePath, add, evidence, request: { conversation_id: '导出会话', range: { type: 'conversation' as const, start_date: null, end_date: null } } }
}
export function cleanupExportFixtures() {
  for (const fixture of active.splice(0)) {
    if (fixture.db.isOpen) fixture.db.close()
    if (dirname(resolve(fixture.root)) !== resolve(tmpdir()) || !fixture.root.startsWith(join(tmpdir(), 'privateradar-markdown-test-'))) throw new Error('拒绝清理不明路径')
    rmSync(fixture.root, { recursive: true, force: true })
  }
}
export function sourceFingerprint(db: DatabaseSync) {
  return Object.fromEntries(['conversations', 'messages', 'batch_item_message_sources', 'batch_import_items', 'messages_fts_data', 'messages_fts_idx', 'daily_candidate_sources', 'topic_daily_sources'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
}
