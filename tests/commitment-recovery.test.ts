import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBatchImportItem } from '../src/main/batch-import/repository'
import { migrateBatchImportSchema } from '../src/main/batch-import/schema'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { COMMITMENT_RULE_VERSION } from '../src/main/commitment/matcher'
import * as matcher from '../src/main/commitment/matcher'
import * as processor from '../src/main/commitment/processor'
import { getCommitmentExtractorRun, markCommitmentAttemptStarted, markCommitmentFailed } from '../src/main/commitment/runs'
import { processPendingCommitmentExtractorRuns, schedulePendingCommitmentExtractorRuns } from '../src/main/commitment/recovery'
import { cleanupRadarFixtures, ingestRadarItem, radarCount, radarFixture, radarMessages } from './keyword-radar-fixture'
import { commitmentCoreFingerprint, commitmentMessages } from './commitment-processing-fixture'
import { prepareSchemaV7Fixture } from './schema-v7-fixture'

const version = COMMITMENT_RULE_VERSION
afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
function prepared() {
  const f = radarFixture()
  f.items.push(createBatchImportItem(f.db, f.session.id, 2), createBatchImportItem(f.db, f.session.id, 3))
  f.items.forEach((_item, index) => ingestRadarItem(f, index, commitmentMessages(['我会回复你'])))
  return f
}

describe('承诺待处理恢复与历史边界', () => {
  it('只处理已登记待处理记录，失败需要显式重试，已完成不重新处理', async () => {
    const f = prepared(), failedId = f.items[2].id, completeId = f.items[3].id
    markCommitmentFailed(f.db, failedId, version, markCommitmentAttemptStarted(f.db, failedId, version)!, 'PROCESSING_FAILED')
    processor.processCommitmentExtractorRun(f.db, completeId)
    const failed = getCommitmentExtractorRun(f.db, failedId, version), complete = getCommitmentExtractorRun(f.db, completeId, version)
    const before = commitmentCoreFingerprint(f)
    const results = await processPendingCommitmentExtractorRuns(f.db)
    expect(results.map(result => result.batchItemId).sort()).toEqual(f.items.slice(0, 2).map(item => item.id).sort())
    expect(results.every(result => result.status === 'complete')).toBe(true)
    expect(getCommitmentExtractorRun(f.db, failedId, version)).toEqual(failed)
    expect(getCommitmentExtractorRun(f.db, completeId, version)).toEqual(complete)
    expect(commitmentCoreFingerprint(f)).toBe(before)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(3)
  })
  it('单个处理器异常或损坏快照不阻断其他待处理记录，日志只含受控类别', async () => {
    const f = prepared(), log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(processor, 'processCommitmentExtractorRun').mockImplementationOnce(() => { throw new Error('秘密聊天与路径') })
    const first = await processPendingCommitmentExtractorRuns(f.db)
    expect(first).toHaveLength(3)
    expect(log.mock.calls).toEqual([['[承诺提取] RECOVERY_FAILED']])
    vi.restoreAllMocks()
    const pending = f.items.find(item => getCommitmentExtractorRun(f.db, item.id, version)!.status === 'pending')!
    f.db.exec('DROP TRIGGER immutable_commitment_run; PRAGMA ignore_check_constraints=ON')
    f.db.prepare('UPDATE commitment_extractor_runs SET source_positions_snapshot_json=? WHERE batch_item_id=?').run('{}', pending.id)
    f.db.exec('PRAGMA ignore_check_constraints=OFF')
    expect(await processPendingCommitmentExtractorRuns(f.db)).toMatchObject([{ batchItemId: pending.id, status: 'failed' }])
  })
  it('按附件项过滤，强重复的新来源正常处理；异步触发不阻塞导入返回', async () => {
    const f = prepared(), selected = f.items[0].id
    schedulePendingCommitmentExtractorRuns(f.db, [selected, selected])
    expect(getCommitmentExtractorRun(f.db, selected, version)!.status).toBe('pending')
    for (let tick = 0; tick < 6; tick++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(getCommitmentExtractorRun(f.db, selected, version)!.status).toBe('complete')
    expect(getCommitmentExtractorRun(f.db, f.items[1].id, version)!.status).toBe('pending')
    expect(radarCount(f.db, 'messages')).toBe(1)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(1)
  })
  it('关闭的连接和核心事务不运行恢复，查询失败不创建任务且日志不泄露输入', async () => {
    const f = prepared()
    f.db.exec('BEGIN IMMEDIATE')
    expect(await processPendingCommitmentExtractorRuns(f.db)).toEqual([])
    f.db.exec('ROLLBACK')
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(f.db, 'prepare').mockImplementationOnce(() => { throw new Error('秘密聊天和路径') })
    expect(await processPendingCommitmentExtractorRuns(f.db)).toEqual([])
    expect(log.mock.calls).toEqual([['[承诺提取] RECOVERY_FAILED']])
    vi.restoreAllMocks()
    // 专用无文件连接验证退出边界，不干扰共用临时库清理。
    const { DatabaseSync } = await import('node:sqlite')
    const closed = new DatabaseSync(':memory:')
    closed.close()
    expect(await processPendingCommitmentExtractorRuns(closed)).toEqual([])
    schedulePendingCommitmentExtractorRuns(closed)
    await new Promise<void>(resolve => setImmediate(resolve))
  })
  it('隔离旧库三百零九条消息、同量全文索引和一百零四条来源，迁移与恢复均不生成历史任务', async () => {
    const f = radarFixture()
    prepareSchemaV7Fixture(f.db)
    const messages = radarMessages(Array.from({ length: 309 }, (_value, index) => index + 1))
      .map((message, index) => ({ ...message, content: `我会处理历史问题${index}` }))
    expect(ingestWorkBuddyMessages(f.db, { messages }).importedCount).toBe(309)
    expect(ingestRadarItem(f, 0, messages.slice(0, 104))).toMatchObject({ importedCount: 0, duplicateCount: 104 })
    migrateBatchImportSchema(f.db)
    const before = commitmentCoreFingerprint(f), spy = vi.spyOn(matcher, 'matchCommitmentBody')
    expect(await processPendingCommitmentExtractorRuns(f.db)).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    expect(commitmentCoreFingerprint(f)).toBe(before)
    expect(radarCount(f.db, 'messages')).toBe(309)
    expect(radarCount(f.db, 'messages_fts')).toBe(309)
    expect(radarCount(f.db, 'batch_item_message_sources')).toBe(104)
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(0)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
    // 功能启用前的同一来源重放仍不补建运行记录；按时间戳划线也不能替代真实新增来源。
    expect(ingestRadarItem(f, 0, messages.slice(0, 104)).status).toBe('success')
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(0)
    expect(ingestRadarItem(f, 1, messages.slice(0, 1))).toMatchObject({ importedCount: 0, duplicateCount: 1 })
    expect(await processPendingCommitmentExtractorRuns(f.db)).toMatchObject([{ batchItemId: f.items[1].id, status: 'complete', candidateCount: 1 }])
    expect(radarCount(f.db, 'messages')).toBe(309)
    expect(radarCount(f.db, 'messages_fts')).toBe(309)
    expect(radarCount(f.db, 'batch_item_message_sources')).toBe(105)
    expect(f.db.prepare('SELECT batch_item_id FROM commitment_candidates').all()).toEqual([{ batch_item_id: f.items[1].id }])
  })
  it('没有来源身份的单卡和普通导入保持成功，但不创建候选项或运行记录', async () => {
    const f = radarFixture()
    expect(ingestWorkBuddyMessages(f.db, { messages: commitmentMessages(['我会回复你']) }).status).toBe('success')
    expect(await processPendingCommitmentExtractorRuns(f.db)).toEqual([])
    expect(radarCount(f.db, 'batch_item_message_sources')).toBe(0)
    expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(0)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0)
  })
  it('桌面启动仅增加异步待处理恢复，不增加通信；连接器沿用既有无启动恢复的生命周期', () => {
    const desktop = readFileSync(resolve('src/main/index.ts'), 'utf8')
    expect(desktop).toContain('createWindow()\n  schedulePendingKeywordRadarRuns(db)\n  schedulePendingCommitmentExtractorRuns(db)')
    expect(desktop).not.toMatch(/ipcMain\.handle\(['"]commitment/)
    expect(desktop).not.toContain('await processPendingCommitmentExtractorRuns')
    const connector = readFileSync(resolve('src/main/integrations/workbuddy/server.ts'), 'utf8')
    expect(connector).not.toContain('schedulePendingCommitmentExtractorRuns')
    expect(connector).not.toContain('schedulePendingKeywordRadarRuns')
  })
})
