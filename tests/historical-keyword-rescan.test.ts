import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { radarFixture, ingestRadarItem, radarMessages, cleanupRadarFixtures } from './keyword-radar-fixture'
import { createHistoricalRescanService } from '../src/main/keyword-radar/historical-rescan'
import { createKeywordGroup, addKeywordTerm, setKeywordTermEnabled, archiveKeywordGroup, renameKeywordGroup, freezeKeywordRules, setKeywordGroupEnabled } from '../src/main/keyword-radar/config'
import { processKeywordRadarRun, retryKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { matchKeywordSnapshot } from '../src/main/keyword-radar/matcher'
import { listRecentKeywordHits, getKeywordHitContext, getKeywordHitSource, registerKeywordRadarIpc } from '../src/main/keyword-radar/desktop'
import { initializeDatabase } from '../src/main/schema'
import { ensureHistoricalRescanSchema } from '../src/main/keyword-radar/historical-rescan-schema'
import { setConversationLabel } from '../src/main/conversation-labels'
import { bindItemMessageSource } from '../src/main/batch-import/message-sources'
import { openKeywordHitEvidence } from '../src/main/keyword-radar/evidence-navigation'

afterEach(cleanupRadarFixtures)
type Fixture = ReturnType<typeof radarFixture>
function rule(f: Fixture, term = 'Codex', name = '测试规则') {
  const group = createKeywordGroup(f.db, name), keyword = addKeywordTerm(f.db, group.id, term)
  return { group, keyword }
}
async function scan(f: Fixture, groupId: string) {
  const service = createHistoricalRescanService(f.db), state = service.start(groupId)
  await service.wait(state.id)
  return service.status(groupId)!
}
function originals(db: DatabaseSync) {
  const tables = db.prepare("SELECT name,sql,rootpage FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'keyword_%' ORDER BY name").all()
  return tables.map(table => ({ ...table, rows: db.prepare(`SELECT * FROM "${table.name}"`).all().map(row => JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value)).sort() }))
}
function directMessages(f: Fixture, count: number, body = (n: number) => `Codex 历史消息 ${n}`) {
  f.db.prepare("INSERT OR IGNORE INTO conversations(id,platform,name,created_at) VALUES('历史会话','wechat','原始群','2026-10-01')").run()
  const insert = f.db.prepare(`INSERT INTO messages(id,platform,conversation_id,sender_id,sender_name,timestamp,content,message_type,source,fingerprint,imported_at)
    VALUES(?,'wechat','历史会话','发送人','原始发送人','2026-10-01T12:30:00Z',?,'text','fixture',?,'2026-10-20')`)
  f.db.exec('BEGIN')
  try { for (let n = 0; n < count; n++) insert.run(`历史消息${n}`, body(n), `独立身份${n}`); f.db.exec('COMMIT') }
  catch (error) { f.db.exec('ROLLBACK'); throw error }
}

describe('手动历史关键词扫描', () => {
  it('先导入后创建规则不会自动扫，明确启动后命中且全部来源事实不变', async () => {
    const f = radarFixture(); ingestRadarItem(f)
    const { group } = rule(f), before = originals(f.db)
    const service = createHistoricalRescanService(f.db)
    expect(service.status(group.id)).toBeNull()
    expect(listRecentKeywordHits(f.db)).toEqual([])
    const started = service.start(group.id)
    expect(started).toMatchObject({ status: 'running', scannedMessages: 0, totalMessages: 2 })
    await service.wait(started.id)
    expect(service.status(group.id)).toMatchObject({ status: 'complete', scannedMessages: 2, matchedHits: 2, newHits: 2, existingHits: 0, removedHits: 0 })
    expect(originals(f.db)).toEqual(before)
    expect(f.db.prepare('PRAGMA database_list').all().filter(row => row.name === 'main')).toHaveLength(1)
  })
  it('同规则第二次扫描新增为零，命中身份与发现时间稳定', async () => {
    const f = radarFixture(); ingestRadarItem(f); const { group } = rule(f)
    await scan(f, group.id); const before = listRecentKeywordHits(f.db)
    expect(await scan(f, group.id)).toMatchObject({ status: 'complete', matchedHits: 2, newHits: 0, existingHits: 2, removedHits: 0 })
    expect(listRecentKeywordHits(f.db)).toEqual(before)
  })
  it('同一来源先 live 后历史不会双记，同正文不同消息身份不会合并', async () => {
    const f = radarFixture(), { group } = rule(f)
    ingestRadarItem(f, 0, radarMessages([1, 2]).map(message => ({ ...message, content: 'Codex 完全相同正文' })))
    expect(processKeywordRadarRun(f.db, f.items[0].id).status).toBe('complete')
    const before = listRecentKeywordHits(f.db)
    expect(new Set(before.map(hit => hit.messageId)).size).toBe(2)
    expect(await scan(f, group.id)).toMatchObject({ newHits: 0, existingHits: 2 })
    expect(listRecentKeywordHits(f.db)).toEqual(before)
  })
  it('同一原文来自两个真实来源时保留原 occurrence 语义', async () => {
    const f = radarFixture(); ingestRadarItem(f, 0, radarMessages([1])); ingestRadarItem(f, 1, radarMessages([1]))
    const { group } = rule(f)
    expect(await scan(f, group.id)).toMatchObject({ scannedMessages: 1, matchedHits: 2, newHits: 2 })
    const hits = listRecentKeywordHits(f.db)
    expect(new Set(hits.map(hit => hit.messageId)).size).toBe(1)
    expect(new Set(hits.map(hit => hit.batchItemId)).size).toBe(2)
    expect(await scan(f, group.id)).toMatchObject({ newHits: 0, existingHits: 2 })
  })
  it('Claude 改为 Claude Code 后清理失效命中，其他规则逐字不变', async () => {
    const f = radarFixture(); ingestRadarItem(f, 0, radarMessages().map((message, i) => ({ ...message, content: i ? 'Claude Code' : 'Claude' })))
    const a = rule(f, 'Claude', '待修改组'), b = rule(f, 'Claude', '保持组')
    await scan(f, a.group.id); await scan(f, b.group.id)
    const other = f.db.prepare('SELECT * FROM keyword_hits WHERE group_id=? ORDER BY id').all(b.group.id)
    setKeywordTermEnabled(f.db, a.keyword.id, false); addKeywordTerm(f.db, a.group.id, 'Claude Code')
    expect(listRecentKeywordHits(f.db).filter(hit => hit.groupId === a.group.id)).toHaveLength(2)
    expect(await scan(f, a.group.id)).toMatchObject({ matchedHits: 1, existingHits: 1, newHits: 0, removedHits: 1 })
    expect(listRecentKeywordHits(f.db).filter(hit => hit.groupId === a.group.id).map(hit => hit.body)).toEqual(['Claude Code'])
    expect(f.db.prepare('SELECT * FROM keyword_hits WHERE group_id=? ORDER BY id').all(b.group.id)).toEqual(other)
  })
  it('启用词全部清空后明确重扫移除该组旧结果', async () => {
    const f = radarFixture(); ingestRadarItem(f); const { group, keyword } = rule(f)
    await scan(f, group.id); setKeywordTermEnabled(f.db, keyword.id, false)
    expect(await scan(f, group.id)).toMatchObject({ matchedHits: 0, removedHits: 2 })
    expect(listRecentKeywordHits(f.db)).toEqual([])
  })
  it.each(['pending', 'failed'] as const)('历史校准后迟到的 %s 导入任务不会恢复旧词', async status => {
    const f = radarFixture(), { group, keyword } = rule(f, 'Claude')
    ingestRadarItem(f, 0, radarMessages().map((message, i) => ({ ...message, content: i ? 'Claude Code' : 'Claude' })))
    if (status === 'failed') f.db.prepare("UPDATE keyword_radar_runs SET status='failed' WHERE batch_item_id=?").run(f.items[0].id)
    setKeywordTermEnabled(f.db, keyword.id, false); addKeywordTerm(f.db, group.id, 'Claude Code')
    await scan(f, group.id)
    const before = listRecentKeywordHits(f.db)
    const result = status === 'pending' ? processKeywordRadarRun(f.db, f.items[0].id) : retryKeywordRadarRun(f.db, f.items[0].id)
    expect(result.status).toBe('complete'); expect(listRecentKeywordHits(f.db)).toEqual(before)
    expect(before.map(hit => hit.body)).toEqual(['Claude Code'])
  })
  it.each(['南京', 'Codex', 'Claude Code', 'A.B', 'é', '😀'])('关键词 %s 与正式 live matcher 完全一致', async term => {
    const f = radarFixture(), { group } = rule(f, term)
    const bodies = ['南京欢迎你', '南京市', 'CODEX', 'codex', 'Claude Code', 'Claude  Code', 'a.b', 'axb', 'e\u0301', '😀🚀', '无关内容']
    ingestRadarItem(f, 0, radarMessages(bodies.map((_, n) => n + 1)).map((message, n) => ({ ...message, content: bodies[n] })))
    f.db.exec('BEGIN'); const rules = freezeKeywordRules(f.db); f.db.exec('COMMIT')
    const expected = bodies.filter(body => matchKeywordSnapshot(body, rules).length).sort()
    processKeywordRadarRun(f.db, f.items[0].id)
    expect(listRecentKeywordHits(f.db).map(hit => hit.body).sort()).toEqual(expected)
    await scan(f, group.id)
    expect(listRecentKeywordHits(f.db).map(hit => hit.body).sort()).toEqual(expected)
  })
  it('无来源旧消息直接定位原文与自定义会话名，不捏造 Evidence 或聊天时间', async () => {
    const f = radarFixture(); directMessages(f, 2); const { group } = rule(f)
    setConversationLabel(f.db, '历史会话', '我的项目')
    f.db.prepare("UPDATE messages SET timestamp_source='inferred',sender_name_source='unknown' WHERE id='历史消息0'").run()
    const before = originals(f.db)
    expect(await scan(f, group.id)).toMatchObject({ matchedHits: 2, newHits: 2 })
    const hit = listRecentKeywordHits(f.db).find(hit => hit.messageId === '历史消息0')!
    expect(hit).toMatchObject({ batchItemId: null, displayConversationName: '我的项目', chatTimestamp: null, senderName: null })
    expect(getKeywordHitSource(f.db, hit.id)).toMatchObject({ batchItemId: null, evidenceKind: null, evidenceRecorded: false })
    expect(getKeywordHitContext(f.db, hit.id).entries.find(entry => entry.isCurrent)).toMatchObject({ messageId: hit.messageId, body: hit.body, displayConversationName: '我的项目', chatTimestamp: null, timestampSource: 'inferred' })
    let opened = false
    await expect(openKeywordHitEvidence(f.db, f.path, hit.id, async () => { opened = true; return '' })).rejects.toThrow('证据暂不可用')
    expect(opened).toBe(false)
    expect(originals(f.db)).toEqual(before)
    const ids = listRecentKeywordHits(f.db).map(hit => hit.id).sort()
    expect(await scan(f, group.id)).toMatchObject({ newHits: 0, existingHits: 2 })
    expect(listRecentKeywordHits(f.db).map(hit => hit.id).sort()).toEqual(ids)
  })
  it('无附件直接命中随后获得真实导入来源时只保留来源命中', async () => {
    const f = radarFixture(), messages = radarMessages([1])
    const { ingestWorkBuddyMessages } = await import('../src/main/integrations/workbuddy/ingest')
    ingestWorkBuddyMessages(f.db, { messages }, 0)
    const { group } = rule(f); await scan(f, group.id)
    expect(listRecentKeywordHits(f.db)[0].batchItemId).toBeNull()
    ingestRadarItem(f, 0, messages); processKeywordRadarRun(f.db, f.items[0].id)
    expect(listRecentKeywordHits(f.db)).toHaveLength(1)
    expect(listRecentKeywordHits(f.db)[0].batchItemId).toBe(f.items[0].id)
    expect(f.db.prepare('SELECT count(*) AS n FROM keyword_rescan_coverage WHERE matched_terms_snapshot IS NOT NULL').get()!.n).toBe(0)
  })
  it('分页提供进度且只允许一个任务，取消后可再次完整校准', async () => {
    const f = radarFixture(); directMessages(f, 300); const { group } = rule(f), other = rule(f, 'Codex', '另一组')
    const progress: number[] = []
    const service = createHistoricalRescanService(f.db, { onBatch(state) {
      expect(f.db.isTransaction).toBe(false)
      expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n).toBe(300)
      progress.push(state.scannedMessages); if (progress.length === 1) service.cancel(state.id)
    } })
    const state = service.start(group.id)
    expect(() => service.start(group.id)).toThrow('已有历史扫描')
    expect(() => createHistoricalRescanService(f.db).start(other.group.id)).toThrow('已有历史扫描')
    await service.wait(state.id)
    expect(service.status(group.id)).toMatchObject({ status: 'cancelled', scannedMessages: 128 })
    expect(await scan(f, group.id)).toMatchObject({ status: 'complete', scannedMessages: 300, matchedHits: 300, newHits: 172, existingHits: 128 })
  })
  it('同一原文的三百个真实来源分多页处理，来源导航仍定位正确', async () => {
    const f = radarFixture(); directMessages(f, 1)
    for (let n = 0; n < 300; n++) bindItemMessageSource(f.db, f.items[0].id, n, '历史消息0', '2026-10-01', {
      senderName: '真实来源发送人', senderNameSource: 'source_native', timestamp: '2026-10-01T12:00:00Z', timestampSource: 'source_native', conversationName: '来源群', conversationNameSource: 'source_native'
    })
    const { group } = rule(f)
    expect(await scan(f, group.id)).toMatchObject({ status: 'complete', scannedMessages: 1, matchedHits: 300, newHits: 300 })
    const hit = listRecentKeywordHits(f.db)[0]
    expect(getKeywordHitSource(f.db, hit.id).batchItemId).toBe(f.items[0].id)
    expect(getKeywordHitContext(f.db, hit.id).entries.find(entry => entry.isCurrent)?.sourcePosition).toBe(hit.sourcePosition)
    expect(await scan(f, group.id)).toMatchObject({ newHits: 0, existingHits: 300 })
  })
  it('扫描期间导入新消息正常处理，当前扫描保持起始消息边界', async () => {
    const f = radarFixture(); directMessages(f, 300); const { group } = rule(f)
    let imported = false
    const service = createHistoricalRescanService(f.db, { onBatch() {
      if (imported) return
      imported = true; ingestRadarItem(f, 0, radarMessages([10001]))
      expect(processKeywordRadarRun(f.db, f.items[0].id).status).toBe('complete')
    } })
    const run = service.start(group.id); await service.wait(run.id)
    expect(service.status(group.id)).toMatchObject({ status: 'complete', scannedMessages: 300, totalMessages: 300 })
    expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n).toBe(301)
    expect(f.db.prepare('SELECT count(*) AS n FROM keyword_hits').get()!.n).toBe(1)
    expect(await scan(f, group.id)).toMatchObject({ scannedMessages: 301, matchedHits: 301, newHits: 0, existingHits: 301 })
  })
  it.each(['改词', '改名', '停用', '归档'] as const)('扫描过程中%s会安全停止，不继续写入旧规则结果', async change => {
    const f = radarFixture(); directMessages(f, 300); const { group, keyword } = rule(f)
    const service = createHistoricalRescanService(f.db, { onBatch() {
      if (change === '改词') setKeywordTermEnabled(f.db, keyword.id, false)
      if (change === '改名') renameKeywordGroup(f.db, group.id, '新名称')
      if (change === '停用') setKeywordGroupEnabled(f.db, group.id, false)
      if (change === '归档') archiveKeywordGroup(f.db, group.id)
    } })
    const run = service.start(group.id); await service.wait(run.id)
    expect(service.status(group.id)).toMatchObject({ status: 'failed', scannedMessages: 128 })
    expect(listRecentKeywordHits(f.db)).toHaveLength(100)
    if (change === '归档') expect(() => service.start(group.id)).toThrow('归档')
    if (change === '改词') expect(await scan(f, group.id)).toMatchObject({ status: 'complete', matchedHits: 0, removedHits: 128 })
  })
  it('异常后保留安全批次，重扫最终一致', async () => {
    const f = radarFixture(); directMessages(f, 260); const { group } = rule(f), before = originals(f.db)
    const service = createHistoricalRescanService(f.db, { onBatch() { throw new Error('隔离故障') } })
    const run = service.start(group.id); await service.wait(run.id)
    expect(service.status(group.id)).toMatchObject({ status: 'failed', scannedMessages: 128 })
    expect(await scan(f, group.id)).toMatchObject({ status: 'complete', scannedMessages: 260, matchedHits: 260, newHits: 132, existingHits: 128 })
    expect(originals(f.db)).toEqual(before)
  })
  it('重启读取持久结果但不重新扫描，失联任务只在明确启动时收口', async () => {
    const f = radarFixture(); directMessages(f, 1); const { group } = rule(f)
    await scan(f, group.id)
    const before = f.db.prepare('SELECT * FROM keyword_rescans').all()
    const reopened = new DatabaseSync(f.path)
    try {
      initializeDatabase(reopened)
      expect(createHistoricalRescanService(reopened).status(group.id)?.status).toBe('complete')
      expect(reopened.prepare('SELECT * FROM keyword_rescans').all()).toEqual(before)
      const id = randomUUID()
      f.db.prepare("INSERT INTO keyword_rescans(id,group_id,rules_snapshot_json,owner_pid,status,total_messages,started_at) SELECT ?,group_id,rules_snapshot_json,?,'running',1,'2099' FROM keyword_rescans LIMIT 1").run(id, process.pid)
      const service = createHistoricalRescanService(reopened)
      expect(service.status(group.id)?.error).toContain('中断')
      expect(f.db.prepare('SELECT status FROM keyword_rescans WHERE id=?').get(id)!.status).toBe('running')
      const started = service.start(group.id); await service.wait(started.id)
      expect(f.db.prepare('SELECT status FROM keyword_rescans WHERE id=?').get(id)!.status).toBe('failed')
    } finally { reopened.close() }
  })
  it('仅添加派生表可从现有数据库升级，反复打开不改原表或 FTS', () => {
    const f = radarFixture(); ingestRadarItem(f)
    f.db.exec('DROP TABLE keyword_rescan_coverage; DROP TABLE keyword_rescans')
    const before = originals(f.db), version = f.db.prepare('PRAGMA user_version').get()
    ensureHistoricalRescanSchema(f.db); ensureHistoricalRescanSchema(f.db); initializeDatabase(f.db)
    expect(originals(f.db)).toEqual(before)
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual(version)
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('IPC 只接受规则编号，注册和查询不启动扫描，错误不暴露 SQL', async () => {
    const f = radarFixture(), { group } = rule(f), handlers = new Map<string, (...args: any[]) => any>()
    registerKeywordRadarIpc({ handle(name, handler) { handlers.set(name, handler) } }, f.db, async () => ({ batchItemId: '', opened: true }))
    expect(await handlers.get('keyword-radar:rescan-status')!(null, group.id)).toEqual({ ok: true, value: null })
    expect(await handlers.get('keyword-radar:rescan-start')!(null, "'; DROP TABLE messages")).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(f.db.prepare('SELECT count(*) AS n FROM keyword_rescans').get()!.n).toBe(0)
  })
})

describe('隔离规模验证', () => {
  it('一万条消息完成扫描与二扫，事件循环和数据库查询保持可用', async () => {
    const f = radarFixture(); directMessages(f, 10000, n => n % 7 === 0 ? `Codex 项目 ${n}` : `普通聊天 ${n}`)
    f.db.exec('BEGIN')
    for (let n = 0; n < 5000; n++) bindItemMessageSource(f.db, f.items[0].id, n, `历史消息${n}`, '2026-10-01', {
      senderName: '原始发送人', senderNameSource: 'source_native', timestamp: '2026-10-01T12:30:00Z', timestampSource: 'source_native', conversationName: '原始群', conversationNameSource: 'source_native'
    })
    f.db.exec('COMMIT')
    const { group } = rule(f), samples: number[] = [], counts: number[] = []
    const memoryBefore = process.memoryUsage(), started = performance.now()
    let ticks = 0, maxGap = 0, previous = performance.now()
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++ }, 1)
    const service = createHistoricalRescanService(f.db, { onBatch(state) {
      expect(f.db.isTransaction).toBe(false)
      expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n).toBe(10000)
      samples.push(process.memoryUsage().heapUsed); counts.push(state.scannedMessages)
    } })
    try {
      const run = service.start(group.id); await service.wait(run.id)
      const firstMs = performance.now() - started
      expect(service.status(group.id)).toMatchObject({ status: 'complete', scannedMessages: 10000, matchedHits: 1429, newHits: 1429 })
      expect(counts.length).toBeGreaterThan(50); expect(ticks).toBeGreaterThan(10)
      expect(await scan(f, group.id)).toMatchObject({ status: 'complete', matchedHits: 1429, newHits: 0, existingHits: 1429 })
      expect(f.db.prepare('SELECT (SELECT count(*) FROM keyword_hits)+(SELECT count(*) FROM keyword_rescan_coverage WHERE matched_terms_snapshot IS NOT NULL) AS n').get()!.n).toBe(1429)
      expect(Math.max(...samples) - memoryBefore.heapUsed).toBeLessThan(128 * 1024 * 1024)
      expect(f.db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
      console.info(JSON.stringify({ syntheticMessages: 10000, batches: counts.length, firstScanMs: Math.round(firstMs), twoScanMs: Math.round(performance.now() - started), timerTicks: ticks, maxEventLoopGapMs: Math.round(maxGap), peakHeapDeltaBytes: Math.max(...samples) - memoryBefore.heapUsed, rssDeltaBytes: process.memoryUsage().rss - memoryBefore.rss }))
    } finally { clearInterval(timer) }
  })
})
