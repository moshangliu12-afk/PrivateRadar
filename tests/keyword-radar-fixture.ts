import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import type { WorkBuddyMessageInput } from '../src/main/integrations/workbuddy/validation'

const fixtures: Array<{ db: DatabaseSync; directory: string }> = []
export function cleanupRadarFixtures(): void {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
}
export function radarFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-keyword-radar-'))
  const path = join(directory, 'private-radar.db'), db = new DatabaseSync(path)
  fixtures.push({ db, directory })
  initializeDatabase(db)
  const session = createBatchImportSession(db, 'workbuddy')
  const items = [createBatchImportItem(db, session.id, 0), createBatchImportItem(db, session.id, 1)]
  return { db, directory, path, session, items }
}
export function radarMessages(numbers = [1, 2]): WorkBuddyMessageInput[] {
  return numbers.map(number => ({ platform: 'wechat', content: `隔离关键词 Codex 消息 ${number}`,
    source_message_id: `隔离原生身份${number}`, conversation_name: '隔离群', sender_name: '隔离发送人',
    timestamp: '2026-10-06T09:00:00+08:00', timestamp_source: 'source_native' }))
}
export function ingestRadarItem(f: ReturnType<typeof radarFixture>, ordinal = 0, messages = radarMessages()) {
  const item = f.items[ordinal], sourceBatchId = `workbuddy:item:${item.id}`
  f.db.prepare('UPDATE batch_import_items SET source_batch_id=? WHERE id=?').run(sourceBatchId, item.id)
  return ingestWorkBuddyMessages(f.db, { messages }, 0, { batchItemId: item.id, sourceBatchId })
}
export function radarCount(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)
}
