import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKeywordGroup, addKeywordTerm } from '../src/main/keyword-radar/config'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { processCommitmentExtractorRun } from '../src/main/commitment/processor'
import { COMMITMENT_RULE_VERSION } from '../src/main/commitment/matcher'
import { registerCommitmentExtractorRun } from '../src/main/commitment/runs'
import { saveOriginalZip, saveStructuredSnapshot } from '../src/main/batch-import/evidence'
import { commitmentMessages } from './commitment-processing-fixture'
import { ingestRadarItem, radarFixture } from './keyword-radar-fixture'

export type ReviewFixture = ReturnType<typeof reviewFixture>
type SourcePatch = (position: number) => Record<string, string | number | null>

export function reviewFixture(bodies = ['我会处理这个问题', '我来处理这个接口', '我稍后回复你'], patch?: SourcePatch) {
  const f = radarFixture(), messages = commitmentMessages(bodies)
  const group = createKeywordGroup(f.db, '审核回归关键词')
  addKeywordTerm(f.db, group.id, '处理')
  const result = ingestRadarItem(f, 0, messages)
  if (result.status !== 'success') throw new Error('审核测试导入失败')
  f.db.prepare("UPDATE batch_import_items SET status='success',effective_job_id=? WHERE id=?").run(result.jobId, f.items[0].id)
  if (patch) {
    // 仅在隔离测试的首次派生前重建来源；不删除或绕过生产不可变触发器。
    const run = f.db.prepare('SELECT * FROM commitment_extractor_runs WHERE batch_item_id=?').get(f.items[0].id)!
    const rows = f.db.prepare('SELECT * FROM batch_item_message_sources WHERE batch_item_id=? ORDER BY source_position').all(f.items[0].id)
    f.db.prepare('DELETE FROM commitment_extractor_runs WHERE batch_item_id=?').run(f.items[0].id)
    f.db.prepare('DELETE FROM batch_item_message_sources WHERE batch_item_id=?').run(f.items[0].id)
    for (const row of rows) {
      const next = { ...row, ...patch(Number(row.source_position)) }, columns = Object.keys(next)
      f.db.prepare(`INSERT INTO batch_item_message_sources (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(next))
    }
    registerCommitmentExtractorRun(f.db, f.items[0].id, result.jobId, COMMITMENT_RULE_VERSION,
      rows.map(row => Number(row.source_position)), String(run.created_at))
  }
  processCommitmentExtractorRun(f.db, f.items[0].id)
  processKeywordRadarRun(f.db, f.items[0].id)
  return { ...f, messages, group }
}

export function reviewDatabaseFingerprint(f: Pick<ReviewFixture, 'db'>, omitCandidates = false): string {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .filter(row => !omitCandidates || row.name !== 'commitment_candidates')
  return createHash('sha256').update(JSON.stringify(tables.map(row => {
    const name = String(row.name)
    const data = f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(value => JSON.stringify(value,
      (_key, entry) => entry instanceof Uint8Array ? Buffer.from(entry).toString('hex') : entry)).sort()
    return [name, data]
  }))).digest('hex')
}

export async function saveReviewEvidence(f: ReviewFixture, index = 0) {
  const source = join(f.directory, `来源${index}.zip`)
  writeFileSync(source, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))
  await saveOriginalZip(f.db, f.path, f.items[index].id, source)
  await saveStructuredSnapshot(f.db, f.path, f.items[index].id, { messages: f.messages })
  return join(f.directory, 'evidence', f.items[index].id)
}
