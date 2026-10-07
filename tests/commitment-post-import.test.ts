import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as matcher from '../src/main/commitment/matcher'
import * as recovery from '../src/main/commitment/recovery'
import { COMMITMENT_RULE_VERSION } from '../src/main/commitment/matcher'
import { getCommitmentExtractorRun } from '../src/main/commitment/runs'
import { addKeywordTerm, createKeywordGroup } from '../src/main/keyword-radar/config'
import { ingestWorkBuddyBatch, ingestWorkBuddyCurrentContextBatch } from '../src/main/integrations/workbuddy/batch-tool'
import type { WorkBuddyMessageInput } from '../src/main/integrations/workbuddy/validation'
import { cleanupRadarFixtures, radarCount, radarFixture } from './keyword-radar-fixture'
import { commitmentMessages } from './commitment-processing-fixture'

afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
function prepared(sharedIdentity = false) {
  const f = radarFixture(), root = join(f.directory, 'user', '.workbuddy', 'app', 'tmp', 'chat-history')
  mkdirSync(root, { recursive: true })
  addKeywordTerm(f.db, createKeywordGroup(f.db, '隔离关键词').id, '我')
  const attachments = [0, 1].map(index => {
    const path = join(root, `隔离卡片${index}.zip`), bytes = Buffer.alloc(22)
    bytes.write('PK\u0005\u0006', 0, 'binary'); bytes[8] = index + 1
    writeFileSync(path, bytes)
    const bodies = sharedIdentity ? ['我会回复你'] : ['我会把文件发给你', '我来处理这个问题']
    const messages: WorkBuddyMessageInput[] = commitmentMessages(bodies).map((message, position) => ({ ...message,
      source_message_id: sharedIdentity ? `共享原生身份${position}` : `独立原生身份${index}-${position}` }))
    return { source_zip_path: path, messages }
  })
  return { ...f, root, attachments, options: { databasePath: f.path, chatHistoryRoot: root } }
}
function coreState(f: ReturnType<typeof prepared>) {
  const rows = f.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT LIKE 'keyword_%' AND name NOT LIKE 'commitment_%' ORDER BY name`).all()
  return rows.map(row => [row.name, f.db.prepare(`SELECT * FROM "${String(row.name)}"`).all().map(value => JSON.stringify(value)).sort()])
}
function evidenceState(root: string): Array<[string, string]> {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? evidenceState(path) : [[path, createHash('sha256').update(readFileSync(path)).digest('hex')] as [string, string]]
  }).sort((left, right) => left[0].localeCompare(right[0]))
}
async function flush() {
  for (let tick = 0; tick < 12; tick++) await new Promise<void>(resolve => setImmediate(resolve))
}

describe('承诺批量导入后触发与核心失败隔离', () => {
  it('批量成功返回时只登记任务，随后独立处理候选项，关键词处理仍正常完成', async () => {
    const f = prepared(), spy = vi.spyOn(recovery, 'schedulePendingCommitmentExtractorRuns')
    const output = await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    expect(output).toMatchObject({ status: 'success', summary: { imported_total: 4 } })
    expect(spy).toHaveBeenCalledWith(f.db, output.items.map(item => item.item_id))
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
    expect(output.items.every(item => getCommitmentExtractorRun(f.db, item.item_id, COMMITMENT_RULE_VERSION)!.status === 'pending')).toBe(true)
    const before = coreState(f), evidence = evidenceState(join(f.directory, 'evidence'))
    await flush()
    expect(coreState(f)).toEqual(before)
    expect(evidenceState(join(f.directory, 'evidence'))).toEqual(evidence)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(4)
    expect(radarCount(f.db, 'keyword_hits')).toBe(4)
    expect(f.db.prepare("SELECT count(*) AS n FROM commitment_extractor_runs WHERE status='complete'").get()!.n).toBe(2)
  })
  it.each([false, true])('匹配异常不改变核心成功与证据，部分成功=%s；关键词仍独立生成命中', async partial => {
    const f = prepared()
    if (partial) f.attachments[0].messages.push({ ...f.attachments[0].messages[0], content: undefined })
    vi.spyOn(matcher, 'matchCommitmentBody').mockImplementation(() => { throw new Error('秘密聊天、证据路径和堆栈') })
    const output = await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    expect(output.status).toBe(partial ? 'partial_success' : 'success')
    expect(output.summary.imported_total).toBe(4)
    const before = coreState(f), evidence = evidenceState(join(f.directory, 'evidence')), result = JSON.stringify(output)
    await flush()
    expect(JSON.stringify(output)).toBe(result)
    expect(coreState(f)).toEqual(before)
    expect(evidenceState(join(f.directory, 'evidence'))).toEqual(evidence)
    expect(f.db.prepare("SELECT count(*) AS n FROM commitment_extractor_runs WHERE status='failed'").get()!.n).toBe(2)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
    expect(radarCount(f.db, 'keyword_hits')).toBe(4)
    expect(f.db.prepare("SELECT count(*) AS n FROM keyword_radar_runs WHERE status='complete'").get()!.n).toBe(2)
  })
  it('派生安排自身失败不影响导入成功，运行记录安全保留待处理', async () => {
    const f = prepared(), log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(recovery, 'schedulePendingCommitmentExtractorRuns').mockImplementation(() => { throw new Error('秘密') })
    const output = await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    expect(output).toMatchObject({ status: 'success', summary: { imported_total: 4 } })
    await flush()
    expect(log.mock.calls).toEqual([['[承诺提取] RECOVERY_FAILED']])
    expect(f.db.prepare("SELECT count(*) AS n FROM commitment_extractor_runs WHERE status='pending'").get()!.n).toBe(2)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
    expect(radarCount(f.db, 'keyword_hits')).toBe(4)
  })
  it('规范消息强重复新增为零时，新附件来源仍独立登记及生成候选项', async () => {
    const f = prepared(true)
    const first = await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    await flush()
    expect(first.summary).toMatchObject({ imported_total: 1, duplicate_total: 1 })
    const second = await ingestWorkBuddyBatch(f.db, f.options, { attachments: f.attachments })
    expect(second.summary).toMatchObject({ imported_total: 0, duplicate_total: 2 })
    await flush()
    expect(radarCount(f.db, 'messages')).toBe(1)
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(4)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(4)
    expect(radarCount(f.db, 'keyword_hits')).toBe(4)
  })
  it('当前上下文双卡中的正、负与省略主语样本按原来源处理，重复原始块不制造重复候选项', async () => {
    const f = prepared()
    const contexts = [0, 1].map(index => {
      const path = join(f.root, `明确目录${index}`)
      mkdirSync(path); writeFileSync(join(path, '聊天记录.txt'), `仅为回源保存的隔离证据${index}`)
      return { file: `隔离卡片${index}.zip`, extracted_dir_path: path, message_count: index === 0 ? 1 : 2,
        transcript: index === 0 ? '·隔离发送人零\n2026年10月7日 09:00\n我会把文件发给你'
          : '·隔离发送人一\n2026年10月7日 09:00\n我不会处理这个\n\n·隔离发送人一\n2026年10月7日 09:01\n晚点发你' }
    })
    const output = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, {
      mode: 'current_context', contexts: [contexts[0], { ...contexts[0] }, contexts[1]]
    })
    expect(output).toMatchObject({ status: 'success', summary: { imported_total: 3 } })
    await flush()
    expect(radarCount(f.db, 'batch_item_message_sources')).toBe(3)
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(2)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(1)
    expect(f.db.prepare('SELECT batch_item_id,source_position,status FROM commitment_candidates').all())
      .toEqual([{ batch_item_id: output.items[0].item_id, source_position: 0, status: 'pending' }])
    expect(output.items.every(item => getCommitmentExtractorRun(f.db, item.item_id, COMMITMENT_RULE_VERSION)!.status === 'complete')).toBe(true)
    expect(radarCount(f.db, 'keyword_hits')).toBe(2)
  }, 30_000)
})
