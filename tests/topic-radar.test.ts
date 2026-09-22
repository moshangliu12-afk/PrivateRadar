import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { seedDemoData } from '../src/main/demo'
import { buildTopicRadar, TOPIC_ALGORITHM_VERSION } from '../src/main/intelligence/topics/pipeline'
import { calculateSignalScore, smoothedGrowthRate } from '../src/main/intelligence/topics/signal-score'
import { getTopicEvidence, loadSavedTopicRadar, runTopicRadar } from '../src/main/intelligence/topics/repository'
import type { SignalScoreInput } from '../src/main/intelligence/topics/types'
import type { DailyMessage } from '../src/main/intelligence/daily/types'
import { initializeDatabase } from '../src/main/schema'

const databases: DatabaseSync[] = []

afterEach(() => {
  while (databases.length) databases.pop()!.close()
})

function signal(overrides: Partial<SignalScoreInput> = {}): SignalScoreInput {
  return {
    todayMessageCount: 10,
    todayConversationCount: 2,
    todaySenderCount: 4,
    historicalAvgMessageCount: 5,
    historicalAvgConversationCount: 1,
    historicalAvgSenderCount: 3,
    appearedInHistory: true,
    d1ImportanceScore: 0,
    dailyMessageCounts: [2, 3, 4, 5, 6, 7, 8, 10],
    ...overrides
  }
}

function message(
  id: string,
  date: string,
  content: string,
  conversationId = 'g1',
  senderId = 'u1'
): DailyMessage {
  return {
    id,
    conversationId,
    conversationName: `群-${conversationId}`,
    senderId,
    senderName: `用户-${senderId}`,
    timestamp: `${date}T10:${String(Number(id.replace(/\D/g, '') || 0) % 60).padStart(2, '0')}:00+08:00`,
    content,
    messageType: content.includes('http') ? 'link' : 'text',
    links: content.match(/https?:\/\/\S+/g) ?? [],
    replyTo: null
  }
}

describe('E1 话题雷达', () => {
  it('低基数快速上涨获得高分', () => {
    const lowBase = calculateSignalScore(signal({
      todayMessageCount: 35, todayConversationCount: 5, todaySenderCount: 12,
      historicalAvgMessageCount: 2, historicalAvgConversationCount: 1
    }))
    const highBase = calculateSignalScore(signal({
      todayMessageCount: 230, todayConversationCount: 5, todaySenderCount: 12,
      historicalAvgMessageCount: 200, historicalAvgConversationCount: 5
    }))
    expect(lowBase.signalScore).toBeGreaterThan(highBase.signalScore)
    expect(lowBase.reasonCodes).toContain('RAPID_MESSAGE_GROWTH')
  })

  it('长期高基数小幅上涨不会依靠绝对消息数霸榜', () => {
    const steady = calculateSignalScore(signal({ todayMessageCount: 320, historicalAvgMessageCount: 300 }))
    const rising = calculateSignalScore(signal({ todayMessageCount: 30, historicalAvgMessageCount: 2, todayConversationCount: 4 }))
    expect(rising.signalScore).toBeGreaterThan(steady.signalScore)
  })

  it('跨群传播比单群刷屏获得更高权重', () => {
    const spam = calculateSignalScore(signal({ todayMessageCount: 100, todayConversationCount: 1, todaySenderCount: 1, historicalAvgMessageCount: 2 }))
    const spread = calculateSignalScore(signal({ todayMessageCount: 35, todayConversationCount: 5, todaySenderCount: 8, historicalAvgMessageCount: 2 }))
    expect(spread.signalScore).toBeGreaterThan(spam.signalScore)
    expect(spread.reasonCodes).toContain('CROSS_GROUP_SPREAD')
    expect(spam.reasonCodes).not.toContain('CROSS_GROUP_SPREAD')
  })

  it('独立发送人增加信号', () => {
    const one = calculateSignalScore(signal({ todaySenderCount: 1 }))
    const many = calculateSignalScore(signal({ todaySenderCount: 8 }))
    expect(many.signalScore).toBeGreaterThan(one.signalScore)
    expect(many.reasonCodes).toContain('MULTI_SENDER')
  })

  it('NEW_TOPIC 对历史未出现的话题生效', () => {
    const result = calculateSignalScore(signal({ appearedInHistory: false, historicalAvgMessageCount: 0 }))
    expect(result.noveltyScore).toBe(1)
    expect(result.reasonCodes).toContain('NEW_TOPIC')
  })

  it('单条首次出现话题只进入新出现，不进入正在升温', () => {
    const result = buildTopicRadar({
      messages: [message('1', '2026-09-12', 'NovaFlow 1.0 正式发布。')],
      date: '2026-09-12',
      availableHistoryDates: []
    })
    expect(result.newTopics).toHaveLength(1)
    expect(result.newTopics[0].signalScore).toBeGreaterThanOrEqual(8)
    expect(result.warmingTopics).toHaveLength(0)
  })

  it('多条首次出现话题即使高 Signal 也不进入正在升温', () => {
    const today = Array.from({ length: 6 }, (_, index) =>
      message(`n${index}`, '2026-09-12', `NovaFlow 2.0 正式发布，新增能力 ${index}。`, `g${index % 3}`, `u${index}`)
    )
    const result = buildTopicRadar({ messages: today, date: '2026-09-12', availableHistoryDates: ['2026-09-10', '2026-09-11'] })
    expect(result.historySufficient).toBe(true)
    expect(result.newTopics).toHaveLength(1)
    expect(result.newTopics[0].signalScore).toBeGreaterThanOrEqual(8)
    expect(result.warmingTopics).toHaveLength(0)
  })

  it('历史出现过且今日增长时进入正在升温', () => {
    const messages = [
      message('h1', '2026-09-10', 'NovaFlow 正式发布。'),
      message('h2', '2026-09-11', 'NovaFlow 新版发布。'),
      ...Array.from({ length: 4 }, (_, index) => message(`t${index}`, '2026-09-12', `NovaFlow 今日新增能力 ${index}。`, `g${index % 2}`, `u${index}`))
    ]
    const result = buildTopicRadar({ messages, date: '2026-09-12', availableHistoryDates: ['2026-09-10', '2026-09-11'] })
    expect(result.newTopics).toHaveLength(0)
    expect(result.warmingTopics).toHaveLength(1)
    expect(result.warmingTopics[0].growthRate).toBeGreaterThan(0)
  })

  it('历史出现过但今日持平或下降时不进入正在升温', () => {
    const steady = buildTopicRadar({
      messages: [
        message('s1', '2026-09-10', 'NovaFlow 正式发布。'),
        message('s2', '2026-09-11', 'NovaFlow 新版发布。'),
        message('s3', '2026-09-12', 'NovaFlow 今日动态。')
      ],
      date: '2026-09-12',
      availableHistoryDates: ['2026-09-10', '2026-09-11']
    })
    const decliningMessages = [
      ...Array.from({ length: 3 }, (_, index) => message(`a${index}`, '2026-09-10', `NovaFlow 历史发布 ${index}。`)),
      ...Array.from({ length: 3 }, (_, index) => message(`b${index}`, '2026-09-11', `NovaFlow 历史更新 ${index}。`)),
      message('c1', '2026-09-12', 'NovaFlow 今日动态。')
    ]
    const declining = buildTopicRadar({ messages: decliningMessages, date: '2026-09-12', availableHistoryDates: ['2026-09-10', '2026-09-11'] })
    expect(steady.warmingTopics).toHaveLength(0)
    expect(declining.warmingTopics).toHaveLength(0)
  })

  it.each([
    [[], false],
    [['2026-09-11'], false],
    [['2026-09-10', '2026-09-11'], true]
  ])('有效历史日期 %j 时 historySufficient=%s', (availableHistoryDates, expected) => {
    const result = buildTopicRadar({
      messages: [message('1', '2026-09-12', 'NovaFlow 1.0 正式发布。')],
      date: '2026-09-12',
      availableHistoryDates
    })
    expect(result.historySufficient).toBe(expected)
  })

  it('真实 2026-09-20 回归为两个新话题且没有升温话题', () => {
    const messages = [
      message('h1', '2026-09-14', '历史日期中的另一个产品 NovaFlow 正式发布。'),
      message('1', '2026-09-20', '我已经把我这个工具传到GitHub上面去了'),
      message('2', '2026-09-20', '@所有人 我这边已经把AI工作站的图片模型都换成了GPT-image-2.5，文字模型换成了 Claude-Sonnet-5，成本不变。', 'g2', 'u2')
    ]
    const before = JSON.stringify(messages)
    const result = buildTopicRadar({ messages, date: '2026-09-20', availableHistoryDates: ['2026-09-14'] })
    expect(result.historyDays).toBe(1)
    expect(result.historySufficient).toBe(false)
    expect(result.newTopics).toHaveLength(2)
    expect(result.newTopics.map((topic) => topic.canonicalName)).toEqual(expect.arrayContaining([
      '我已经把我这个工具传到GitHub上面去了',
      'GPT-image-2.5'
    ]))
    expect(result.warmingTopics).toHaveLength(0)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('历史不足 7 天时使用已有历史日期', () => {
    const messages = [
      message('1', '2026-09-10', 'NovaFlow 1.0 发布工作流功能。'),
      message('2', '2026-09-11', 'NovaFlow 新版工作流开始测试。'),
      message('3', '2026-09-12', 'NovaFlow 工作流今天开始扩散。', 'g2', 'u2')
    ]
    const result = buildTopicRadar({ messages, date: '2026-09-12', availableHistoryDates: ['2026-09-10', '2026-09-11'] })
    expect(result.historyDays).toBe(2)
    expect(result.topics[0].historicalAvgMessageCount).toBe(1)
  })

  it('历史基线严格排除当天消息', () => {
    const messages = [
      ...Array.from({ length: 2 }, (_, index) => message(`h${index}`, '2026-09-11', `NovaFlow 历史讨论 ${index}。`)),
      ...Array.from({ length: 20 }, (_, index) => message(`t${index}`, '2026-09-12', `NovaFlow 今日讨论 ${index}。`, `g${index % 4}`, `u${index % 6}`))
    ]
    const topic = buildTopicRadar({ messages, date: '2026-09-12', availableHistoryDates: ['2026-09-11'] }).topics[0]
    expect(topic.historicalAvgMessageCount).toBe(2)
    expect(topic.messageCount).toBe(20)
  })

  it('极端增长率经过平滑且有上限', () => {
    expect(smoothedGrowthRate(10, 0.1)).toBeLessThanOrEqual(8)
    expect(smoothedGrowthRate(10_000, 0)).toBe(8)
  })

  it('Topic 完整保留当天来源消息', () => {
    const today = Array.from({ length: 5 }, (_, index) => message(`t${index}`, '2026-09-12', `NovaFlow 今日扩散消息 ${index}。`, `g${index % 3}`, `u${index}`))
    const topic = buildTopicRadar({ messages: today, date: '2026-09-12', availableHistoryDates: [] }).topics[0]
    expect(topic.sourceMessageIds).toEqual(today.map((item) => item.id))
    expect(topic.messageCount).toBe(topic.sourceMessageIds.length)
  })

  it('相同数据重复执行排序稳定', () => {
    const messages = [
      message('1', '2026-09-12', 'NovaFlow 2.0 正式发布。', 'g1', 'u1'),
      message('2', '2026-09-12', 'NovaFlow 新版已经发布。', 'g2', 'u2'),
      message('3', '2026-09-12', 'MeshNote 1.0 正式发布。', 'g1', 'u1'),
      message('4', '2026-09-12', 'MeshNote 新版已经发布。', 'g2', 'u2')
    ]
    const first = buildTopicRadar({ messages, date: '2026-09-12', availableHistoryDates: [] }).topics.map((item) => item.topicId)
    const second = buildTopicRadar({ messages: [...messages].reverse(), date: '2026-09-12', availableHistoryDates: [] }).topics.map((item) => item.topicId)
    expect(first).toEqual(second)
  })

  it('同一产品的发布与崩溃子事件不会错误合并', () => {
    const messages = [
      message('1', '2026-09-12', 'Claude Code 新版本正式发布。', 'g1', 'u1'),
      message('2', '2026-09-12', 'Claude 编程工具新版发布了。', 'g2', 'u2'),
      message('3', '2026-09-12', 'Claude Code Windows 启动崩溃问题。', 'g1', 'u3'),
      message('4', '2026-09-12', 'Anthropic coding agent 在 Windows 报错。', 'g2', 'u4')
    ]
    const topics = buildTopicRadar({ messages, date: '2026-09-12', availableHistoryDates: [] }).topics
    expect(topics).toHaveLength(2)
    expect(topics.map((item) => item.canonicalName)).toEqual(expect.arrayContaining(['Claude Code', 'Claude Code问题']))
  })

  it('Signal Score 是独立纯函数并返回可解释组成', () => {
    const source = signal({ todayConversationCount: 4, todaySenderCount: 6, d1ImportanceScore: 10 })
    const first = calculateSignalScore(source)
    const second = calculateSignalScore({ ...source })
    expect(first).toEqual(second)
    expect(first.reasonCodes).toEqual(expect.arrayContaining(['MULTI_CONVERSATION', 'MULTI_SENDER', 'CROSS_GROUP_SPREAD', 'HIGH_D1_IMPORTANCE']))
  })

  it('持久化 Topic 可以读取全部原始依据', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    initializeDatabase(db)
    seedDemoData(db)
    const date = (db.prepare(`SELECT MAX(date(timestamp, 'localtime')) AS date FROM messages`).get() as { date: string }).date
    const result = runTopicRadar(db, date)
    const topic = result.topics[0]
    const evidence = getTopicEvidence(db, topic.topicId, date)
    const saved = loadSavedTopicRadar(db, date)
    const versions = db.prepare('SELECT DISTINCT algorithm_version AS version FROM topic_daily_metrics WHERE metric_date = ?').all(date) as Array<{ version: string }>
    expect(evidence?.messages.map((item) => item.messageId)).toEqual(topic.sourceMessageIds)
    expect(evidence?.messages.every((item) => item.isSource)).toBe(true)
    expect(saved).not.toBeNull()
    expect(versions).toEqual([{ version: TOPIC_ALGORITHM_VERSION }])
  })
})
