import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createKeywordGroup, addKeywordTerm } from '../src/main/keyword-radar/config'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { saveOriginalZip, saveStructuredSnapshot } from '../src/main/batch-import/evidence'
import { radarFixture, radarMessages, ingestRadarItem } from './keyword-radar-fixture'

export type InterestFixture = ReturnType<typeof radarFixture>
export const todayClock = () => new Date(2026, 9, 8, 12)
export function interestMessages(numbers = [1]) {
  return radarMessages(numbers).map(message => ({ ...message, timestamp: new Date(2026, 9, 8, 9).toISOString() }))
}
export function interestFixture(messages = interestMessages()) {
  const f = radarFixture(), group = createKeywordGroup(f.db, '关注词隔离组')
  const term = addKeywordTerm(f.db, group.id, 'Codex')
  ingestRadarItem(f, 0, messages); processKeywordRadarRun(f.db, f.items[0].id)
  return { ...f, group, term }
}
/** 只构造临时来源样本，不删除或绕过生产不可变触发器。 */
export function replaceInterestSources(f: InterestFixture, index: number,
  changes: (position: number) => Record<string, string | number | null>): void {
  const itemId = f.items[index].id
  const sources = f.db.prepare('SELECT * FROM batch_item_message_sources WHERE batch_item_id=? ORDER BY source_position').all(itemId)
  const hits = f.db.prepare('SELECT * FROM keyword_hits WHERE batch_item_id=?').all(itemId)
  f.db.prepare('DELETE FROM keyword_hits WHERE batch_item_id=?').run(itemId)
  f.db.prepare('DELETE FROM batch_item_message_sources WHERE batch_item_id=?').run(itemId)
  for (const source of sources) {
    const next = { ...source, ...changes(Number(source.source_position)) }, columns = Object.keys(next)
    f.db.prepare(`INSERT INTO batch_item_message_sources (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(next))
  }
  for (const hit of hits) {
    const columns = Object.keys(hit)
    f.db.prepare(`INSERT INTO keyword_hits (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(hit))
  }
}
export function interestDatabaseFingerprint(f: InterestFixture) {
  const schema = f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all()
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => {
    const name = String(row.name)
    return [name, f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]
  })
  return { changes: f.db.prepare('SELECT total_changes() AS n').get()!.n,
    hash: createHash('sha256').update(JSON.stringify({ schema, tables })).digest('hex') }
}
export async function interestEvidence(f: InterestFixture, index: number) {
  const path = join(f.directory, `隔离来源${index}.zip`)
  writeFileSync(path, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))
  await saveOriginalZip(f.db, f.path, f.items[index].id, path)
  await saveStructuredSnapshot(f.db, f.path, f.items[index].id, { messages: interestMessages() })
}
export function interestEvidenceFingerprint(f: InterestFixture) {
  const entries: Array<[string, string]> = []
  function visit(path: string, relative: string) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const name = relative + '/' + entry.name
      if (entry.isDirectory()) visit(join(path, entry.name), name)
      else entries.push([name, createHash('sha256').update(readFileSync(join(path, entry.name))).digest('hex')])
    }
  }
  visit(join(f.directory, 'evidence'), '')
  return entries
}
