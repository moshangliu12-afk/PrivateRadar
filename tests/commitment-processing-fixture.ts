import { createHash } from 'node:crypto'
import { ingestRadarItem, radarFixture, radarMessages } from './keyword-radar-fixture'
import { COMMITMENT_RULE_VERSION } from '../src/main/commitment/matcher'
import { getCommitmentExtractorRun, registerCommitmentExtractorRun } from '../src/main/commitment/runs'

export function commitmentMessages(bodies = ['我会把文件发给你', '我来处理这个问题', '我稍后回复你']) {
  return radarMessages(bodies.map((_body, index) => index + 1)).map((message, index) => ({ ...message, content: bodies[index] }))
}
export function processingFixture(bodies?: string[], positions?: number[]) {
  const f = radarFixture(), messages = commitmentMessages(bodies)
  const result = ingestRadarItem(f, 0, messages)
  if (result.status !== 'success') throw new Error('处理器测试导入失败')
  f.db.prepare("UPDATE batch_import_items SET status='success',effective_job_id=? WHERE id=?").run(result.jobId, f.items[0].id)
  if (positions) {
    // 仅构造隔离子集任务；正式实现不得替换已冻结的运行记录。
    const old = getCommitmentExtractorRun(f.db, f.items[0].id, COMMITMENT_RULE_VERSION)!
    f.db.prepare('DELETE FROM commitment_extractor_runs WHERE batch_item_id=?').run(f.items[0].id)
    registerCommitmentExtractorRun(f.db, f.items[0].id, result.jobId, COMMITMENT_RULE_VERSION, positions, old.created_at)
  }
  return { ...f, itemId: f.items[0].id, jobId: result.jobId, messages }
}
export function processingRun(f: ReturnType<typeof processingFixture>) {
  return getCommitmentExtractorRun(f.db, f.itemId, COMMITMENT_RULE_VERSION)!
}
export function processingCandidates(f: ReturnType<typeof processingFixture>) {
  return f.db.prepare('SELECT * FROM commitment_candidates ORDER BY batch_item_id,source_position,rule_version').all()
}
export function commitmentCoreFingerprint(f: ReturnType<typeof radarFixture>): string {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'commitment_%' ORDER BY name").all()
  return createHash('sha256').update(JSON.stringify(tables.map(row => {
    const name = String(row.name)
    const data = f.db.prepare(`SELECT * FROM "${name}"`).all().map(value => JSON.stringify(value,
      (_key, entry) => entry instanceof Uint8Array ? Buffer.from(entry).toString('hex') : entry)).sort()
    return [name, data]
  }))).digest('hex')
}
