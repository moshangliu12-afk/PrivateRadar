import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupRadarFixtures, radarFixture, radarMessages, ingestRadarItem, radarCount } from './keyword-radar-fixture'
import { normalizeKeywordTermV1 } from '../src/main/keyword-radar/normalization'
import * as config from '../src/main/keyword-radar/config'
import { parseRulesSnapshot, parseSourcePositionsSnapshot, parseMatchedTermsSnapshot } from '../src/main/keyword-radar/contracts'
import * as runs from '../src/main/keyword-radar/runs'
import { bindItemMessageSource, listItemMessageSources, type OccurrenceSourceFacts } from '../src/main/batch-import/message-sources'

afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
const unknown: OccurrenceSourceFacts = { senderName: '', senderNameSource: 'unknown', timestamp: '',
  timestampSource: 'unknown', conversationName: '', conversationNameSource: 'unknown' }
function freeze(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE')
  try { return config.freezeKeywordRules(db) } finally { db.exec('ROLLBACK') }
}
function coreState(db: DatabaseSync) {
  return ['messages', 'messages_fts_data', 'messages_fts_idx', 'batch_item_message_sources', 'keyword_radar_runs']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all())
}

describe('关键词独立规范化及配置', () => {
  it.each([
    ['  Codex\t', 'codex'], ['Cafe\u0301', 'café'], ['ＡＢＣ', 'ＡＢＣ'], ['İÜßABC', 'İÜßabc'],
    ['A  B\tC', 'a  b\tc'], ['👩‍💻👍🏽!A', '👩‍💻👍🏽!a'], ['繁體、简体。123', '繁體、简体。123']
  ])('仅按约定规范化 %s', (input, expected) => { expect(normalizeKeywordTermV1(input)).toBe(expected) })
  it.each(['', ' \t\r\n '])('拒绝空关键词 %s', input => {
    expect(() => normalizeKeywordTermV1(input)).toThrow('KEYWORD_TERM_EMPTY')
    const f = radarFixture(), group = config.createKeywordGroup(f.db, '规则')
    expect(() => config.addKeywordTerm(f.db, group.id, input)).toThrow()
    expect(config.listKeywordTerms(f.db, group.id)).toEqual([])
  })
  it('同组规范词唯一，包括停用的旧词；重新启用保留原标识、文本及时间', () => {
    const f = radarFixture(), group = config.createKeywordGroup(f.db, '规则')
    const term = config.addKeywordTerm(f.db, group.id, ' Codex ')
    expect(term).toMatchObject({ term: 'Codex', normalized_term: 'codex', enabled: 1 })
    expect(() => config.addKeywordTerm(f.db, group.id, 'CODEX')).toThrow()
    config.setKeywordTermEnabled(f.db, term.id, false)
    expect(() => config.addKeywordTerm(f.db, group.id, 'codex')).toThrow()
    config.setKeywordTermEnabled(f.db, term.id, true)
    expect(config.listKeywordTerms(f.db, group.id)).toEqual([term])
    expect(config.addKeywordTerm(f.db, config.createKeywordGroup(f.db, '另组').id, 'CODEX').normalized_term).toBe('codex')
  })
  it('词文本不可原地改写，不存在物理删除接口', () => {
    const f = radarFixture(), group = config.createKeywordGroup(f.db, '规则'), term = config.addKeywordTerm(f.db, group.id, 'Codex')
    expect(() => f.db.prepare('UPDATE keyword_terms SET term=? WHERE id=?').run('变化', term.id)).toThrow('KEYWORD_TERM_IMMUTABLE')
    expect(() => f.db.prepare('DELETE FROM keyword_groups WHERE id=?').run(group.id)).toThrow()
    expect(config.listKeywordTerms(f.db, group.id)).toEqual([term])
  })
  it('分组改名、启停、归档保留记录；归档后不得新增词或重新启用', () => {
    const f = radarFixture(), group = config.createKeywordGroup(f.db, '  规则  ')
    config.renameKeywordGroup(f.db, group.id, '新名')
    config.setKeywordGroupEnabled(f.db, group.id, false)
    expect(freeze(f.db).groups).toEqual([])
    config.setKeywordGroupEnabled(f.db, group.id, true)
    expect(freeze(f.db).groups[0].group_name).toBe('新名')
    config.archiveKeywordGroup(f.db, group.id)
    expect(config.listKeywordGroups(f.db)[0]).toMatchObject({ enabled: 0, archived_at: expect.any(String), created_at: group.created_at })
    expect(() => config.addKeywordTerm(f.db, group.id, '新词')).toThrow()
    expect(() => config.setKeywordGroupEnabled(f.db, group.id, true)).toThrow()
    expect(freeze(f.db).groups).toEqual([])
  })
  it('拒绝空组名和不存在的配置标识', () => {
    const f = radarFixture()
    expect(() => config.createKeywordGroup(f.db, ' ')).toThrow()
    expect(() => config.renameKeywordGroup(f.db, '不存在', '新名')).toThrow()
    expect(() => config.setKeywordTermEnabled(f.db, '不存在', true)).toThrow()
    expect(() => config.addKeywordTerm(f.db, '不存在', '词')).toThrow()
  })
  it('快照只读启用未归档组及启用词，按组和词标识排序，保留空组', () => {
    const f = radarFixture()
    for (const [id, enabled, archived] of [['z', 1, null], ['a', 1, null], ['b', 0, null], ['c', 1, '已归档']] as const) {
      f.db.prepare('INSERT INTO keyword_groups VALUES (?,?,?,?,?,?)').run(id, `组${id}`, enabled, archived, '创建', '创建')
    }
    for (const [id, groupId, enabled] of [['z2', 'z', 1], ['z1', 'z', 1], ['z0', 'z', 0], ['b1', 'b', 1], ['c1', 'c', 1]] as const) {
      f.db.prepare('INSERT INTO keyword_terms VALUES (?,?,?,?,?,?)').run(id, groupId, id, id, enabled, '创建')
    }
    const snapshot = freeze(f.db)
    expect(snapshot).toEqual({ snapshot_version: 1, matching_version: 'literal-nfc-ascii-v1', groups: [
      { group_id: 'a', group_name: '组a', terms: [] },
      { group_id: 'z', group_name: '组z', terms: ['z1', 'z2'].map(id => ({ term_id: id, term: id, normalized_term: id })) }
    ] })
    expect(freeze(f.db)).toEqual(snapshot)
  })
  it('空规则合法且冻结必须在事务中', () => {
    const f = radarFixture()
    expect(freeze(f.db)).toEqual({ snapshot_version: 1, matching_version: 'literal-nfc-ascii-v1', groups: [] })
    expect(() => config.freezeKeywordRules(f.db)).toThrow('TRANSACTION_REQUIRED')
  })
})

describe('来源事实和原子 Run 登记', () => {
  it('新来源保存自身 normalized 事实，并创建未执行的 pending Run；不生成 Hit', () => {
    const f = radarFixture(), result = ingestRadarItem(f)
    expect(result).toMatchObject({ status: 'success', importedCount: 2 })
    expect(listItemMessageSources(f.db, f.items[0].id)[0]).toMatchObject({
      source_sender_name: '隔离发送人', source_sender_name_source: 'user_supplied',
      source_timestamp: '2026-10-06T01:00:00.000Z', source_timestamp_source: 'source_native',
      source_conversation_name: '隔离群', source_conversation_name_source: 'user_supplied'
    })
    const run = runs.getKeywordRadarRun(f.db, f.items[0].id)!
    expect(run).toMatchObject({ status: 'pending', core_import_job_id: result.jobId, attempt_count: 0, processed_at: null })
    expect(parseSourcePositionsSnapshot(run.source_positions_snapshot_json)).toEqual([0, 1])
    expect(parseRulesSnapshot(run.rules_snapshot_json).groups).toEqual([])
    expect(radarCount(f.db, 'keyword_hits')).toBe(0)
  })
  it('缺失发送人、群名和时间以 NULL 值及合法 unknown 标记登记', () => {
    const f = radarFixture()
    expect(ingestRadarItem(f, 0, [{ content: '缺少元数据' }]).status).toBe('success')
    expect(listItemMessageSources(f.db, f.items[0].id)[0]).toMatchObject({
      source_sender_name: null, source_sender_name_source: 'unknown', source_timestamp: null,
      source_timestamp_source: 'unknown', source_conversation_name: null, source_conversation_name_source: 'unknown'
    })
  })
  it.each(['sender_name', 'timestamp', 'conversation_name'] as const)('强身份重复隔离 occurrence 的 %s，canonical 与 FTS 原样保留', field => {
    const f = radarFixture(), input = radarMessages([1])[0]
    ingestRadarItem(f, 0, [input])
    const canonical = f.db.prepare('SELECT rowid,* FROM messages').all(), fts = f.db.prepare('SELECT * FROM messages_fts_data').all()
    const sourceA = listItemMessageSources(f.db, f.items[0].id)
    const value = field === 'timestamp' ? '2026-10-07T09:00:00+08:00' : '另一来源显示值'
    expect(ingestRadarItem(f, 1, [{ ...input, [field]: value }])).toMatchObject({ importedCount: 0, duplicateCount: 1, updatedCount: 0 })
    expect(f.db.prepare('SELECT rowid,* FROM messages').all()).toEqual(canonical)
    expect(f.db.prepare('SELECT * FROM messages_fts_data').all()).toEqual(fts)
    expect(listItemMessageSources(f.db, f.items[0].id)).toEqual(sourceA)
    expect(listItemMessageSources(f.db, f.items[1].id)[0][`source_${field}`])
      .toBe(field === 'timestamp' ? '2026-10-07T01:00:00.000Z' : value)
    expect(parseSourcePositionsSnapshot(runs.getKeywordRadarRun(f.db, f.items[1].id)!.source_positions_snapshot_json)).toEqual([0])
  })
  it('旧四列写入在数据库和应用两层均被拒绝，合法新版 binder 返回真实 insert 结果', () => {
    const f = radarFixture(); ingestRadarItem(f, 0, radarMessages([1]))
    const source = listItemMessageSources(f.db, f.items[0].id)[0]
    expect(() => f.db.prepare('INSERT INTO batch_item_message_sources (batch_item_id,source_position,message_id,created_at) VALUES (?,?,?,?)')
      .run(f.items[1].id, 0, source.message_id, '旧端')).toThrow('SOURCE_OCCURRENCE_METADATA_REQUIRED')
    expect(() => bindItemMessageSource(f.db, f.items[1].id, 0, source.message_id, '旧端', undefined as unknown as OccurrenceSourceFacts)).toThrow('SOURCE_OCCURRENCE_METADATA_REQUIRED')
    expect(bindItemMessageSource(f.db, f.items[1].id, 0, source.message_id, '首次', unknown)).toBe(true)
    const before = listItemMessageSources(f.db, f.items[1].id)
    expect(bindItemMessageSource(f.db, f.items[1].id, 0, source.message_id, '重放', unknown)).toBe(false)
    expect(listItemMessageSources(f.db, f.items[1].id)).toEqual(before)
  })
  it('非法来源标记失败关闭，已登记来源不可改写', () => {
    const f = radarFixture(); ingestRadarItem(f, 0, radarMessages([1]))
    const source = listItemMessageSources(f.db, f.items[0].id)[0]
    expect(() => bindItemMessageSource(f.db, f.items[1].id, 0, source.message_id, '非法',
      { ...unknown, timestampSource: '非法' } as unknown as OccurrenceSourceFacts)).toThrow()
    expect(() => f.db.prepare(`INSERT INTO batch_item_message_sources
      (batch_item_id,source_position,message_id,created_at,source_sender_name_source,source_timestamp_source,source_conversation_name_source)
      VALUES (?,0,?,'创建','unknown','非法','unknown')`).run(f.items[1].id, source.message_id)).toThrow()
    expect(() => f.db.prepare('UPDATE batch_item_message_sources SET source_sender_name=? WHERE batch_item_id=?')
      .run('改写', f.items[0].id)).toThrow('SOURCE_OCCURRENCE_IMMUTABLE')
  })
  it.each(['pending', 'failed', 'complete'] as const)('同 Item 重放保留 %s Run 的原规则、核心 Job 和来源集合', status => {
    const f = radarFixture(), group = config.createKeywordGroup(f.db, '原名')
    const term = config.addKeywordTerm(f.db, group.id, 'Codex')
    ingestRadarItem(f)
    if (status !== 'pending') {
      const attempt = runs.markKeywordRadarAttemptStarted(f.db, f.items[0].id)!
      if (status === 'failed') runs.markKeywordRadarFailed(f.db, f.items[0].id, attempt, 'PROCESSING_FAILED')
      else runs.markKeywordRadarComplete(f.db, f.items[0].id, attempt)
    }
    const run = runs.getKeywordRadarRun(f.db, f.items[0].id), sources = listItemMessageSources(f.db, f.items[0].id)
    config.renameKeywordGroup(f.db, group.id, '改名'); config.setKeywordTermEnabled(f.db, term.id, false)
    config.addKeywordTerm(f.db, group.id, '新增'); config.archiveKeywordGroup(f.db, group.id)
    expect(ingestRadarItem(f)).toMatchObject({ status: 'success', importedCount: 0, duplicateCount: 2 })
    expect(runs.getKeywordRadarRun(f.db, f.items[0].id)).toEqual(run)
    expect(listItemMessageSources(f.db, f.items[0].id)).toEqual(sources)
    expect(radarCount(f.db, 'keyword_radar_runs')).toBe(1)
  })
  it('部分成功不压缩位置，只登记 [0,2]，保留原有 partial Job 语义', () => {
    const f = radarFixture(), messages = [radarMessages([1])[0], { content: '无效时间', timestamp: '不是日期' }, radarMessages([2])[0]]
    const result = ingestRadarItem(f, 0, messages)
    expect(result).toMatchObject({ status: 'partial', importedCount: 2, invalidCount: 1 })
    expect(parseSourcePositionsSnapshot(runs.getKeywordRadarRun(f.db, f.items[0].id)!.source_positions_snapshot_json)).toEqual([0, 2])
    expect(f.db.prepare('SELECT status FROM import_jobs WHERE id=?').get(result.jobId)).toEqual({ status: 'partial' })
  })
  it.each([{ messages: [] }, { messages: [{ content: '无效', timestamp: '不是日期' }] }])('无新来源不创建 Run', ({ messages }) => {
    const f = radarFixture(); ingestRadarItem(f, 0, messages)
    expect(radarCount(f.db, 'keyword_radar_runs')).toBe(0)
    expect(radarCount(f.db, 'batch_item_message_sources')).toBe(0)
  })
  it.each(['登记失败', '序列化失败', '配置读取失败', '来源冲突'] as const)('%s 原子回滚消息、FTS、来源及 Run，旧 Item 原样保留', failure => {
    const f = radarFixture(); ingestRadarItem(f, 0, radarMessages([1]))
    if (failure === '来源冲突') {
      bindItemMessageSource(f.db, f.items[1].id, 1, listItemMessageSources(f.db, f.items[0].id)[0].message_id, '既有', unknown)
    }
    const before = coreState(f.db)
    if (failure === '登记失败') f.db.exec(`CREATE TRIGGER reject_run BEFORE INSERT ON keyword_radar_runs
      BEGIN SELECT RAISE(ABORT,'登记失败'); END`)
    if (failure === '序列化失败') {
      const stringify = JSON.stringify
      vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, replacer: never, space: never) => {
        if (value && typeof value === 'object' && 'matching_version' in value) throw new Error('快照序列化失败')
        return stringify(value, replacer, space)
      }) as typeof JSON.stringify)
    }
    if (failure === '配置读取失败') vi.spyOn(config, 'freezeKeywordRules').mockImplementation(() => { throw new Error('配置读取失败') })
    const result = ingestRadarItem(f, 1, radarMessages([2, 3]))
    vi.restoreAllMocks()
    expect(result).toMatchObject({ status: 'failed', importedCount: 0, updatedCount: 0 })
    expect(coreState(f.db)).toEqual(before)
    expect(f.db.prepare('SELECT status,imported_count FROM import_jobs WHERE id=?').get(result.jobId)).toEqual({ status: 'failed', imported_count: 0 })
  })
})

describe('Run 快照契约及重试代次', () => {
  it.each(['batch_item_id', 'core_import_job_id', 'rules_snapshot_json', 'source_positions_snapshot_json', 'created_at'])('数据库禁止改写 Run 的 %s', field => {
    const f = radarFixture(); ingestRadarItem(f)
    const before = runs.getKeywordRadarRun(f.db, f.items[0].id)
    const value = field.endsWith('_json') ? '[]' : '改写'
    expect(() => f.db.prepare(`UPDATE keyword_radar_runs SET ${field}=? WHERE batch_item_id=?`).run(value, f.items[0].id))
      .toThrow('KEYWORD_RADAR_RUN_IMMUTABLE')
    expect(runs.getKeywordRadarRun(f.db, f.items[0].id)).toEqual(before)
  })
  it('失败重试持久化不改快照，旧失败不能覆盖后一代成功，包括不同连接', () => {
    const f = radarFixture(); ingestRadarItem(f)
    const original = runs.getKeywordRadarRun(f.db, f.items[0].id)!
    const a = runs.markKeywordRadarAttemptStarted(f.db, f.items[0].id)!
    expect(runs.markKeywordRadarFailed(f.db, f.items[0].id, a, 'PROCESSING_FAILED')).toBe(true)
    expect(runs.listFailedKeywordRadarRuns(f.db)).toHaveLength(1)
    const second = new DatabaseSync(f.path)
    try {
      const b = runs.markKeywordRadarAttemptStarted(second, f.items[0].id)!
      expect(b).toBe(a + 1)
      expect(runs.markKeywordRadarComplete(second, f.items[0].id, b)).toBe(true)
      expect(runs.markKeywordRadarFailed(f.db, f.items[0].id, a, 'PROCESSING_FAILED')).toBe(false)
      expect(runs.markKeywordRadarAttemptStarted(f.db, f.items[0].id)).toBeNull()
      expect(runs.getKeywordRadarRun(f.db, f.items[0].id)).toMatchObject({ status: 'complete', attempt_count: b,
        rules_snapshot_json: original.rules_snapshot_json, source_positions_snapshot_json: original.source_positions_snapshot_json,
        core_import_job_id: original.core_import_job_id, created_at: original.created_at })
      expect(runs.listPendingKeywordRadarRuns(f.db)).toEqual([])
      expect(runs.listFailedKeywordRadarRuns(f.db)).toEqual([])
    } finally { second.close() }
  })
  it('两个在途代次中 B 完成后，A 不得再写失败或完成', () => {
    const f = radarFixture(); ingestRadarItem(f)
    const a = runs.markKeywordRadarAttemptStarted(f.db, f.items[0].id)!, b = runs.markKeywordRadarAttemptStarted(f.db, f.items[0].id)!
    expect(runs.markKeywordRadarFailed(f.db, f.items[0].id, a, 'UNKNOWN')).toBe(false)
    expect(runs.markKeywordRadarComplete(f.db, f.items[0].id, b)).toBe(true)
    expect(runs.markKeywordRadarFailed(f.db, f.items[0].id, a, 'UNKNOWN')).toBe(false)
    expect(runs.markKeywordRadarComplete(f.db, f.items[0].id, a)).toBe(false)
  })
  it.each(['聊天正文'.repeat(300), new Error('敏感正文和本地路径'), { stack: '敏感堆栈' }, '__proto__'])('错误摘要只保存固定短码，不保存输入 %s', error => {
    const f = radarFixture(); ingestRadarItem(f)
    const attempt = runs.markKeywordRadarAttemptStarted(f.db, f.items[0].id)!
    expect(runs.markKeywordRadarFailed(f.db, f.items[0].id, attempt, error)).toBe(true)
    const summary = runs.getKeywordRadarRun(f.db, f.items[0].id)!.error_summary!
    expect(summary).toBe('UNKNOWN: 派生处理异常'); expect(summary.length).toBeLessThanOrEqual(160)
    expect(() => f.db.prepare('UPDATE keyword_radar_runs SET error_summary=?').run('x'.repeat(161))).toThrow()
  })
  it('尚未领取、不存在的 Run 或零代次不得结束，内部列表稳定', () => {
    const f = radarFixture(); ingestRadarItem(f)
    expect(runs.markKeywordRadarComplete(f.db, f.items[0].id, 0)).toBe(false)
    expect(runs.markKeywordRadarFailed(f.db, f.items[0].id, 0, 'UNKNOWN')).toBe(false)
    expect(runs.markKeywordRadarAttemptStarted(f.db, '不存在')).toBeNull()
    expect(runs.getKeywordRadarRun(f.db, '不存在')).toBeNull()
    expect(runs.listPendingKeywordRadarRuns(f.db).map(run => run.batch_item_id)).toEqual([f.items[0].id])
  })
  it('命中词 JSON 仅定义稳定版本契约，不写入 Hit', () => {
    const payload = { snapshot_version: 1, terms: [{ term_id: '词', term: 'Codex', normalized_term: 'codex' }] }
    expect(parseMatchedTermsSnapshot(JSON.stringify(payload))).toEqual(payload)
    for (const invalid of [{ ...payload, snapshot_version: 2 }, { ...payload, body: '不允许正文' },
      { snapshot_version: 1, terms: [] }, { ...payload, terms: [{ term_id: '词', term: 'Codex', normalized_term: '错误' }] }]) {
      expect(() => parseMatchedTermsSnapshot(JSON.stringify(invalid))).toThrow()
    }
    const f = radarFixture(); expect(radarCount(f.db, 'keyword_hits')).toBe(0)
  })
  it.each(['[]', '[0,0]', '[2,0]', '[-1]', '[0.5]', '[9007199254740992]'])('拒绝无效来源位置快照 %s', json => {
    expect(() => parseSourcePositionsSnapshot(json)).toThrow()
  })
})
