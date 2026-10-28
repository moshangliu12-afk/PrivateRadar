import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MissingImportantFeedback, RadarPage, SearchPage, SettingsPage, Stat } from '../src/renderer/src/App'
import { EmptySignal } from '../src/renderer/src/ui-components'
import type { ChatQueryResponse, ChatSearchResult, FirstUseStatus, TopicRadarItem, TopicRadarSummary } from '../src/shared/models'

function makeTopic(overrides: Partial<TopicRadarItem> = {}): TopicRadarItem {
  return {
    topicId: 'ui-test-topic',
    canonicalName: '组件测试话题',
    aliases: [],
    date: '2028-02-04',
    messageCount: 67,
    conversationCount: 11,
    senderCount: 9,
    firstSeenAt: '2028-02-02T09:00:00+08:00',
    lastSeenAt: '2028-02-04T10:00:00+08:00',
    historicalAvgMessageCount: 18.75,
    historicalAvgConversationCount: 3,
    historicalAvgSenderCount: 4,
    growthRate: 0.42,
    noveltyScore: 0.9,
    signalScore: 0.876,
    sourceMessageIds: ['ui-test-evidence'],
    reasonCodes: ['NEW_TOPIC', 'MULTI_CONVERSATION'],
    trend: [{ date: '2028-02-04', messageCount: 67, conversationCount: 11, senderCount: 9 }],
    ...overrides
  }
}

function makeRadar(overrides: Partial<TopicRadarSummary> = {}): TopicRadarSummary {
  return { date: '2028-02-04', historyDays: 13, historySufficient: true, topics: [], newTopics: [], warmingTopics: [], ...overrides }
}

function makeStatus(overrides: Partial<FirstUseStatus> = {}): FirstUseStatus {
  return {
    firstLaunch: false,
    demoMode: false,
    appVersion: '0.9.7-ui-test',
    workBuddyConnected: false,
    workBuddyConnectionMessage: '组件测试未连接',
    workBuddyInstalled: true,
    connectorPrepared: true,
    connectorRequiresRetrust: false,
    databaseHealthy: true,
    totalMessageCount: 867,
    importBatchCount: 36,
    databasePath: 'D:\\界面测试数据\\private-radar.db',
    dataDirectory: 'D:\\界面测试数据',
    logDirectory: 'D:\\界面测试数据\\logs',
    latestImport: null,
    dataStatus: {
      latestAttempt: {
        status: 'success', source: 'WorkBuddy', startedAt: '2028-02-04T09:00:00+08:00', completedAt: '2028-02-04T09:01:00+08:00',
        recognizedCount: 45, importedCount: 31, duplicateCount: 8, updatedCount: 4, errorCount: 2
      },
      lastSuccessfulImport: null,
      latestMessageDate: '2028-02-03'
    },
    ...overrides
  }
}

function makeSearchResult(overrides: Partial<ChatSearchResult> = {}): ChatSearchResult {
  return {
    messageId: 'ui-search-evidence', conversationId: 'ui-conversation', conversationName: '组件测试群',
    senderId: 'ui-sender', senderName: '组件测试发送者', senderNameSource: 'source_native',
    timestamp: '2028-02-03T09:00:00+08:00', timeVerification: 'verified',
    content: '搜索组件专用证据文字', links: ['https://example.invalid/ui-test'], relevanceScore: 0.714,
    matchReasons: ['关键词匹配'], ...overrides
  }
}

function makeResponse(overrides: Partial<ChatQueryResponse> = {}): ChatQueryResponse {
  return {
    queryType: 'find', answer: '组件测试回答', insufficientEvidence: false,
    understanding: {
      intent: 'find', sort: 'relevance', dateRange: { label: '组件测试时间范围', start: null, end: null },
      timeIntent: 'none', personIntent: 'none', isNaturalLanguage: true,
      conversationIds: [], conversationNames: [], senderIds: [], senderNames: [], entityKeys: [],
      coreTopics: [], eventTerms: [], expandedTerms: [], searchTerms: []
    },
    results: [makeSearchResult()], unverifiedTimeResults: [], sourceMessageIds: ['ui-search-evidence'],
    hitMessageCount: 17, conversationCount: 6, senderCount: 4,
    telemetry: { retrievalMode: '全文搜索', aiMode: '规则模式', evidenceSentCount: 1, embeddingCandidateCount: 0 },
    ...overrides
  }
}

function renderSearch(overrides: Partial<Parameters<typeof SearchPage>[0]> = {}): string {
  return renderToStaticMarkup(createElement(SearchPage, {
    status: makeStatus(), question: '组件测试问题', querying: false, response: null, openMessageId: '', context: null,
    onQuestionChange: vi.fn(), onSubmit: vi.fn(async () => undefined), onToggleContext: vi.fn(async () => undefined), ...overrides
  }))
}

function renderSettings(status: FirstUseStatus, importing = false): string {
  return renderToStaticMarkup(createElement(SettingsPage, {
    status, importing, onImportFile: vi.fn(async () => undefined), onConfigure: vi.fn(async () => undefined), onCheck: vi.fn(async () => status)
  }))
}

describe('界面刷新：话题雷达真实数据表现', () => {
  it('三张统计卡读取传入的历史窗口与两类话题数量', () => {
    const first = makeTopic()
    const second = makeTopic({ topicId: 'ui-second-topic', canonicalName: '第二个组件测试话题' })
    const html = renderToStaticMarkup(createElement(RadarPage, {
      radar: makeRadar({ historyDays: 13, newTopics: [first, second], warmingTopics: [first] }),
      openTopicId: '', evidence: null, onToggleEvidence: vi.fn(async () => undefined)
    }))
    expect(html).toContain('topic-stat-value">13<small>天</small>')
    expect(html).toContain('topic-stat-value">2<small>个</small>')
    expect(html).toContain('topic-stat-value">1<small>个</small>')
    expect(html).toContain('第二个组件测试话题')
  })

  it('空态沿用实际历史窗口，不伪造热度曲线或话题', () => {
    const html = renderToStaticMarkup(createElement(RadarPage, {
      radar: makeRadar(), openTopicId: '', evidence: null, onToggleEvidence: vi.fn(async () => undefined)
    }))
    expect(html).toContain('今天没有新出现的话题')
    expect(html).toContain('暂未发现明显升温的话题')
    expect(html).toContain('趋势基线来自最近 13 天的数据。')
    expect(html).toContain('暂无信号')
    expect(html).toContain('趋势平稳')
    expect(html).not.toContain('topic-trend')
    expect(html).not.toContain('topic-card')
  })

  it('历史不足时保留限制提示，不将不足状态称为趋势平稳', () => {
    const html = renderToStaticMarkup(createElement(RadarPage, {
      radar: makeRadar({ historyDays: 0, historySufficient: false }), openTopicId: '', evidence: null, onToggleEvidence: vi.fn(async () => undefined)
    }))
    expect(html).toContain('历史数据不足，趋势仅供参考')
    expect(html).toContain('尚无可用于趋势比较的历史数据。')
    expect(html).toContain('基线积累中')
    expect(html).not.toContain('趋势平稳')
  })

  it('非空话题保留真实评分、六项统计、趋势与原因', () => {
    const html = renderToStaticMarkup(createElement(RadarPage, {
      radar: makeRadar({ newTopics: [makeTopic()] }), openTopicId: '', evidence: null, onToggleEvidence: vi.fn(async () => undefined)
    }))
    expect(html).toContain('0.88 Signal')
    expect(html).toContain('今日消息<strong>67</strong>')
    expect(html).toContain('今日群数<strong>11</strong>')
    expect(html).toContain('今日人数<strong>9</strong>')
    expect(html).toContain('历史日均<strong>18.8</strong>')
    expect(html).toContain('增长<strong>+42%</strong>')
    expect(html).toContain('首次出现')
    expect(html).toContain('title="2028-02-04：67 条"')
    expect(html).toContain('新话题')
    expect(html).toContain('多个群出现')
    expect(html).toContain('查看依据')
    expect(html).toContain('aria-expanded="false"')
  })

  it('发送者缺失继续显示未知，证据展开仍使用传入原始消息', () => {
    const onToggleEvidence = vi.fn(async () => undefined)
    const html = renderToStaticMarkup(createElement(RadarPage, {
      radar: makeRadar({ newTopics: [makeTopic({ senderCount: 0 })] }), openTopicId: 'ui-test-topic',
      evidence: { topicId: 'ui-test-topic', messages: [{ messageId: 'ui-test-evidence', conversationId: 'ui-test-group', conversationName: '证据组件测试群', senderId: '', senderName: '', timestamp: '', content: '话题组件专用原始证据', isSource: true }] },
      onToggleEvidence
    }))
    expect(html).toContain('今日人数<strong>发送者未知</strong>')
    expect(html).toContain('话题组件专用原始证据')
    expect(html).toContain('证据组件测试群')
    expect(html).toContain('发送人未提供')
    expect(html).toContain('时间未提供')
    expect(html).toContain('收起依据')
    expect(html).toContain('aria-expanded="true"')
    expect(onToggleEvidence).not.toHaveBeenCalled()
  })

  it('证据未返回时保留加载状态', () => {
    const html = renderToStaticMarkup(createElement(RadarPage, {
      radar: makeRadar({ newTopics: [makeTopic()] }), openTopicId: 'ui-test-topic', evidence: null, onToggleEvidence: vi.fn(async () => undefined)
    }))
    expect(html).toContain('正在读取原始消息……')
  })
})

describe('界面刷新：私有检索真实表现', () => {
  it('等待态保留输入、提交、真实索引数量与证据原则', () => {
    const html = renderSearch()
    expect(html).toContain('aria-label="询问聊天记录"')
    expect(html).toContain('value="组件测试问题"')
    expect(html).toContain('检索聊天')
    expect(html).toContain('等待你的问题')
    expect(html).toContain('答案要有来处')
    expect(html).toContain('<strong>867</strong>')
    expect(html).toContain('<strong>36</strong>')
    expect(html).toContain('上个月谁推荐过 AI 工具？')
    expect(html).toContain('最近大家怎么评价 Claude Code？')
  })

  it('索引未读取时显示加载而不是伪造数量', () => {
    const html = renderSearch({ status: null })
    expect(html).toContain('正在读取本地索引状态…')
    expect(html).not.toContain('<strong>867</strong>')
    expect(html).not.toContain('<strong>36</strong>')
  })

  it('检索中保留真实忙碌状态，空问题禁止提交', () => {
    const busy = renderSearch({ querying: true })
    expect(busy).toContain('正在检索…')
    expect(busy).toContain('正在检索聊天记录')
    expect(busy).toMatch(/<button type="submit" disabled=""/)
    expect(renderSearch({ question: '   ' })).toMatch(/<button type="submit" disabled=""/)
  })

  it('结果继续展示回答、统计、证据、来源链接和反馈入口', () => {
    const html = renderSearch({ response: makeResponse() })
    expect(html).toContain('组件测试回答')
    expect(html).toContain('组件测试时间范围')
    expect(html).toContain('命中消息<strong>17</strong>')
    expect(html).toContain('搜索组件专用证据文字')
    expect(html).toContain('组件测试发送者')
    expect(html).toContain('https://example.invalid/ui-test')
    expect(html).toContain('0.714')
    expect(html).toContain('关键词匹配')
    expect(html).toContain('查看上下文')
    expect(html).toContain('找对了')
    expect(html).toContain('没找对')
    expect(html).not.toContain('等待你的问题')
  })

  it('缺原始时间的证据仍独立显示可靠性提示和元数据缺失状态', () => {
    const html = renderSearch({ response: makeResponse({ results: [], unverifiedTimeResults: [makeSearchResult({ timestamp: '', timeVerification: 'unknown', senderName: '', conversationName: '' })] }) })
    expect(html).toContain('以下相关聊天未提供原始时间，无法确认是否发生在组件测试时间范围。')
    expect(html).toContain('原始时间未提供')
    expect(html).toContain('发送人未提供')
    expect(html).toContain('未知会话')
    expect(html).toContain('搜索组件专用证据文字')
  })

  it('证据不足时保留提示回答，不展示虚构证据结果', () => {
    const html = renderSearch({ response: makeResponse({ insufficientEvidence: true, answer: '组件测试证据不足', results: [] }) })
    expect(html).toContain('组件测试证据不足')
    expect(html).toContain('grounded-answer insufficient')
    expect(html).not.toContain('搜索组件专用证据文字')
    expect(html).not.toContain('class="search-results"')
  })
})

describe('界面刷新：每日概览与纯展示组件', () => {
  it('统计卡按真实传值渲染，不带原型固定数字', () => {
    const html = renderToStaticMarkup(createElement(Stat, { label: '当日消息', value: 934, suffix: '条', icon: 'chat', note: '当日统计说明' }))
    expect(html).toContain('934<small>条</small>')
    expect(html).toContain('当日统计说明')
    expect(html).toContain('aria-hidden="true"')
  })

  it('空态只说明传入的真实状态，不新增操作或伪造结果', () => {
    const html = renderToStaticMarkup(createElement(EmptySignal, { title: '当天没有聊天记录', description: '请切换到已有记录的日期。' }))
    expect(html).toContain('当天没有聊天记录')
    expect(html).toContain('请切换到已有记录的日期。')
    expect(html).not.toContain('<button')
    expect(html).not.toMatch(/原型|截图|演示|对照/)
  })
})

describe('界面刷新：遗漏反馈初始状态', () => {
  it('首次展示时两项选择均未选中，渲染不保存反馈或调用 IPC', () => {
    const saveMissingImportantFeedback = vi.fn(async () => undefined)
    vi.stubGlobal('window', { privateRadar: { saveMissingImportantFeedback } })
    try {
      const html = renderToStaticMarkup(createElement(MissingImportantFeedback, { dateKey: '2028-02-04' }))
      const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0])
      expect(html).toContain('今天有重要内容被漏掉了吗？')
      expect(buttons).toHaveLength(2)
      expect(buttons[0]).toContain('没有')
      expect(buttons[1]).toContain('有')
      for (const button of buttons) expect(button).toContain('aria-pressed="false"')
      expect(html).not.toContain('aria-label="遗漏重要内容说明"')
      expect(html).not.toContain('感谢反馈')
      expect(saveMissingImportantFeedback).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('界面刷新：检索提交按钮可用性', () => {
  it.each([
    { label: '空字符串', question: '', querying: false, disabled: true },
    { label: '纯空白输入', question: ' \t\n ', querying: false, disabled: true },
    { label: '有效输入', question: '新的组件测试问题', querying: false, disabled: false },
    { label: '有效输入但正在检索', question: '新的组件测试问题', querying: true, disabled: true }
  ])('$label 对应正确的提交禁用状态，渲染不发起检索', ({ question, querying, disabled }) => {
    const onSubmit = vi.fn(async () => undefined)
    const html = renderSearch({ question, querying, onSubmit })
    const submitTag = html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]
    expect(submitTag).toBeDefined()
    expect(/\sdisabled(?:=|\s|>)/.test(submitTag!)).toBe(disabled)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('界面刷新：设置真实状态与操作', () => {
  it('版本、真实路径、数量和日期全部来自传入状态', () => {
    const html = renderSettings(makeStatus())
    expect(html).toContain('0.9.7-ui-test')
    expect(html).toContain('D:\\界面测试数据')
    expect(html).toContain('867 条消息')
    expect(html).toContain('36 个聊天批次')
    expect(html).toContain('2028-02-03')
    expect(html).toContain('新增 <strong>31</strong>')
    expect(html).toContain('重复 <strong>8</strong>')
    expect(html).toContain('更新 <strong>4</strong>')
    expect(html).toContain('错误 <strong>2</strong>')
  })

  it('最近导入成功不能冒充 WorkBuddy 当前连接成功', () => {
    const html = renderSettings(makeStatus({ workBuddyConnected: false }))
    expect(html).toContain('最近一次导入')
    expect(html).toContain('import-status success')
    expect(html).toContain('未连接')
    expect(html).not.toContain('WorkBuddy 已连接')
  })

  it('六项现有管理入口和导入忙碌禁用状态保留', () => {
    const html = renderSettings(makeStatus())
    for (const action of ['检查 WorkBuddy 连接', '配置 WorkBuddy', '打开数据目录', '打开日志目录', '从文件导入', '导出测试反馈']) {
      expect(html).toContain(action)
    }
    const busy = renderSettings(makeStatus(), true)
    expect(busy).toContain('正在导入…')
    expect(busy).toMatch(/<button[^>]*disabled=""/)
  })

  it('无导入和数据库异常仍分别显示真实状态', () => {
    const html = renderSettings(makeStatus({ databaseHealthy: false, dataStatus: { latestAttempt: null, lastSuccessfulImport: null, latestMessageDate: null } }))
    expect(html).toContain('尚未导入聊天数据')
    expect(html).toContain('需要检查')
    expect(html).toContain('867 条消息')
  })

  it('最近失败仍保留最近成功记录，不能改称最近成功', () => {
    const status = makeStatus()
    const successful = status.dataStatus.latestAttempt!
    const html = renderSettings({ ...status, dataStatus: { ...status.dataStatus, latestAttempt: { ...successful, status: 'failed', source: '失败测试来源' }, lastSuccessfulImport: { ...successful, source: '保留成功来源' } } })
    expect(html).toContain('import-status failed')
    expect(html).toContain('失败测试来源')
    expect(html).toContain('最近成功导入')
    expect(html).toContain('保留成功来源')
  })

  it.each([false, true])('连接状态切换到 %s 时，同步展示传入的新版本、目录、数量与可靠日期', (connected) => {
    const before = makeStatus({ workBuddyConnected: !connected })
    const nextDirectory = join(tmpdir(), 'privateradar-ui-state-test', connected ? 'connected' : 'disconnected')
    const next = makeStatus({
      ...before,
      workBuddyConnected: connected,
      appVersion: `${before.appVersion}-changed`,
      dataDirectory: nextDirectory,
      databasePath: join(nextDirectory, 'private-radar.db'),
      logDirectory: join(nextDirectory, 'logs'),
      totalMessageCount: before.totalMessageCount + 45,
      importBatchCount: before.importBatchCount + 7,
      dataStatus: { ...before.dataStatus, latestMessageDate: connected ? '2029-05-11' : '2030-07-12' }
    })
    const beforeHtml = renderSettings(before)
    const nextHtml = renderSettings(next)
    expect(beforeHtml).toContain(`WorkBuddy ${before.workBuddyConnected ? '已连接' : '未连接'}`)
    expect(nextHtml).toContain(`WorkBuddy ${connected ? '已连接' : '未连接'}`)
    expect(nextHtml).not.toContain(`WorkBuddy ${connected ? '未连接' : '已连接'}`)
    expect(nextHtml).toContain(next.appVersion)
    expect(nextHtml).toContain(next.dataDirectory)
    expect(nextHtml).toContain(`${next.totalMessageCount.toLocaleString()} 条消息`)
    expect(nextHtml).toContain(`${next.importBatchCount.toLocaleString()} 个聊天批次`)
    expect(nextHtml).toContain(next.dataStatus.latestMessageDate!)
    expect(nextHtml).not.toContain(before.dataDirectory)
    expect(nextHtml).not.toContain(`${before.totalMessageCount.toLocaleString()} 条消息`)
    expect(nextHtml).not.toContain(`${before.importBatchCount.toLocaleString()} 个聊天批次`)
    expect(nextHtml).not.toContain(before.dataStatus.latestMessageDate!)
  })
})
