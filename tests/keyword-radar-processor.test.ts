import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as matcher from '../src/main/keyword-radar/matcher'
import * as contracts from '../src/main/keyword-radar/contracts'
import * as runs from '../src/main/keyword-radar/runs'
import { processKeywordRadarRun, retryKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { createKeywordGroup, addKeywordTerm, renameKeywordGroup, archiveKeywordGroup, setKeywordTermEnabled } from '../src/main/keyword-radar/config'
import { radarFixture, radarMessages, ingestRadarItem, radarCount, cleanupRadarFixtures } from './keyword-radar-fixture'

type Fixture = ReturnType<typeof radarFixture>
afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
function prepared(numbers = [1, 2, 3]) {
  const f = radarFixture()
  const group = createKeywordGroup(f.db, '旧组名称')
  addKeywordTerm(f.db, group.id, 'Codex')
  ingestRadarItem(f, 0, radarMessages(numbers))
  return { ...f, group, itemId: f.items[0].id }
}
function rawRun(f: Fixture, ordinal = 0): runs.KeywordRadarRun {
  return f.db.prepare('SELECT * FROM keyword_radar_runs WHERE batch_item_id=?').get(f.items[ordinal].id) as unknown as runs.KeywordRadarRun
}
/** 只构造隔离坏数据；正式实现绝不替换冻结 Run。 */
function replaceFixtureSnapshot(f: Fixture, changes: Partial<runs.KeywordRadarRun>) {
  const old = { ...rawRun(f), ...changes }
  f.db.prepare('DELETE FROM keyword_radar_runs WHERE batch_item_id=?').run(old.batch_item_id)
  f.db.prepare(`INSERT INTO keyword_radar_runs
    (batch_item_id,core_import_job_id,status,rules_snapshot_json,source_positions_snapshot_json,created_at)
    VALUES (?,?,?,?,?,?)`).run(old.batch_item_id, old.core_import_job_id, old.status,
      old.rules_snapshot_json, old.source_positions_snapshot_json, old.created_at)
}
function hits(f: Fixture) { return f.db.prepare('SELECT * FROM keyword_hits ORDER BY batch_item_id,source_position,group_id').all() }
function coreFingerprint(f: Fixture): string {
  const tables = f.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'keyword_%' ORDER BY name`).all()
  return createHash('sha256').update(JSON.stringify(tables.map(table => {
    const name = String(table.name)
    return [name, f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]
  }))).digest('hex')
}
function insertExisting(f: Fixture, name?: string, terms?: string) {
  const snapshot = contracts.parseRulesSnapshot(rawRun(f).rules_snapshot_json)
  const matched = matcher.matchKeywordSnapshot('Codex', snapshot)[0]
  f.db.prepare(`INSERT INTO keyword_hits VALUES ('原命中',?,?,?,?,?,?)`).run(
    matched.group_id, f.items[0].id, 0, name ?? matched.group_name,
    terms ?? JSON.stringify(matched.matched_terms), '2020-01-01T00:00:00.000Z')
}
describe('关键词雷达处理、重试与原子持久化', () => {
  it('仅匹配冻结位置，不扫描整个附件；正文未知时间仍匹配', () => {
    const f = prepared()
    replaceFixtureSnapshot(f, { source_positions_snapshot_json: '[0,2]' })
    expect(processKeywordRadarRun(f.db, f.itemId)).toMatchObject({ status: 'complete', hitCount: 2, attempt: 1 })
    expect(hits(f).map(hit => hit.source_position)).toEqual([0, 2])
    expect(rawRun(f).status).toBe('complete')
  })
  it('所有原始业务表和证据文件不变，仅命中和 Run 执行字段变化', () => {
    const f = prepared()
    const evidence = join(f.directory, '隔离证据.txt')
    writeFileSync(evidence, '隔离证据不可更改')
    const before = coreFingerprint(f), bytes = readFileSync(evidence)
    const frozen = rawRun(f)
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('complete')
    expect(coreFingerprint(f)).toBe(before)
    expect(readFileSync(evidence)).toEqual(bytes)
    const after = rawRun(f)
    for (const field of ['rules_snapshot_json', 'source_positions_snapshot_json', 'core_import_job_id', 'created_at'] as const)
      expect(after[field]).toBe(frozen[field])
    expect(f.db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('当前配置新增、禁用、重命名、归档都不改变冻结结果', () => {
    const f = prepared([1])
    const frozen = contracts.parseRulesSnapshot(rawRun(f).rules_snapshot_json)
    addKeywordTerm(f.db, f.group.id, '隔离关键词')
    setKeywordTermEnabled(f.db, frozen.groups[0].terms[0].term_id, false)
    renameKeywordGroup(f.db, f.group.id, '新组名称')
    archiveKeywordGroup(f.db, f.group.id)
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('complete')
    expect(hits(f)[0].group_name_snapshot).toBe('旧组名称')
    expect(contracts.parseMatchedTermsSnapshot(String(hits(f)[0].matched_terms_snapshot)).terms).toEqual(frozen.groups[0].terms)
  })
  it('同组多词一条命中，多组分别命中，重叠词完整保留', () => {
    const f = radarFixture()
    const a = createKeywordGroup(f.db, '工具'), b = createKeywordGroup(f.db, '生态')
    for (const term of ['Codex', 'Codex CLI', 'MCP']) addKeywordTerm(f.db, a.id, term)
    addKeywordTerm(f.db, b.id, 'MCP')
    ingestRadarItem(f, 0, [{ ...radarMessages([1])[0], content: 'Codex CLI 支持 MCP' }])
    expect(processKeywordRadarRun(f.db, f.items[0].id).hitCount).toBe(2)
    const frozen = contracts.parseRulesSnapshot(rawRun(f).rules_snapshot_json)
    expect(hits(f).map(hit => contracts.parseMatchedTermsSnapshot(String(hit.matched_terms_snapshot)).terms))
      .toEqual(frozen.groups.map(group => group.terms))
  })
  it('空冻结规则仍校验来源并完成，不读取后来新增的词', () => {
    const f = radarFixture()
    ingestRadarItem(f)
    addKeywordTerm(f.db, createKeywordGroup(f.db, '后来').id, 'Codex')
    expect(processKeywordRadarRun(f.db, f.items[0].id)).toMatchObject({ status: 'complete', hitCount: 0 })
    expect(hits(f)).toEqual([])
  })
  it('未知聊天时间不阻止正文匹配，发现时间不是聊天时间', () => {
    const f = radarFixture()
    addKeywordTerm(f.db, createKeywordGroup(f.db, '工具').id, 'Codex')
    ingestRadarItem(f, 0, [{ ...radarMessages([1])[0], timestamp: undefined, timestamp_source: 'unknown' }])
    const source = f.db.prepare('SELECT source_timestamp,source_timestamp_source FROM batch_item_message_sources').get()
    expect(source).toMatchObject({ source_timestamp: null, source_timestamp_source: 'unknown' })
    const start = Date.now()
    expect(processKeywordRadarRun(f.db, f.items[0].id).status).toBe('complete')
    expect(Date.parse(String(hits(f)[0].matched_at))).toBeGreaterThanOrEqual(start)
  })
  it('强身份重复新增 canonical 为零，但第二个附件拥有自己的命中', () => {
    const f = prepared([1])
    expect(ingestRadarItem(f, 1, radarMessages([1]))).toMatchObject({ importedCount: 0, duplicateCount: 1 })
    expect(processKeywordRadarRun(f.db, f.items[0].id).hitCount).toBe(1)
    expect(processKeywordRadarRun(f.db, f.items[1].id).hitCount).toBe(1)
    expect(hits(f).map(hit => hit.batch_item_id).sort()).toEqual(f.items.map(item => item.id).sort())
    expect(radarCount(f.db, 'messages')).toBe(1)
  })
  it.each(['pending', 'failed', 'complete'] as const)('同附件重放不创建新 Run，原状态 %s 的处理契约保持', status => {
    const f = prepared([1])
    if (status !== 'pending') {
      const attempt = runs.markKeywordRadarAttemptStarted(f.db, f.itemId)!
      if (status === 'failed') runs.markKeywordRadarFailed(f.db, f.itemId, attempt, 'PROCESSING_FAILED')
      else processKeywordRadarRun(f.db, f.itemId)
    }
    const frozen = rawRun(f)
    ingestRadarItem(f, 0, radarMessages([1]))
    expect(rawRun(f)).toEqual(frozen)
    expect(radarCount(f.db, 'keyword_radar_runs')).toBe(1)
    const expected = status === 'pending' ? 'complete' : status === 'failed' ? 'retry_required' : 'already_complete'
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe(expected)
  })
  it('完整 Run 再处理或再重试不匹配、不增加代次、不改命中时间', () => {
    const f = prepared([1])
    processKeywordRadarRun(f.db, f.itemId)
    const before = rawRun(f), beforeHits = hits(f)
    const spy = vi.spyOn(matcher, 'matchKeywordSnapshot')
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('already_complete')
    expect(retryKeywordRadarRun(f.db, f.itemId).status).toBe('already_complete')
    expect(spy).not.toHaveBeenCalled()
    expect(rawRun(f)).toEqual(before)
    expect(hits(f)).toEqual(beforeHits)
  })
  it('第 2 条命中插入失败，全部新命中回滚，独立持久化失败', () => {
    const f = prepared()
    f.db.exec(`CREATE TEMP TRIGGER reject_second_hit BEFORE INSERT ON keyword_hits
      WHEN (SELECT count(*) FROM keyword_hits)=1 BEGIN SELECT RAISE(ABORT,'隔离失败'); END;`)
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('failed')
    expect(hits(f)).toEqual([])
    expect(rawRun(f)).toMatchObject({ status: 'failed', attempt_count: 1, error_summary: 'PROCESSING_FAILED: 派生处理失败' })
  })
  it('命中插入后完成 SQL 失败，命中全部回滚，失败状态单独提交', () => {
    const f = prepared()
    f.db.exec(`CREATE TEMP TRIGGER reject_complete BEFORE UPDATE ON keyword_radar_runs
      WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'隔离失败'); END;`)
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('failed')
    expect(hits(f)).toEqual([])
    expect(rawRun(f).status).toBe('failed')
  })
  it('匹配异常后仅显式重试可完成；不持久化正文、路径或堆栈', () => {
    const f = prepared([1])
    vi.spyOn(matcher, 'matchKeywordSnapshot').mockImplementationOnce(() => { throw new Error('秘密聊天 C:\\秘密路径 堆栈') })
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('failed')
    expect(hits(f)).toEqual([])
    expect(rawRun(f).error_summary).toBe('PROCESSING_FAILED: 派生处理失败')
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('retry_required')
    expect(retryKeywordRadarRun(f.db, f.itemId)).toMatchObject({ status: 'complete', attempt: 2, hitCount: 1 })
    const first = hits(f)
    expect(retryKeywordRadarRun(f.db, f.itemId).status).toBe('already_complete')
    expect(hits(f)).toEqual(first)
  })
  it('失败状态写入自身失败时保留安全 pending，恢复后可处理', () => {
    const f = prepared([1])
    vi.spyOn(matcher, 'matchKeywordSnapshot').mockImplementationOnce(() => { throw new Error('秘密') })
    f.db.exec(`CREATE TEMP TRIGGER reject_failed BEFORE UPDATE ON keyword_radar_runs
      WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'秘密'); END;`)
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('pending')
    expect(rawRun(f).status).toBe('pending')
    expect(hits(f)).toEqual([])
    expect(log).toHaveBeenCalledWith('[关键词雷达] FAILURE_PERSISTENCE_FAILED')
    f.db.exec('DROP TRIGGER reject_failed')
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('complete')
  })
  it('旧失败不能覆盖较新成功；旧完成不能覆盖较新 pending 或 failed', () => {
    const f = prepared([1])
    const a = runs.markKeywordRadarAttemptStarted(f.db, f.itemId)!
    const b = runs.markKeywordRadarAttemptStarted(f.db, f.itemId)!
    expect(runs.markKeywordRadarComplete(f.db, f.itemId, a)).toBe(false)
    expect(runs.markKeywordRadarFailed(f.db, f.itemId, b, 'PROCESSING_FAILED')).toBe(true)
    expect(runs.markKeywordRadarComplete(f.db, f.itemId, a)).toBe(false)
    expect(retryKeywordRadarRun(f.db, f.itemId).status).toBe('complete')
    const done = rawRun(f), doneHits = hits(f)
    expect(runs.markKeywordRadarFailed(f.db, f.itemId, a, 'PROCESSING_FAILED')).toBe(false)
    expect(runs.markKeywordRadarComplete(f.db, f.itemId, a)).toBe(false)
    expect(rawRun(f)).toEqual(done)
    expect(hits(f)).toEqual(doneHits)
  })
  it('取得代次后被新代次完成，旧处理器不写命中', () => {
    const f = prepared([1])
    const original = runs.markKeywordRadarAttemptStarted
    vi.spyOn(runs, 'markKeywordRadarAttemptStarted').mockImplementationOnce((db, id, expected) => {
      const a = original(db, id, expected)
      const b = original(db, id)!
      runs.markKeywordRadarComplete(db, id, b)
      return a
    })
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('stale_attempt')
    expect(rawRun(f)).toMatchObject({ status: 'complete', attempt_count: 2 })
    expect(hits(f)).toEqual([])
  })
  it('较新代次完成后旧快照验证抛错，不得把完成覆盖成失败', () => {
    const f = prepared([1])
    vi.spyOn(contracts, 'parseRulesSnapshot').mockImplementationOnce(() => {
      const b = runs.markKeywordRadarAttemptStarted(f.db, f.itemId)!
      runs.markKeywordRadarComplete(f.db, f.itemId, b)
      throw new Error('隔离旧代次失败')
    })
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('stale_attempt')
    expect(rawRun(f)).toMatchObject({ status: 'complete', attempt_count: 2 })
  })
  it('普通 pending 取得代次不会把并发 failed 自动转为重试', () => {
    const f = prepared([1])
    const original = runs.markKeywordRadarAttemptStarted
    vi.spyOn(runs, 'markKeywordRadarAttemptStarted').mockImplementationOnce((db, id, expected) => {
      const a = original(db, id)!
      runs.markKeywordRadarFailed(db, id, a, 'PROCESSING_FAILED')
      return original(db, id, expected)
    })
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('stale_attempt')
    expect(rawRun(f)).toMatchObject({ status: 'failed', attempt_count: 1 })
    expect(hits(f)).toEqual([])
  })
  it('已有相同命中验证后幂等保留原 ID 和发现时间', () => {
    const f = prepared([1])
    insertExisting(f)
    const before = hits(f)
    expect(processKeywordRadarRun(f.db, f.itemId)).toMatchObject({ status: 'complete', hitCount: 1 })
    expect(hits(f)).toEqual(before)
  })
  it.each(['名称不同', '词不同', '损坏词快照'])('已有命中 %s 必须失败且不覆盖', kind => {
    const f = prepared([1])
    insertExisting(f, kind === '名称不同' ? '不同名称' : undefined,
      kind === '词不同' ? '{"snapshot_version":1,"terms":[{"term_id":"另一个","term":"MCP","normalized_term":"mcp"}]}' :
        kind === '损坏词快照' ? '{}' : undefined)
    const before = hits(f)
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('failed')
    expect(rawRun(f).error_summary).toBe('HIT_CONFLICT: 已有命中与冻结规则不一致')
    expect(hits(f)).toEqual(before)
  })
  it.each([
    '不是 JSON', '{"snapshot_version":2,"matching_version":"literal-nfc-ascii-v1","groups":[]}',
    '{"snapshot_version":1,"matching_version":"其他","groups":[]}',
    '{"snapshot_version":1,"matching_version":"literal-nfc-ascii-v1","groups":[{"group_name":"组","terms":[]}]}',
    '{"snapshot_version":1,"matching_version":"literal-nfc-ascii-v1","groups":[{"group_id":"g","group_name":"组","terms":[{}]}]}',
    '{"snapshot_version":1,"matching_version":"literal-nfc-ascii-v1","groups":[{"group_id":"g","group_name":"组","terms":[{"term_id":"t","term":"Codex","normalized_term":""}]}]}',
    '{"snapshot_version":1,"matching_version":"literal-nfc-ascii-v1","groups":[{"group_id":"g","group_name":"组","terms":[{"term_id":"t","term":"Codex","normalized_term":"CODEX"}]}]}'
  ])('坏规则快照失败，绝不读取当前配置修复：%s', json => {
    const f = prepared([1])
    f.db.exec('PRAGMA ignore_check_constraints=ON')
    replaceFixtureSnapshot(f, { rules_snapshot_json: json })
    f.db.exec('PRAGMA ignore_check_constraints=OFF')
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('failed')
    expect(rawRun(f).error_summary).toBe('INVALID_SNAPSHOT: 冻结快照无效')
    expect(hits(f)).toEqual([])
  })
  it.each(['[]', '[0,0]', '[1,0]', '[-1]', '{}', '损坏'])('坏来源位置快照 %s 不得处理', positions => {
    const f = prepared([1])
    f.db.exec('PRAGMA ignore_check_constraints=ON')
    replaceFixtureSnapshot(f, { source_positions_snapshot_json: positions })
    f.db.exec('PRAGMA ignore_check_constraints=OFF')
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('failed')
    expect(hits(f)).toEqual([])
  })
  it('冻结位置 5 不存在，之前生成的命中全部回滚', () => {
    const f = prepared([1])
    replaceFixtureSnapshot(f, { source_positions_snapshot_json: '[0,5]' })
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('failed')
    expect(hits(f)).toEqual([])
    expect(rawRun(f).error_summary).toBe('OCCURRENCE_INTEGRITY_FAILED: 冻结来源关联不完整')
  })
  it('关联指向的正文丢失必须失败，不跳过完成', () => {
    const f = prepared([1])
    f.db.exec('PRAGMA foreign_keys=OFF; DELETE FROM messages; PRAGMA foreign_keys=ON')
    const before = coreFingerprint(f)
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('failed')
    expect(hits(f)).toEqual([])
    expect(coreFingerprint(f)).toBe(before)
  })
  it('空规则也不得跳过来源完整性检查', () => {
    const f = radarFixture()
    ingestRadarItem(f)
    replaceFixtureSnapshot(f, { source_positions_snapshot_json: '[5]' })
    expect(processKeywordRadarRun(f.db, f.items[0].id).status).toBe('failed')
  })
  it('处理器不混入核心事务，不存在 Run 不创建，pending 不走失败重试', () => {
    const f = prepared([1])
    expect(retryKeywordRadarRun(f.db, f.itemId).status).toBe('not_pending')
    f.db.exec('BEGIN IMMEDIATE')
    expect(processKeywordRadarRun(f.db, f.itemId).status).toBe('pending')
    expect(rawRun(f).attempt_count).toBe(0)
    f.db.exec('ROLLBACK')
    expect(processKeywordRadarRun(f.db, '不存在').status).toBe('not_found')
    expect(radarCount(f.db, 'keyword_radar_runs')).toBe(1)
  })
})
