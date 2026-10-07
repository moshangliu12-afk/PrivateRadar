import { afterEach, describe, expect, it } from 'vitest'
import type { SQLInputValue } from 'node:sqlite'
import { createCommitmentCandidate, getCommitmentCandidate, listCandidatesForRun, reviewCommitmentCandidate } from '../src/main/commitment/candidates'
import { getCommitmentExtractorRun, listPendingCommitmentExtractorRuns, registerCommitmentExtractorRun } from '../src/main/commitment/runs'
import { parseCommitmentSourcePositions, type CommitmentReviewStatus } from '../src/main/commitment/contracts'
import { candidateInput, commitmentFixture, commitmentVersion, registerFixtureRun } from './commitment-fixture'
import { cleanupRadarFixtures, ingestRadarItem, radarCount, radarFixture, radarMessages } from './keyword-radar-fixture'

afterEach(cleanupRadarFixtures)

describe('来源锚定的承诺候选项', () => {
  it('创建必须关联真实来源、对应运行及冻结来源位置，不扫描正文或伪造来源', () => {
    const f = commitmentFixture()
    expect(() => createCommitmentCandidate(f.db, candidateInput(f))).toThrow()
    registerFixtureRun(f, 0, [0])
    expect(() => createCommitmentCandidate(f.db, candidateInput(f, 0, 1))).toThrow()
    expect(() => createCommitmentCandidate(f.db, candidateInput(f, 0, 99))).toThrow()
    expect(() => createCommitmentCandidate(f.db, candidateInput(f, 0, 0, '不存在的版本'))).toThrow()
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
    expect(createCommitmentCandidate(f.db, candidateInput(f))).toMatchObject({ status: 'pending', reviewed_at: null })
  })
  it('重复创建返回同一候选项并保留审核和生成快照，原因冲突受控，同一来源不同规则版本可分别创建', () => {
    const f = commitmentFixture()
    registerFixtureRun(f)
    const input = candidateInput(f), first = createCommitmentCandidate(f.db, input)
    expect(createCommitmentCandidate(f.db, input)).toEqual(first)
    const reviewed = reviewCommitmentCandidate(f.db, first.id, 'confirmed')
    expect(createCommitmentCandidate(f.db, input)).toEqual(reviewed)
    expect(() => createCommitmentCandidate(f.db, { ...input, reasonCode: '不同原因' })).toThrow(/冲突/)
    expect(() => createCommitmentCandidate(f.db, { ...input, ruleId: '不同规则' })).toThrow(/冲突/)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(1)
    registerFixtureRun(f, 0, [0], '承诺规则测试版本二')
    expect(createCommitmentCandidate(f.db, candidateInput(f, 0, 0, '承诺规则测试版本二')).id).not.toBe(first.id)
  })
  it('不同附件项具有同一规范消息与相同来源位置时，仍生成独立候选项并读取各自来源元数据', () => {
    const fixture = radarFixture()
    const firstJob = ingestRadarItem(fixture, 0).jobId
    const secondMessages = radarMessages().map(message => ({ ...message, sender_name: '另一个来源发送人',
      sender_name_source: 'user_supplied' as const, timestamp: '2026-10-07T10:00:00+08:00',
      timestamp_source: 'user_supplied' as const, conversation_name: '另一个来源会话' }))
    const secondJob = ingestRadarItem(fixture, 1, secondMessages).jobId
    fixture.db.exec('DELETE FROM commitment_extractor_runs')
    const f = { ...fixture, jobs: [firstJob, secondJob] }
    registerFixtureRun(f, 0); registerFixtureRun(f, 1)
    const first = createCommitmentCandidate(f.db, candidateInput(f, 0))
    const second = createCommitmentCandidate(f.db, candidateInput(f, 1))
    expect(first.id).not.toBe(second.id)
    const rows = f.db.prepare(`SELECT c.id,s.message_id,s.source_sender_name,s.source_timestamp,
      s.source_timestamp_source,s.source_conversation_name FROM commitment_candidates c
      JOIN batch_item_message_sources s ON s.batch_item_id=c.batch_item_id AND s.source_position=c.source_position`).all()
    expect(rows).toHaveLength(2)
    expect(rows[0].message_id).toBe(rows[1].message_id)
    const firstSource = rows.find(row => row.id === first.id)!, secondSource = rows.find(row => row.id === second.id)!
    expect(firstSource.source_timestamp_source).toBe('source_native')
    expect(secondSource.source_timestamp_source).toBe('user_supplied')
    expect(firstSource.source_sender_name).not.toBe(secondSource.source_sender_name)
    expect(firstSource.source_timestamp).not.toBe(secondSource.source_timestamp)
    expect(firstSource.source_conversation_name).not.toBe(secondSource.source_conversation_name)
    expect(getCommitmentCandidate(f.db, first.id)).toEqual(first)
    expect(getCommitmentCandidate(f.db, '不存在')).toBeNull()
    expect(listCandidatesForRun(f.db, f.items[0].id, commitmentVersion)).toEqual([first])
    expect(listCandidatesForRun(f.db, f.items[1].id, commitmentVersion)).toEqual([second])
  })
  it('数据库唯一约束阻止直接重复插入，复合来源外键阻止来源删除及缺失来源插入', () => {
    const f = commitmentFixture()
    registerFixtureRun(f)
    const first = createCommitmentCandidate(f.db, candidateInput(f))
    expect(() => f.db.prepare(`INSERT INTO commitment_candidates
      (id,batch_item_id,source_position,reason_code,rule_id,rule_version,created_at)
      SELECT '重复标识',batch_item_id,source_position,reason_code,rule_id,rule_version,created_at
      FROM commitment_candidates WHERE id=?`).run(first.id)).toThrow(/UNIQUE/)
    expect(() => f.db.prepare('DELETE FROM batch_item_message_sources WHERE batch_item_id=? AND source_position=0')
      .run(f.items[0].id)).toThrow(/FOREIGN KEY/)
    expect(() => f.db.prepare('DELETE FROM commitment_extractor_runs WHERE batch_item_id=?').run(f.items[0].id)).toThrow(/FOREIGN KEY/)
    f.db.prepare('DELETE FROM batch_item_message_sources WHERE batch_item_id=? AND source_position=1').run(f.items[0].id)
    expect(() => createCommitmentCandidate(f.db, candidateInput(f, 0, 1))).toThrow(/FOREIGN KEY/)
  })
  it.each(['id', 'batch_item_id', 'source_position', 'rule_version', 'created_at', 'reason_code', 'rule_id'])(
    '创建后 %s 不可修改，审核只修改状态和审核时间', field => {
      const f = commitmentFixture()
      registerFixtureRun(f)
      const candidate = createCommitmentCandidate(f.db, candidateInput(f))
      expect(() => f.db.prepare(`UPDATE commitment_candidates SET ${field}=? WHERE id=?`)
        .run(field === 'source_position' ? 1 : '修改值', candidate.id)).toThrow(/不可修改/)
      expect(getCommitmentCandidate(f.db, candidate.id)).toEqual(candidate)
    }
  )
  it.each(['confirmed', 'ignored'] as const)('待审核到 %s，同状态重复审核幂等，确认与忽略可互相纠正', initial => {
    const f = commitmentFixture()
    registerFixtureRun(f)
    const candidate = createCommitmentCandidate(f.db, candidateInput(f))
    const first = reviewCommitmentCandidate(f.db, candidate.id, initial)
    expect(first).toMatchObject({ status: initial, reviewed_at: expect.any(String) })
    // 固定已有审核时间，避免同毫秒重复调用使不正确的刷新实现蒙混通过。
    const changed = initial === 'confirmed' ? 'ignored' : 'confirmed'
    f.db.prepare('UPDATE commitment_candidates SET status=?,reviewed_at=? WHERE id=?')
      .run(changed, '2026-10-01T00:00:00Z', candidate.id)
    const before = getCommitmentCandidate(f.db, candidate.id)
    expect(reviewCommitmentCandidate(f.db, candidate.id, changed)).toEqual(before)
    expect(reviewCommitmentCandidate(f.db, candidate.id, initial).status).toBe(initial)
    expect(reviewCommitmentCandidate(f.db, candidate.id, changed).status).toBe(changed)
    expect(() => reviewCommitmentCandidate(f.db, candidate.id, 'pending' as CommitmentReviewStatus)).toThrow()
    expect(() => f.db.prepare("UPDATE commitment_candidates SET status='pending',reviewed_at=NULL WHERE id=?")
      .run(candidate.id)).toThrow(/不可重置/)
    expect(() => f.db.prepare('UPDATE commitment_candidates SET reviewed_at=? WHERE id=?').run('无意义刷新', candidate.id)).toThrow()
  })
  it.each([
    ['pending', '不应存在的审核时间'], ['confirmed', null], ['ignored', null],
    ['completed', '审核时间'], ['expired', '审核时间'], ['snoozed', '审核时间']
  ])('数据库拒绝状态与审核时间无效组合 %s / %s', (status, reviewedAt) => {
    const f = commitmentFixture()
    registerFixtureRun(f)
    const candidate = createCommitmentCandidate(f.db, candidateInput(f))
    expect(() => f.db.prepare('UPDATE commitment_candidates SET status=?,reviewed_at=? WHERE id=?')
      .run(status, reviewedAt, candidate.id)).toThrow()
    expect(getCommitmentCandidate(f.db, candidate.id)).toEqual(candidate)
  })
  it('直接插入也必须首次待审核，未知候选项不能审核', () => {
    const f = commitmentFixture()
    registerFixtureRun(f)
    expect(() => f.db.prepare(`INSERT INTO commitment_candidates
      (id,batch_item_id,source_position,status,reason_code,rule_id,rule_version,created_at,reviewed_at)
      VALUES ('提前确认',?,0,'confirmed','测试原因','测试规则',?,'创建时间','审核时间')`)
      .run(f.items[0].id, commitmentVersion)).toThrow(/首次创建/)
    expect(() => reviewCommitmentCandidate(f.db, '不存在', 'confirmed')).toThrow(/不存在/)
  })
  it('同一运行按来源位置稳定列出，来源和规则版本隔离，非法生成字段不落库', () => {
    const f = commitmentFixture()
    registerFixtureRun(f)
    const second = createCommitmentCandidate(f.db, candidateInput(f, 0, 1))
    const first = createCommitmentCandidate(f.db, candidateInput(f))
    expect(listCandidatesForRun(f.db, f.items[0].id, commitmentVersion)).toEqual([first, second])
    expect(listCandidatesForRun(f.db, f.items[0].id, '不存在的版本')).toEqual([])
    for (const field of ['reasonCode', 'ruleId', 'ruleVersion', 'batchItemId']) {
      expect(() => createCommitmentCandidate(f.db, { ...candidateInput(f), [field]: ' ' })).toThrow()
    }
    expect(() => createCommitmentCandidate(f.db, { ...candidateInput(f), sourcePosition: 0.5 })).toThrow()
    expect(radarCount(f.db, 'commitment_candidates')).toBe(2)
  })
})

describe('承诺提取运行记录持久化', () => {
  it('明确快照去重并按位置排序，不补全其他来源；相同登记幂等，冲突不重新冻结，版本形成独立主键', () => {
    const f = commitmentFixture(), input = [1, 0, 1]
    const run = registerFixtureRun(f, 0, input)
    expect(input).toEqual([1, 0, 1])
    expect(parseCommitmentSourcePositions(run.source_positions_snapshot_json)).toEqual([0, 1])
    expect(run).toMatchObject({ status: 'pending', attempt_count: 0, processed_at: null, error_summary: null })
    expect(registerFixtureRun(f, 0, [0, 1])).toEqual(run)
    expect(registerCommitmentExtractorRun(f.db, f.items[0].id, f.jobs[0], commitmentVersion, [0, 1], '不同登记时间')).toEqual(run)
    expect(() => registerFixtureRun(f, 0, [0])).toThrow(/冲突/)
    const anotherJob = ingestRadarItem(f, 0).jobId
    expect(anotherJob).not.toBe(f.jobs[0])
    expect(() => registerCommitmentExtractorRun(f.db, f.items[0].id, anotherJob, commitmentVersion, [0, 1])).toThrow(/冲突/)
    expect(getCommitmentExtractorRun(f.db, f.items[0].id, commitmentVersion)).toEqual(run)
    expect(getCommitmentExtractorRun(f.db, '不存在', commitmentVersion)).toBeNull()
    const empty = registerFixtureRun(f, 1, [])
    expect(empty.source_positions_snapshot_json).toBe('[]')
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
    const subset = registerFixtureRun(f, 0, [1], '承诺规则测试版本二')
    expect(subset.source_positions_snapshot_json).toBe('[1]')
    expect(listPendingCommitmentExtractorRuns(f.db)).toHaveLength(3)
    expect(() => f.db.prepare(`INSERT INTO commitment_extractor_runs SELECT * FROM commitment_extractor_runs
      WHERE batch_item_id=? AND rule_version=?`).run(f.items[0].id, commitmentVersion)).toThrow(/UNIQUE/)
  })
  it.each([[-1], [0.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], ['0'], null, undefined].map(value => [value]))(
    '输入校验拒绝无效来源位置 %j 且不留下运行记录', positions => {
      const f = commitmentFixture()
      expect(() => registerCommitmentExtractorRun(f.db, f.items[0].id, f.jobs[0], commitmentVersion, positions as number[])).toThrow()
      expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(0)
    }
  )
  it.each(['不是合法序列', '{}', 'null', '[null]', '[true]', '["0"]', '[-1]', '[0.5]', '[1,0]', '[0,0]', '[9007199254740992]'])(
    '直接插入拒绝无效来源快照 %s', json => {
      const f = commitmentFixture()
      expect(() => f.db.prepare(`INSERT INTO commitment_extractor_runs
        (batch_item_id,core_import_job_id,rule_version,source_positions_snapshot_json,created_at) VALUES (?,?,?,?,?)`)
        .run(f.items[0].id, f.jobs[0], commitmentVersion, json, '创建时间')).toThrow()
      expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(0)
    }
  )
  it('运行记录要求真实附件项、导入任务及正确归属，明确位置必须存在，引用对象不能删除', () => {
    const f = commitmentFixture()
    expect(() => registerFixtureRun(f, 0, [99])).toThrow(/不存在/)
    expect(() => registerCommitmentExtractorRun(f.db, '不存在的附件项', f.jobs[0], commitmentVersion, [])).toThrow()
    expect(() => registerCommitmentExtractorRun(f.db, f.items[0].id, '不存在的任务', commitmentVersion, [])).toThrow()
    expect(() => registerCommitmentExtractorRun(f.db, f.items[0].id, f.jobs[1], commitmentVersion, [0])).toThrow(/不一致/)
    const run = registerFixtureRun(f)
    const anotherJob = f.jobs[1]
    expect(() => registerCommitmentExtractorRun(f.db, f.items[0].id, anotherJob, commitmentVersion, [0, 1])).toThrow()
    expect(getCommitmentExtractorRun(f.db, f.items[0].id, commitmentVersion)).toEqual(run)
    expect(() => f.db.prepare('DELETE FROM import_jobs WHERE id=?').run(f.jobs[0])).toThrow(/FOREIGN KEY/)
    expect(() => f.db.prepare('DELETE FROM batch_import_items WHERE id=?').run(f.items[0].id)).toThrow(/FOREIGN KEY/)
  })
  it.each(['batch_item_id', 'rule_version', 'core_import_job_id', 'source_positions_snapshot_json', 'created_at'])(
    '运行记录冻结字段 %s 不可修改，未来尝试次数可增加且不能减少', field => {
      const f = commitmentFixture(), run = registerFixtureRun(f)
      expect(() => f.db.prepare(`UPDATE commitment_extractor_runs SET ${field}=? WHERE batch_item_id=? AND rule_version=?`)
        .run(field === 'source_positions_snapshot_json' ? '[0]' : '修改值', run.batch_item_id, run.rule_version)).toThrow(/不可修改/)
      f.db.exec('UPDATE commitment_extractor_runs SET attempt_count=1')
      expect(() => f.db.exec('UPDATE commitment_extractor_runs SET attempt_count=0')).toThrow(/不可减少/)
      expect(getCommitmentExtractorRun(f.db, run.batch_item_id, run.rule_version)).toEqual({ ...run, attempt_count: 1 })
    }
  )
  it.each([
    ['processing', null, null, 0], ['complete', null, null, 0], ['failed', '处理时间', null, 0],
    ['pending', '处理时间', null, 0], ['pending', null, '异常', 0], ['pending', null, null, -1],
    ['pending', null, null, 0.5], ['failed', '处理时间', '异常'.repeat(161), 1]
  ] as Array<[string, SQLInputValue, SQLInputValue, number]>)(
    '数据库拒绝无效运行状态、时间、错误或尝试次数 %s / %s / %s / %s', (status, processed, error, attempt) => {
      const f = commitmentFixture(), run = registerFixtureRun(f)
      expect(() => f.db.prepare('UPDATE commitment_extractor_runs SET status=?,processed_at=?,error_summary=?,attempt_count=?')
        .run(status, processed, error, attempt)).toThrow()
      expect(getCommitmentExtractorRun(f.db, run.batch_item_id, run.rule_version)).toEqual(run)
    }
  )
  it('仅查询待处理运行记录，支持调用方事务回滚，不自行执行或调度', () => {
    const f = commitmentFixture()
    f.db.exec('BEGIN IMMEDIATE')
    registerFixtureRun(f)
    createCommitmentCandidate(f.db, candidateInput(f))
    expect(f.db.isTransaction).toBe(true)
    f.db.exec('ROLLBACK')
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(0)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
    const complete = registerFixtureRun(f)
    const failed = registerFixtureRun(f, 1)
    f.db.prepare("UPDATE commitment_extractor_runs SET status='complete',attempt_count=1,processed_at='处理时间' WHERE batch_item_id=?")
      .run(complete.batch_item_id)
    f.db.prepare("UPDATE commitment_extractor_runs SET status='failed',attempt_count=1,processed_at='处理时间',error_summary='受控错误' WHERE batch_item_id=?")
      .run(failed.batch_item_id)
    expect(listPendingCommitmentExtractorRuns(f.db)).toEqual([])
  })
})
