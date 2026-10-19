// 手工消息为从零构造的合成场景，日期为人工测试锚点；不代表真实聊天或事件。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSummaryCache, readImportRevision } from '../src/main/dashboard-cache'
import { getDashboardSummary, openDatabase, validateDashboardDateKey } from '../src/main/database'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { loadDaily, refreshAfterExternalImport, refreshSubmittedSearch } from '../src/renderer/src/data-refresh'
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
    batch_metadata: { conversation_name: '合成刷新演练群' },
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
    importMessage(connectorDb, '跨日-02', '2004-02-02 09:00', '合成纸环项目 MosaicAlpha 8.6 正式发布。')
    const cache = new DashboardSummaryCache(appDb, path)
    expect((await cache.get()).date).toBe('2004-02-02')

    importMessage(connectorDb, '跨日-03', '2004-02-03 09:00', '虚构方格项目 MosaicBeta 8.6 正式发布。')
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
      batch_metadata: { conversation_name: '合成无时间演练群', approximate_date: '2004-02-03' },
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

describe('Daily 历史日期摘要', () => {
  it('无日期仍加载最新消息日期，指定日期绕过最新单值缓存并保留原始消息', async () => {
    const { appDb, connectorDb, path } = externalDatabasePair()
    importMessage(connectorDb, '历史-入场', '2004-02-08 09:00', '虚构纸偶剧场入场认证提醒：每月17日前需完成认证，未认证将暂停领取测试权益，之后可补发。')
    importMessage(connectorDb, '历史-安全', '2004-02-08 10:00', '虚构纸轮剧场公共安全公告：请大家维护演练通道安全，避免拼装转盘滑落。这是一段专为截断回归构造的纸偶舞台说明，舞台由棋盘、折页、圆筒和没有动力的纸轮组成。所有道具都属于虚构沙盘，不对应现实场地或真实活动。合成排练按方格编号摆放纸制组件，左侧一列用于展示圆形拼片，右侧一列用于展示三角形拼片；中间留空，只作为纸偶移动的虚构通道。纸质转盘旁的提示卡用于说明不同颜色的折线，不记录参与者身份。每段说明均是独立构造的测试文字，保留足够长度，以核验代表文本在截断后仍带有前段明确的公共安全维护要求。演练结束请及时处理散落纸片，保持通道畅通。')
    importMessage(connectorDb, '历史-模型', '2004-02-09 09:00', '合成沙盘已把配色模型换成 PaperLoom 8.6，输出纹样由六角网格展示。')
    importMessage(connectorDb, '历史-能力', '2004-02-09 10:00', '虚构水滴系统现已支持纸偶棋谱的逐页旋转。')
    importMessage(connectorDb, '历史-风险', '2004-02-09 11:00', '纸偶沙盘依赖转盘刻度，刻度失效后不能使用，改用手动描格会增加成本。')
    importMessage(connectorDb, '历史-损失', '2004-02-09 12:00', '虚构纸鲸的折叠投影做不出来，练习额度已消耗。')
    const messagesBefore = (appDb.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count

    const cache = new DashboardSummaryCache(appDb, path)
    expect((await cache.get()).date).toBe('2004-02-09')

    const latest = await getDashboardSummary(appDb, path)
    const syntheticDay8 = await getDashboardSummary(appDb, path, false, false, '2004-02-08')
    const syntheticDay9 = await getDashboardSummary(appDb, path, false, false, '2004-02-09')
    const empty = await getDashboardSummary(appDb, path, false, false, '2004-02-07')

    expect(latest.date).toBe('2004-02-09')
    expect(syntheticDay8).toMatchObject({ date: '2004-02-08', finalIntelligenceCount: 2 })
    expect(syntheticDay9).toMatchObject({ date: '2004-02-09', finalIntelligenceCount: 4 })
    expect(empty).toMatchObject({ date: '2004-02-07', messageCount: 0, items: [] })
    expect((appDb.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count).toBe(messagesBefore)
  })

  it('仅接受真实的 YYYY-MM-DD 日期键', () => {
    expect(validateDashboardDateKey(undefined)).toBeUndefined()
    expect(validateDashboardDateKey('2004-02-09')).toBe('2004-02-09')
    expect(() => validateDashboardDateKey('2004-2-9')).toThrow('YYYY-MM-DD')
    expect(() => validateDashboardDateKey('2004-02-30')).toThrow('日期无效')
    expect(() => validateDashboardDateKey('2004-02-09 OR 1=1')).toThrow('YYYY-MM-DD')
  })
})

describe('Renderer 数据刷新动作', () => {
  it('点击今日情报会调用接口强制获取最新 summary', async () => {
    const summary = summaryFixture('2004-02-03')
    const getDashboardSummary = vi.fn().mockResolvedValue(summary)
    await expect(loadDaily({ getDashboardSummary })).resolves.toBe(summary)
    await expect(loadDaily({ getDashboardSummary }, '2004-02-08')).resolves.toBe(summary)
    expect(getDashboardSummary).toHaveBeenCalledTimes(2)
    expect(getDashboardSummary).toHaveBeenLastCalledWith('2004-02-08')
  })

  it('外部导入发生且 Topic 正在显示时，同时刷新 Daily 并重新请求 Topic', async () => {
    const summary = summaryFixture('2004-02-03')
    const radar: TopicRadarSummary = {
      date: '2004-02-03', historyDays: 7, historySufficient: true,
      topics: [], newTopics: [], warmingTopics: []
    }
    const api = {
      getDashboardSummary: vi.fn().mockResolvedValue(summary),
      getTopicRadarSummary: vi.fn().mockResolvedValue(radar)
    }
    await expect(refreshAfterExternalImport(api, true)).resolves.toEqual({ summary, radar })
    expect(api.getDashboardSummary).toHaveBeenCalledOnce()
    expect(api.getTopicRadarSummary).toHaveBeenCalledOnce()
  })

  it('外部导入发生但 Topic 未打开时将其保持为 stale，不复用旧结果', async () => {
    const summary = summaryFixture('2004-02-03')
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
