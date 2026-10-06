import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBatchImportItem } from '../src/main/batch-import/repository'
import { createKeywordGroup, addKeywordTerm } from '../src/main/keyword-radar/config'
import { processPendingKeywordRadarRuns, schedulePendingKeywordRadarRuns } from '../src/main/keyword-radar/recovery'
import * as processor from '../src/main/keyword-radar/processor'
import { getKeywordRadarRun, markKeywordRadarAttemptStarted, markKeywordRadarFailed } from '../src/main/keyword-radar/runs'
import { cleanupRadarFixtures, radarFixture, ingestRadarItem, radarMessages, radarCount } from './keyword-radar-fixture'

afterEach(() => { vi.restoreAllMocks(); cleanupRadarFixtures() })
function prepared() {
  const f = radarFixture()
  const group = createKeywordGroup(f.db, '工具')
  addKeywordTerm(f.db, group.id, 'Codex')
  f.items.push(createBatchImportItem(f.db, f.session.id, 2), createBatchImportItem(f.db, f.session.id, 3))
  for (let index = 0; index < 4; index++) ingestRadarItem(f, index, radarMessages([index + 1]))
  return f
}
describe('关键词雷达轻量待处理恢复', () => {
  it('只处理 pending A/B，不自动重试 failed C，不重新处理 complete D', async () => {
    const f = prepared()
    const c = f.items[2].id, d = f.items[3].id
    markKeywordRadarFailed(f.db, c, markKeywordRadarAttemptStarted(f.db, c)!, 'PROCESSING_FAILED')
    processor.processKeywordRadarRun(f.db, d)
    const beforeC = getKeywordRadarRun(f.db, c), beforeD = getKeywordRadarRun(f.db, d)
    const results = await processPendingKeywordRadarRuns(f.db)
    expect(results.map(result => result.batchItemId).sort()).toEqual(f.items.slice(0, 2).map(item => item.id).sort())
    expect(results.every(result => result.status === 'complete')).toBe(true)
    expect(getKeywordRadarRun(f.db, c)).toEqual(beforeC)
    expect(getKeywordRadarRun(f.db, d)).toEqual(beforeD)
    expect(radarCount(f.db, 'keyword_hits')).toBe(3)
  })
  it('一个匹配失败不阻断后续 Run，启动恢复不会抛到调用方', async () => {
    const f = prepared()
    vi.spyOn(processor, 'processKeywordRadarRun').mockImplementationOnce(() => { throw new Error('秘密') })
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const results = await processPendingKeywordRadarRuns(f.db)
    expect(results).toHaveLength(3)
    expect(results.every(result => result.status === 'complete')).toBe(true)
    expect(log).toHaveBeenCalledWith('[关键词雷达] RECOVERY_FAILED')
    expect(f.db.prepare("SELECT count(*) AS n FROM keyword_radar_runs WHERE status='pending'").get()!.n).toBe(1)
  })
  it('坏快照不阻断其他 Run，并按单 Run 持久化 failed', async () => {
    const f = prepared()
    const old = getKeywordRadarRun(f.db, f.items[0].id)!
    f.db.prepare('DELETE FROM keyword_radar_runs WHERE batch_item_id=?').run(old.batch_item_id)
    f.db.prepare(`INSERT INTO keyword_radar_runs
      (batch_item_id,core_import_job_id,status,rules_snapshot_json,source_positions_snapshot_json,created_at)
      VALUES (?,?,'pending','{}',?,?)`).run(old.batch_item_id, old.core_import_job_id, old.source_positions_snapshot_json, old.created_at)
    const results = await processPendingKeywordRadarRuns(f.db)
    expect(results.filter(result => result.status === 'failed')).toHaveLength(1)
    expect(results.filter(result => result.status === 'complete')).toHaveLength(3)
  })
  it('按本次附件 ID 过滤，强重复零新增也正常处理自己的新来源', async () => {
    const f = radarFixture()
    addKeywordTerm(f.db, createKeywordGroup(f.db, '工具').id, 'Codex')
    ingestRadarItem(f, 0, radarMessages([1]))
    ingestRadarItem(f, 1, radarMessages([1]))
    const result = await processPendingKeywordRadarRuns(f.db, [f.items[1].id, f.items[1].id])
    expect(result).toMatchObject([{ batchItemId: f.items[1].id, status: 'complete', hitCount: 1 }])
    expect(getKeywordRadarRun(f.db, f.items[0].id)!.status).toBe('pending')
    expect(radarCount(f.db, 'messages')).toBe(1)
  })
  it('异步触发返回时尚未处理，随后正常恢复；退出后的关闭连接不再访问', async () => {
    const f = prepared()
    schedulePendingKeywordRadarRuns(f.db, [f.items[0].id])
    expect(getKeywordRadarRun(f.db, f.items[0].id)!.status).toBe('pending')
    for (let tick = 0; tick < 5; tick++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(getKeywordRadarRun(f.db, f.items[0].id)!.status).toBe('complete')
    expect(getKeywordRadarRun(f.db, f.items[1].id)!.status).toBe('pending')
  })
  it('没有历史 Run 时不扫描来源、不创建任何 Run 或 Hit', async () => {
    const f = radarFixture()
    expect(await processPendingKeywordRadarRuns(f.db)).toEqual([])
    expect(radarCount(f.db, 'keyword_hits')).toBe(0)
    expect(radarCount(f.db, 'keyword_radar_runs')).toBe(0)
  })
  it('数据库查询失败仅输出安全诊断，不改变核心内容', async () => {
    const f = prepared()
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(f.db, 'prepare').mockImplementationOnce(() => { throw new Error('秘密聊天与路径') })
    expect(await processPendingKeywordRadarRuns(f.db)).toEqual([])
    expect(log.mock.calls).toEqual([['[关键词雷达] RECOVERY_FAILED']])
    expect(radarCount(f.db, 'messages')).toBe(4)
  })
  it('主程序在窗口创建后仅安排异步恢复，不增加渲染通信或公开导出', () => {
    const source = readFileSync(resolve('src/main/index.ts'), 'utf8')
    expect(source).toContain('createWindow()\n  schedulePendingKeywordRadarRuns(db)')
    expect(source).not.toMatch(/ipcMain\.handle\(['"]keyword/)
    expect(source).not.toMatch(/await processPendingKeywordRadarRuns/)
  })
})
