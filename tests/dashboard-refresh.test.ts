import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSummaryCache, readImportRevision } from '../src/main/dashboard-cache'
import { openDatabase } from '../src/main/database'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { loadLatestDaily, refreshAfterExternalImport, refreshSubmittedSearch } from '../src/renderer/src/data-refresh'
import type { DashboardSummary, TopicRadarSummary } from '../src/shared/models'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function externalDatabasePair(): { appDb: DatabaseSync; connectorDb: DatabaseSync; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-dashboard-refresh-'))
  directories.push(directory)
  const path = join(directory, 'private-radar.db')
  const appDb = openDatabase(path)
  const connectorDb = openDatabase(path)
  databases.push(appDb, connectorDb)
  return { appDb, connectorDb, path }
}

function importMessage(db: DatabaseSync, batch: string, timestamp: string | undefined, content: string): void {
  ingestWorkBuddyMessages(db, {
    source_batch_id: batch,
    batch_metadata: { conversation_name: '刷新测试群' },
    messages: [{ content, timestamp, source_position: 0 }]
  })
}

describe('Daily 导入修订号缓存', () => {
  it('应用打开期间可发现 WorkBuddy 外部进程的新导入', async () => {
    const { appDb, connectorDb, path } = externalDatabasePair()
    importMessage(connectorDb, '外部导入-旧', '2004-02-02 10:00', '虚构练习工具 PaperTile 8.6 发布圆环绘图功能。')
    let dirtyCount = 0
    const cache = new DashboardSummaryCache(appDb, path, () => { dirtyCount += 1 })
    expect((await cache.get()).messageCount).toBe(1)

    const previousRevision = readImportRevision(appDb)
    importMessage(connectorDb, '外部导入-新', '2004-02-03 10:00', '合成纸偶工具 LumenTile 8.6 发布编号功能。')

    expect(readImportRevision(appDb)).not.toBe(previousRevision)
    expect((await cache.get()).date).toBe('2004-02-03')
    expect(dirtyCount).toBe(1)
  })

  it('跨日期导入后 Daily 自动从 2 月 2 日切换到 2 月 3 日', async () => {
    const { appDb, connectorDb, path } = externalDatabasePair()
    importMessage(connectorDb, '跨日-13', '2004-02-02 09:00', '合成纸环项目 MosaicAlpha 8.6 正式发布。')
    const cache = new DashboardSummaryCache(appDb, path)
    expect((await cache.get()).date).toBe('2004-02-02')

    importMessage(connectorDb, '跨日-14', '2004-02-03 09:00', '虚构方格项目 MosaicBeta 8.6 正式发布。')
    const refreshed = await cache.get()
    expect(refreshed.date).toBe('2004-02-03')
    expect(refreshed.messageCount).toBe(1)
  })

  it('同一天新增消息后更新 Daily 消息计数和候选来源', async () => {
    const { appDb, connectorDb, path } = externalDatabasePair()
    importMessage(connectorDb, '同日-1', '2004-02-03 09:00', '合成练习项目 PaperTile 8.6 发布：https://github.com/example/synthetic-tile-kit')
    const cache = new DashboardSummaryCache(appDb, path)
    const before = await cache.get()

    importMessage(connectorDb, '同日-2', '2004-02-03 11:00', '虚构纸偶项目 LumenTile 8.6 发布：https://synthetic.invalid/lumen-tile')
    const after = await cache.get()
    const sourceCount = appDb.prepare(`
      SELECT COUNT(DISTINCT message_id) AS count
      FROM daily_candidate_sources s
      JOIN daily_intelligence_candidates c ON c.id = s.candidate_id
      WHERE c.candidate_date = '2004-02-03'
    `).get() as { count: number }

    expect(before.messageCount).toBe(1)
    expect(after.messageCount).toBe(2)
    expect(sourceCount.count).toBe(2)
  })

  it('刷新无时间消息时不会把 imported_at 或批次日期写入 timestamp', async () => {
    const { appDb, connectorDb, path } = externalDatabasePair()
    ingestWorkBuddyMessages(connectorDb, {
      source_batch_id: '无时间刷新',
      batch_metadata: { conversation_name: '无时间群', approximate_date: '2004-02-03' },
      messages: [{ content: '合成圆环贴在空白棋盘的左格。', source_position: 0 }]
    })
    await new DashboardSummaryCache(appDb, path).get()
    const message = appDb.prepare(`SELECT timestamp, timestamp_source, imported_at FROM messages`).get() as {
      timestamp: string | null
      timestamp_source: string
      imported_at: string
    }
    expect(message.timestamp).toBeNull()
    expect(message.timestamp_source).toBe('unknown')
    expect(message.imported_at).not.toBe('')
  })
})

describe('Renderer 数据刷新动作', () => {
  it('点击今日情报会调用接口强制获取最新 summary', async () => {
    const summary = summaryFixture('2026-09-14')
    const getDashboardSummary = vi.fn().mockResolvedValue(summary)
    await expect(loadLatestDaily({ getDashboardSummary })).resolves.toBe(summary)
    await expect(loadLatestDaily({ getDashboardSummary })).resolves.toBe(summary)
    expect(getDashboardSummary).toHaveBeenCalledTimes(2)
  })

  it('外部导入发生且 Topic 正在显示时，同时刷新 Daily 并重新请求 Topic', async () => {
    const summary = summaryFixture('2026-09-14')
    const radar: TopicRadarSummary = { date: '2026-09-14', historyDays: 7, topics: [] }
    const api = {
      getDashboardSummary: vi.fn().mockResolvedValue(summary),
      getTopicRadarSummary: vi.fn().mockResolvedValue(radar)
    }
    await expect(refreshAfterExternalImport(api, true)).resolves.toEqual({ summary, radar })
    expect(api.getDashboardSummary).toHaveBeenCalledOnce()
    expect(api.getTopicRadarSummary).toHaveBeenCalledOnce()
  })

  it('外部导入发生但 Topic 未打开时将其保持为 stale，不复用旧结果', async () => {
    const summary = summaryFixture('2026-09-14')
    const api = {
      getDashboardSummary: vi.fn().mockResolvedValue(summary),
      getTopicRadarSummary: vi.fn()
    }
    await expect(refreshAfterExternalImport(api, false)).resolves.toEqual({ summary, radar: null })
    expect(api.getTopicRadarSummary).not.toHaveBeenCalled()
  })

  it('外部导入后重新执行当前已提交搜索，空查询不触发检索', async () => {
    const askChat = vi.fn().mockResolvedValue({ results: [{ content: '虚构纸鲸停在圆点的旁边。' }] })
    await expect(refreshSubmittedSearch({ askChat }, ' 虚构纸鲸停在圆点的旁边。 ')).resolves.toEqual({
      results: [{ content: '虚构纸鲸停在圆点的旁边。' }]
    })
    await expect(refreshSubmittedSearch({ askChat }, '   ')).resolves.toBeNull()
    expect(askChat).toHaveBeenCalledOnce()
    expect(askChat).toHaveBeenCalledWith('虚构纸鲸停在圆点的旁边。')
  })
})

function summaryFixture(date: string): DashboardSummary {
  return {
    demoMode: false,
    date,
    conversationCount: 1,
    messageCount: 1,
    candidateCount: 1,
    finalIntelligenceCount: 1,
    mode: 'rule',
    modeNotice: null,
    telemetry: null,
    totalMessageCount: 1,
    databasePath: '测试数据库',
    items: []
  }
}
