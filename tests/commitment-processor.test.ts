import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as matcher from '../src/main/commitment/matcher'
import * as contracts from '../src/main/commitment/contracts'
import * as runs from '../src/main/commitment/runs'
import { createCommitmentCandidate, reviewCommitmentCandidate } from '../src/main/commitment/candidates'
import { processCommitmentExtractorRun, retryCommitmentExtractorRun } from '../src/main/commitment/processor'
import { addKeywordTerm, createKeywordGroup } from '../src/main/keyword-radar/config'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { cleanupRadarFixtures, ingestRadarItem, radarCount, radarFixture } from './keyword-radar-fixture'
import { commitmentCoreFingerprint, commitmentMessages, processingCandidates, processingFixture, processingRun } from './commitment-processing-fixture'

const version = matcher.COMMITMENT_RULE_VERSION
afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
function insertExisting(f: ReturnType<typeof processingFixture>, ruleId?: string, reasonCode?: string) {
  const match = matcher.matchCommitmentBody(f.messages[0].content!)!
  return createCommitmentCandidate(f.db, { batchItemId: f.itemId, sourcePosition: 0, ruleVersion: version,
    ruleId: ruleId ?? match.rule_id, reasonCode: reasonCode ?? match.reason_code })
}
function corruptSnapshot(f: ReturnType<typeof processingFixture>, positions: string) {
  // 只用于隔离故障注入；正式处理器绝不改写冻结字段或关闭约束。
  f.db.exec('DROP TRIGGER immutable_commitment_run; PRAGMA ignore_check_constraints=ON')
  f.db.prepare('UPDATE commitment_extractor_runs SET source_positions_snapshot_json=?').run(positions)
  f.db.exec('PRAGMA ignore_check_constraints=OFF')
}

describe('承诺提取登记与独立原子处理', () => {
  it('核心事务只冻结真实新增位置，匹配和候选项写入必须在提交后独立执行', () => {
    const f = radarFixture(), spy = vi.spyOn(matcher, 'matchCommitmentBody')
    const result = ingestRadarItem(f, 0, commitmentMessages())
    expect(result.status).toBe('success')
    const run = runs.getCommitmentExtractorRun(f.db, f.items[0].id, version)!
    expect(run).toMatchObject({ core_import_job_id: result.jobId, status: 'pending', attempt_count: 0,
      source_positions_snapshot_json: '[0,1,2]' })
    expect(spy).not.toHaveBeenCalled()
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
    expect(processCommitmentExtractorRun(f.db, f.items[0].id)).toMatchObject({ status: 'complete', candidateCount: 3, attempt: 1 })
    expect(spy).toHaveBeenCalledTimes(3)
    expect(f.db.prepare('SELECT status,reviewed_at FROM commitment_candidates').all())
      .toEqual(Array.from({ length: 3 }, () => ({ status: 'pending', reviewed_at: null })))
  })
  it.each([[], [{ content: '无效输入', timestamp: '无效时间' }]].map(messages => [messages]))('没有新增合法位置不登记运行记录：%j', messages => {
    const f = radarFixture()
    ingestRadarItem(f, 0, messages)
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(0)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
  })
  it('部分成功保留原位置空洞，只冻结实际新增的零和二', () => {
    const f = radarFixture(), messages = commitmentMessages(['我会回复你', '我会补充资料'])
    const result = ingestRadarItem(f, 0, [messages[0], { content: '无效', timestamp: '坏时间' }, messages[1]])
    expect(result).toMatchObject({ status: 'partial', importedCount: 2, invalidCount: 1 })
    expect(runs.getCommitmentExtractorRun(f.db, f.items[0].id, version)!.source_positions_snapshot_json).toBe('[0,2]')
    expect(processCommitmentExtractorRun(f.db, f.items[0].id).candidateCount).toBe(2)
    expect(f.db.prepare('SELECT source_position FROM commitment_candidates ORDER BY source_position').all())
      .toEqual([{ source_position: 0 }, { source_position: 2 }])
  })
  it('持久登记失败会回滚当前核心消息、全文索引、来源和关键词登记，不留下无任务的导入成功', () => {
    const f = radarFixture()
    f.db.exec(`CREATE TEMP TRIGGER reject_commitment_registration BEFORE INSERT ON commitment_extractor_runs
      BEGIN SELECT RAISE(ABORT,'隔离登记故障'); END`)
    const result = ingestRadarItem(f, 0, commitmentMessages())
    expect(result.status).toBe('failed')
    for (const table of ['messages', 'messages_fts', 'batch_item_message_sources', 'keyword_radar_runs', 'commitment_extractor_runs', 'commitment_candidates']) {
      expect(radarCount(f.db, table)).toBe(0)
    }
    expect(f.db.prepare('SELECT status FROM import_jobs WHERE id=?').get(result.jobId)).toEqual({ status: 'failed' })
  })
  it('只处理冻结位置，忽略其他正文、上下文、证据路径及聊天时间，不改变全部核心表或关键词数据', () => {
    const f = processingFixture(['我会回复你', '我会处理这个问题', '我会补充资料'], [0, 2])
    const path = join(f.directory, '隔离证据.txt')
    writeFileSync(path, '不能读取为匹配依据，也不能修改的隔离证据')
    f.db.prepare("UPDATE batch_import_items SET evidence_relative_path='不存在的证据',snapshot_relative_path='不存在的快照' WHERE id=?").run(f.itemId)
    const before = commitmentCoreFingerprint(f), bytes = readFileSync(path), frozen = processingRun(f)
    const spy = vi.spyOn(matcher, 'matchCommitmentBody')
    expect(processCommitmentExtractorRun(f.db, f.itemId)).toMatchObject({ status: 'complete', candidateCount: 2 })
    expect(spy.mock.calls.map(call => call[0])).toEqual(['我会回复你', '我会补充资料'])
    expect(processingCandidates(f).map(candidate => candidate.source_position)).toEqual([0, 2])
    expect(commitmentCoreFingerprint(f)).toBe(before)
    expect(readFileSync(path)).toEqual(bytes)
    const after = processingRun(f)
    for (const field of ['batch_item_id', 'core_import_job_id', 'rule_version', 'source_positions_snapshot_json', 'created_at'] as const) {
      expect(after[field]).toBe(frozen[field])
    }
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  })
  it('负例和模糊例零候选项是完成结果，同一来源的多个规则只写一条候选项', () => {
    const negative = processingFixture(['我不会处理', '如果需要我会处理', '晚点发你', '这个可以', '我已经发给你了'])
    expect(processCommitmentExtractorRun(negative.db, negative.itemId)).toMatchObject({ status: 'complete', candidateCount: 0 })
    expect(processingCandidates(negative)).toEqual([])
    const multiple = processingFixture(['我来处理，我会回复你，这块我负责'])
    expect(processCommitmentExtractorRun(multiple.db, multiple.itemId)).toMatchObject({ status: 'complete', candidateCount: 1 })
    expect(processingCandidates(multiple)).toMatchObject([{ rule_id: 'self_responsibility' }])
  })
  it('完整运行记录重复处理或重试均不重匹配、不增加代次、不刷新候选项时间', () => {
    const f = processingFixture()
    processCommitmentExtractorRun(f.db, f.itemId)
    const run = processingRun(f), candidates = processingCandidates(f), spy = vi.spyOn(matcher, 'matchCommitmentBody')
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('already_complete')
    expect(retryCommitmentExtractorRun(f.db, f.itemId).status).toBe('already_complete')
    expect(spy).not.toHaveBeenCalled()
    expect(processingRun(f)).toEqual(run)
    expect(processingCandidates(f)).toEqual(candidates)
  })
  it('强身份重复只新增来源，两个附件共享规范消息仍各自拥有独立候选项', () => {
    const f = processingFixture(['我会回复你'])
    expect(ingestRadarItem(f, 1, f.messages)).toMatchObject({ importedCount: 0, duplicateCount: 1, status: 'success' })
    expect(processCommitmentExtractorRun(f.db, f.itemId).candidateCount).toBe(1)
    expect(processCommitmentExtractorRun(f.db, f.items[1].id).candidateCount).toBe(1)
    expect(radarCount(f.db, 'messages')).toBe(1)
    expect(processingCandidates(f).map(candidate => candidate.batch_item_id).sort()).toEqual(f.items.map(item => item.id).sort())
  })
  it.each(['pending', 'failed', 'complete'] as const)('旧来源重放不登记新运行记录，也不改变原有 %s 执行状态', status => {
    const f = processingFixture(['我会回复你'])
    if (status === 'complete') processCommitmentExtractorRun(f.db, f.itemId)
    if (status === 'failed') runs.markCommitmentFailed(f.db, f.itemId, version,
      runs.markCommitmentAttemptStarted(f.db, f.itemId, version)!, 'PROCESSING_FAILED')
    const frozen = processingRun(f), candidates = processingCandidates(f)
    expect(ingestRadarItem(f, 0, f.messages)).toMatchObject({ status: 'success', importedCount: 0, duplicateCount: 1 })
    expect(processingRun(f)).toEqual(frozen)
    expect(processingCandidates(f)).toEqual(candidates)
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(1)
  })
  it('关键词处理与承诺处理各自独立，关键词命中和执行状态不被承诺改写', () => {
    const f = radarFixture()
    addKeywordTerm(f.db, createKeywordGroup(f.db, '隔离关键词').id, '我')
    ingestRadarItem(f, 0, commitmentMessages(['我会回复你']))
    expect(processKeywordRadarRun(f.db, f.items[0].id).status).toBe('complete')
    const before = commitmentCoreFingerprint(f)
    expect(processCommitmentExtractorRun(f.db, f.items[0].id).status).toBe('complete')
    expect(commitmentCoreFingerprint(f)).toBe(before)
    expect(radarCount(f.db, 'keyword_hits')).toBe(1)
  })
})

describe('承诺派生失败、重试与执行权', () => {
  it('匹配异常仅标记派生失败，已成功附件项和任务、正文、索引、来源、关键词及证据均保持', () => {
    const f = processingFixture(), before = commitmentCoreFingerprint(f)
    vi.spyOn(matcher, 'matchCommitmentBody').mockImplementationOnce(() => { throw new Error('秘密聊天和秘密路径') })
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('failed')
    expect(processingRun(f)).toMatchObject({ status: 'failed', attempt_count: 1, error_summary: 'PROCESSING_FAILED: 承诺派生处理失败' })
    expect(processingCandidates(f)).toEqual([])
    expect(commitmentCoreFingerprint(f)).toBe(before)
    expect(f.db.prepare('SELECT status FROM import_jobs WHERE id=?').get(f.jobId)).toEqual({ status: 'success' })
    expect(f.db.prepare('SELECT status FROM batch_import_items WHERE id=?').get(f.itemId)).toEqual({ status: 'success' })
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('retry_required')
    expect(retryCommitmentExtractorRun(f.db, f.itemId)).toMatchObject({ status: 'complete', candidateCount: 3, attempt: 2 })
  })
  it.each(['第二条候选项', '最终完成'])('%s 持久化失败时所有本次候选项整体回滚，失败状态另行原子提交', failure => {
    const f = processingFixture(), before = commitmentCoreFingerprint(f)
    if (failure === '第二条候选项') f.db.exec(`CREATE TEMP TRIGGER reject_second_candidate BEFORE INSERT ON commitment_candidates
      WHEN (SELECT count(*) FROM commitment_candidates)=1 BEGIN SELECT RAISE(ABORT,'秘密故障'); END`)
    else f.db.exec(`CREATE TEMP TRIGGER reject_complete BEFORE UPDATE ON commitment_extractor_runs
      WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'秘密故障'); END`)
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('failed')
    expect(processingCandidates(f)).toEqual([])
    expect(processingRun(f).status).toBe('failed')
    expect(commitmentCoreFingerprint(f)).toBe(before)
  })
  it('失败状态登记也失败时保留安全待处理状态，不冒充完成，之后可以恢复', () => {
    const f = processingFixture(['我会回复你'])
    vi.spyOn(matcher, 'matchCommitmentBody').mockImplementationOnce(() => { throw new Error('秘密') })
    f.db.exec(`CREATE TEMP TRIGGER reject_failed BEFORE UPDATE ON commitment_extractor_runs
      WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'秘密'); END`)
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('pending')
    expect(processingCandidates(f)).toEqual([])
    expect(processingRun(f).status).toBe('pending')
    expect(log).toHaveBeenCalledWith('[承诺提取] FAILURE_PERSISTENCE_FAILED')
    f.db.exec('DROP TRIGGER reject_failed')
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('complete')
  })
  it.each(['confirmed', 'ignored'] as const)('显式失败重试保持 %s 审核结果、时间、原因和标识，不重新冻结或扫描来源', status => {
    const f = processingFixture(['我会回复你', '我会补充资料'], [0]), candidate = insertExisting(f)
    reviewCommitmentCandidate(f.db, candidate.id, status)
    const before = processingCandidates(f), frozen = processingRun(f)
    vi.spyOn(matcher, 'matchCommitmentBody').mockImplementationOnce(() => { throw new Error('秘密') })
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('failed')
    expect(processingCandidates(f)).toEqual(before)
    expect(retryCommitmentExtractorRun(f.db, f.itemId)).toMatchObject({ status: 'complete', candidateCount: 1, attempt: 2 })
    expect(processingCandidates(f)).toEqual(before)
    expect(processingRun(f).source_positions_snapshot_json).toBe(frozen.source_positions_snapshot_json)
    expect(processingRun(f).core_import_job_id).toBe(frozen.core_import_job_id)
    expect(processingRun(f).rule_version).toBe(frozen.rule_version)
  })
  it.each(['规则冲突', '原因冲突', '当前无匹配'])('已有候选项的 %s 显式失败且不覆盖用户审核', conflict => {
    const f = processingFixture(['我会回复你'])
    const candidate = insertExisting(f, conflict === '规则冲突' ? '别的规则' : undefined, conflict === '原因冲突' ? '别的原因' : undefined)
    reviewCommitmentCandidate(f.db, candidate.id, 'confirmed')
    if (conflict === '当前无匹配') vi.spyOn(matcher, 'matchCommitmentBody').mockReturnValueOnce(null)
    const before = processingCandidates(f)
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('failed')
    expect(processingRun(f).error_summary).toBe('CANDIDATE_CONFLICT: 已有候选项与固定规则结果不一致')
    expect(processingCandidates(f)).toEqual(before)
  })
  it.each(['不是序列', '{}', '[0,0]', '[1,0]', '[-1]', '[0.5]'])('损坏的冻结来源快照 %s 不猜测修复、不回扫', snapshot => {
    const f = processingFixture()
    corruptSnapshot(f, snapshot)
    const spy = vi.spyOn(matcher, 'matchCommitmentBody')
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('failed')
    expect(spy).not.toHaveBeenCalled()
    expect(processingCandidates(f)).toEqual([])
    expect(f.db.prepare('SELECT error_summary FROM commitment_extractor_runs').get()!.error_summary).toBe('INVALID_SNAPSHOT: 冻结来源快照无效')
  })
  it('来源或其正文缺失必须失败，之前已生成的候选项也回滚', () => {
    const f = processingFixture()
    f.db.prepare('DELETE FROM batch_item_message_sources WHERE batch_item_id=? AND source_position=1').run(f.itemId)
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('failed')
    expect(processingCandidates(f)).toEqual([])
    expect(processingRun(f).error_summary).toBe('INVALID_FROZEN_SOURCE_POSITION: 冻结来源或正文不完整')
    const missingBody = processingFixture()
    missingBody.db.exec('PRAGMA foreign_keys=OFF; DELETE FROM messages; PRAGMA foreign_keys=ON')
    expect(processCommitmentExtractorRun(missingBody.db, missingBody.itemId).status).toBe('failed')
    expect(processingCandidates(missingBody)).toEqual([])
  })
  it('不支持的冻结版本显式失败，不换用当前版本匹配', () => {
    const f = processingFixture(['我会回复你'])
    runs.registerCommitmentExtractorRun(f.db, f.itemId, f.jobId, '不支持的旧版本', [0])
    const spy = vi.spyOn(matcher, 'matchCommitmentBody')
    expect(processCommitmentExtractorRun(f.db, f.itemId, '不支持的旧版本').status).toBe('failed')
    expect(spy).not.toHaveBeenCalled()
    expect(runs.getCommitmentExtractorRun(f.db, f.itemId, '不支持的旧版本')!.error_summary)
      .toBe('UNSUPPORTED_RULE_VERSION: 冻结规则版本不受支持')
    expect(processingRun(f).status).toBe('pending')
  })
  it('旧完成和旧失败均不能覆盖较新代次的待处理、失败或成功状态', () => {
    const f = processingFixture(['我会回复你'])
    const first = runs.markCommitmentAttemptStarted(f.db, f.itemId, version)!
    const second = runs.markCommitmentAttemptStarted(f.db, f.itemId, version)!
    expect(runs.ownsCommitmentAttempt(f.db, f.itemId, version, first)).toBe(false)
    expect(runs.markCommitmentComplete(f.db, f.itemId, version, first)).toBe(false)
    expect(runs.markCommitmentFailed(f.db, f.itemId, version, first, '秘密')).toBe(false)
    runs.markCommitmentFailed(f.db, f.itemId, version, second, 'PROCESSING_FAILED')
    expect(runs.markCommitmentComplete(f.db, f.itemId, version, first)).toBe(false)
    expect(retryCommitmentExtractorRun(f.db, f.itemId).status).toBe('complete')
    const done = processingRun(f), candidates = processingCandidates(f)
    expect(runs.markCommitmentFailed(f.db, f.itemId, version, first, 'PROCESSING_FAILED')).toBe(false)
    expect(processingRun(f)).toEqual(done)
    expect(processingCandidates(f)).toEqual(candidates)
  })
  it('另一真实数据库连接接管并完成后，旧处理器回滚，不匹配或写候选项', () => {
    const f = processingFixture(['我会回复你']), other = new DatabaseSync(f.path)
    const original = runs.markCommitmentAttemptStarted, spy = vi.spyOn(matcher, 'matchCommitmentBody')
    try {
      vi.spyOn(runs, 'markCommitmentAttemptStarted').mockImplementationOnce((db, id, ruleVersion, expected) => {
        const first = original(db, id, ruleVersion, expected)
        const second = original(other, id, ruleVersion)!
        runs.markCommitmentComplete(other, id, ruleVersion, second)
        return first
      })
      expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('stale_attempt')
      expect(processingRun(f)).toMatchObject({ status: 'complete', attempt_count: 2 })
      expect(processingCandidates(f)).toEqual([])
      expect(spy).not.toHaveBeenCalled()
    } finally { other.close() }
  })
  it('旧快照校验失败也无权标记较新代次失败；最终失去完成权会回滚本次候选项', () => {
    const f = processingFixture(['我会回复你'])
    vi.spyOn(contracts, 'parseCommitmentSourcePositions').mockImplementationOnce(() => {
      const second = runs.markCommitmentAttemptStarted(f.db, f.itemId, version)!
      runs.markCommitmentComplete(f.db, f.itemId, version, second)
      throw new Error('秘密旧代次故障')
    })
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('stale_attempt')
    expect(processingRun(f).status).toBe('complete')
    const lost = processingFixture(['我会回复你'])
    vi.spyOn(runs, 'markCommitmentComplete').mockReturnValueOnce(false)
    expect(processCommitmentExtractorRun(lost.db, lost.itemId).status).toBe('stale_attempt')
    expect(processingCandidates(lost)).toEqual([])
  })
  it('普通处理不能把并发失败当成自动重试；重试只接受失败，不混入核心事务或伪造运行记录', () => {
    const f = processingFixture(['我会回复你']), original = runs.markCommitmentAttemptStarted
    expect(retryCommitmentExtractorRun(f.db, f.itemId).status).toBe('not_failed')
    f.db.exec('BEGIN IMMEDIATE')
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('pending')
    expect(processingRun(f).attempt_count).toBe(0)
    f.db.exec('ROLLBACK')
    vi.spyOn(runs, 'markCommitmentAttemptStarted').mockImplementationOnce((db, id, ruleVersion, expected) => {
      const attempt = original(db, id, ruleVersion)!
      runs.markCommitmentFailed(db, id, ruleVersion, attempt, 'PROCESSING_FAILED')
      return original(db, id, ruleVersion, expected)
    })
    expect(processCommitmentExtractorRun(f.db, f.itemId).status).toBe('stale_attempt')
    expect(processingRun(f).status).toBe('failed')
    expect(processCommitmentExtractorRun(f.db, '不存在').status).toBe('not_found')
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(1)
  })
})
