import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { bindItemMessageSource } from './message-sources'

interface LegacyItem {
  id: string
  source_batch_id: string | null
  snapshot_relative_path: string | null
  snapshot_sha256: string | null
}
interface SnapshotMessage { content?: unknown; source_position?: unknown }

function validateRelationSchema(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(batch_item_message_sources)').all()
  const expected = [
    ['batch_item_id', 'TEXT', 1, 1], ['source_position', 'INTEGER', 1, 2],
    ['message_id', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0]
  ]
  if (JSON.stringify(columns.map(column => [column.name, column.type, column.notnull, column.pk])) !== JSON.stringify(expected)) {
    migrationError('已有来源关系表结构不符合契约')
  }
  const keys = db.prepare('PRAGMA foreign_key_list(batch_item_message_sources)').all()
  if (keys.length !== 2 || ![
    ['batch_item_id', 'batch_import_items'], ['message_id', 'messages']
  ].every(([field, table]) => keys.some(key => key.from === field && key.table === table && key.to === 'id' && key.on_delete === 'RESTRICT'))) {
    migrationError('已有来源关系外键不符合契约')
  }
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'batch_item_message_sources'").get()!
  const index = db.prepare('PRAGMA index_info(idx_batch_item_message_sources_message)').all()
  if (!/CHECK\s*\(\s*source_position\s*>=\s*0\s*\)/i.test(String(schema.sql)) ||
      index.length !== 1 || index[0].name !== 'message_id') migrationError('已有来源位置约束或反查索引不符合契约')
}

function migrationError(detail: string): never {
  throw new Error(`SOURCE_PROVENANCE_MIGRATION_CONFLICT: ${detail}`)
}

function snapshotMessages(db: DatabaseSync, item: LegacyItem): SnapshotMessage[] {
  const main = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main') as { file: string } | undefined
  const relativePath = `evidence/${item.id}/messages.json`
  if (!main?.file || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id) || item.snapshot_relative_path?.replaceAll('\\', '/') !== relativePath ||
      !item.snapshot_sha256 || !/^[0-9a-f]{64}$/i.test(item.snapshot_sha256)) migrationError('历史附件缺少可核验的快照记录')
  const path = join(dirname(main.file), relativePath)
  // 同步迁移只读固定快照；不跟随链接、目录联接或硬链接，也不修改 Evidence。
  for (let ancestor = resolve(path);;) {
    const stat = lstatSync(ancestor)
    if (stat.isSymbolicLink() || realpathSync.native(ancestor).toLowerCase() !== ancestor.toLowerCase()) migrationError('快照路径含重定向')
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const before = lstatSync(path)
  if (!before.isFile() || before.nlink !== 1 || before.size > 8 * 1024 * 1024) migrationError('快照不是受限独立文件')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) migrationError('快照读取身份变化')
    const bytes = readFileSync(fd)
    const final = fstatSync(fd)
    if (bytes.length !== opened.size || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs ||
        createHash('sha256').update(bytes).digest('hex') !== item.snapshot_sha256.toLowerCase()) migrationError('快照摘要或读取状态不一致')
    const payload = JSON.parse(bytes.toString('utf8')) as { schema_version?: unknown; input?: { messages?: unknown } }
    if (payload.schema_version !== 1 || !Array.isArray(payload.input?.messages) || payload.input.messages.length > 500) migrationError('快照结构无效')
    return payload.input.messages as SnapshotMessage[]
  } finally { closeSync(fd) }
}

export function migrateMessageSourceSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS batch_item_message_sources (
      batch_item_id TEXT NOT NULL REFERENCES batch_import_items(id) ON DELETE RESTRICT,
      source_position INTEGER NOT NULL CHECK (source_position >= 0),
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (batch_item_id, source_position)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_item_message_sources_message
      ON batch_item_message_sources(message_id);`)
    validateRelationSchema(db)
    const items = db.prepare('SELECT id, source_batch_id, snapshot_relative_path, snapshot_sha256 FROM batch_import_items').all() as unknown as LegacyItem[]
    const jobs = new Map((db.prepare('SELECT id, batch_item_id FROM import_jobs').all() as unknown as Array<{ id: string; batch_item_id: string | null }>).map(row => [row.id, row.batch_item_id]))
    const snapshots = new Map<string, SnapshotMessage[]>()
    const positions = new Set<string>()
    const messages = db.prepare('SELECT id, content, source_batch_id, source_position, import_job_id, imported_at FROM messages ORDER BY id').all() as unknown as Array<{
      id: string; content: string; source_batch_id: string; source_position: number; import_job_id: string | null; imported_at: string
    }>
    for (const message of messages) {
      const candidates = new Set(items.filter(item => item.source_batch_id && item.source_batch_id === message.source_batch_id).map(item => item.id))
      const jobItem = message.import_job_id ? jobs.get(message.import_job_id) : null
      if (jobItem) candidates.add(jobItem)
      // 无 Item 的旧式导入不是可回填范围；不猜测第二来源或制造附件项。
      if (candidates.size === 0) continue
      if (candidates.size !== 1) migrationError('历史消息对应多个附件项')
      const item = items.find(value => value.id === [...candidates][0])
      if (!item) migrationError('历史任务引用不存在的附件项')
      if (item.source_batch_id && item.source_batch_id !== message.source_batch_id) migrationError('历史消息批次与附件不一致')
      if (!Number.isSafeInteger(message.source_position) || message.source_position < 0) migrationError('历史消息位置无效')
      const key = `${item.id}:${message.source_position}`
      if (positions.has(key)) migrationError('历史来源位置对应多个消息')
      positions.add(key)
      if (!snapshots.has(item.id)) snapshots.set(item.id, snapshotMessages(db, item))
      const raw = snapshots.get(item.id)![message.source_position]
      if (!raw || typeof raw.content !== 'string' || raw.content.trim() !== message.content ||
          (raw.source_position !== undefined && raw.source_position !== message.source_position)) migrationError('快照位置或消息正文不一致')
      bindItemMessageSource(db, item.id, message.source_position, message.id, message.imported_at)
    }
    if (db.prepare('PRAGMA foreign_key_check(batch_item_message_sources)').all().length) migrationError('来源关系外键无效')
    db.exec('PRAGMA user_version = 6; COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
