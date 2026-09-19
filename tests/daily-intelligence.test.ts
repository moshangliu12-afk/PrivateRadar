import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createDemoMessages, seedDemoData } from '../src/main/demo'
import { DEFAULT_DAILY_CONFIG } from '../src/main/intelligence/daily/config'
import { extractFeatures, isNoiseMessage } from '../src/main/intelligence/daily/clean'
import { importanceScore, messageInformationScore } from '../src/main/intelligence/daily/importance-score'
import { buildDailyCandidates } from '../src/main/intelligence/daily/pipeline'
import { getCandidateEvidence, runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import type { DailyMessage } from '../src/main/intelligence/daily/types'

function message(id: string, content: string, options: Partial<DailyMessage> = {}): DailyMessage {
  return {
    id,
    conversationId: options.conversationId ?? 'group-1',
    conversationName: options.conversationName ?? '合成纸偶排练群',
    senderId: options.senderId ?? 'user-1',
    senderName: options.senderName ?? '合成成员甲',
    timestamp: options.timestamp ?? `2004-02-03T10:${String(Number(id.replace(/\D/g, '') || 0) % 60).padStart(2, '0')}:00.000Z`,
    content,
    messageType: options.messageType ?? (content.includes('http') ? 'link' : 'text'),
    links: options.links ?? (content.match(/https?:\/\/\S+/g) ?? []),
    replyTo: options.replyTo ?? null
  }
}

describe('今日情报候选引擎', () => {
  it('噪音消息被过滤或显著降低权重', () => {
    const noise = [message('1', '收到'), message('2', '早上好，纸偶排练先从空白页开始。')]
    expect(noise.every((item) => isNoiseMessage(item, DEFAULT_DAILY_CONFIG))).toBe(true)
    expect(buildDailyCandidates(noise, '2004-02-03').candidates).toHaveLength(0)
  })

  it('纯媒体或附件占位符不作为 D1 候选，但带正文描述的媒体消息保留', () => {
    const placeholders = [
      message('image', '[图片] synthetic_intelligence_006.jpg'),
      message('file', '[文件] synthetic_stage_notes_007.pdf'),
      message('voice', '[语音] synthetic_voice_008.mp3'),
      message('video', '[视频] synthetic_stage_video_010.mp4')
    ]
    expect(placeholders.every((item) => isNoiseMessage(item, DEFAULT_DAILY_CONFIG))).toBe(true)
    expect(buildDailyCandidates(placeholders, '2004-02-03').candidates).toHaveLength(0)

    const caption = message('caption', '[图片] 虚构纸偶图示：请按彩色折线拼接六角底座，图中圆点仅表示积木接口。')
    expect(isNoiseMessage(caption, DEFAULT_DAILY_CONFIG)).toBe(false)
  })

  it('文件扩展名、文件名编号不再伪装成产品或重要日期', () => {
    for (const extension of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mp3', 'pdf', 'zip', 'rar', 'docx', 'xlsx', 'pptx', 'txt']) {
      const features = extractFeatures(message(extension, `附件文件.${extension}`), DEFAULT_DAILY_CONFIG)
      expect(features.hasProductOrVersion).toBe(false)
    }
    const image = extractFeatures(message('image', '[图片] synthetic_intelligence_006.jpg'), DEFAULT_DAILY_CONFIG)
    expect(image.hasNumberOrDate).toBe(false)
    expect(image.informationDense).toBe(false)
  })

  it('正文里的真实日期、数量和版本仍然保留信息信号', () => {
    const date = extractFeatures(message('date', '2月9日截止合成剧场报名，虚构席位共 4200 个。'), DEFAULT_DAILY_CONFIG)
    const version = extractFeatures(message('version', 'PaperLoom 8.6 发布纸轮折叠功能。'), DEFAULT_DAILY_CONFIG)
    const product = extractFeatures(message('product', 'Claude Code 合成演示公告展示纸偶网格。'), DEFAULT_DAILY_CONFIG)
    expect(date.hasNumberOrDate).toBe(true)
    expect(version.hasNumberOrDate).toBe(true)
    expect(version.hasProductOrVersion).toBe(true)
    expect(product.hasProductOrVersion).toBe(true)
  })

  it('GitHub、产品更新和可信资源仍保留高价值候选', () => {
    const result = buildDailyCandidates([
      message('github', '虚构练习项目 PaperTile 已开源，绘图代码：https://github.com/example/synthetic-tile-kit'),
      message('update', '虚构演示工具 LocalLens 8.6 发布纸鲸配色报告：https://openai.com/synthetic/paper-whale')
    ], '2004-02-03')
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.every((candidate) => candidate.importanceScore >= DEFAULT_DAILY_CONFIG.minimumScore)).toBe(true)
    expect(result.candidates[0].reasonCodes).toContain('HAS_LINK')
  })

  it('消防安全温馨提示仍保留为候选，不通过文件名或伪产品得分', () => {
    const safety = message('safety', '虚构纸偶剧场的消防演练通知：请于 2月9日 前把纸制道具搬离楼道，保持消防通道畅通，确保模型出口安全。')
    const result = buildDailyCandidates([safety], '2004-02-03')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].importanceScore).toBeGreaterThanOrEqual(DEFAULT_DAILY_CONFIG.minimumScore)
    expect(result.candidates[0].reasonCodes).toEqual(expect.arrayContaining(['SPECIFIC_NUMBER_OR_DATE', 'INFORMATION_DENSE', 'NEW_TOPIC']))
    expect(result.candidates[0].reasonCodes).not.toContain('PRODUCT_OR_VERSION')
  })

  it('高信息量消息获得更高基础分', () => {
    const ordinary = extractFeatures(message('1', '纸制陀螺停在了桌面边缘。'), DEFAULT_DAILY_CONFIG)
    const dense = extractFeatures(message('2', 'PaperLoom 8.6 发布六角纹样功能和 PDF 绘图文档。'), DEFAULT_DAILY_CONFIG)
    expect(messageInformationScore(dense)).toBeGreaterThan(messageInformationScore(ordinary) + 2)
  })

  it('链接消息获得合理加权', () => {
    const plain = extractFeatures(message('1', '虚构纸环项目仅用于描摹圆点。'), DEFAULT_DAILY_CONFIG)
    const linked = extractFeatures(message('2', '虚构纸环项目仅用于描摹圆点：https://github.com/example/synthetic-paper-dots'), DEFAULT_DAILY_CONFIG)
    expect(messageInformationScore(linked)).toBeGreaterThan(messageInformationScore(plain))
  })

  it('多人讨论提高权重并给出原因', () => {
    const features = extractFeatures(message('1', 'PaperLoom 8.6 发布合成棋谱绘图功能。'), DEFAULT_DAILY_CONFIG)
    const single = importanceScore({ features, messageCount: 1, conversationCount: 1, senderCount: 1, hasHighDiscussion: false, isNewTopic: false })
    const discussed = importanceScore({ features, messageCount: 3, conversationCount: 1, senderCount: 3, hasHighDiscussion: true, isNewTopic: false })
    expect(discussed.score).toBeGreaterThan(single.score)
    expect(discussed.reasonCodes).toEqual(expect.arrayContaining(['MULTI_SENDER', 'HIGH_DISCUSSION']))
  })

  it('多群出现提高权重并给出原因', () => {
    const features = extractFeatures(message('1', 'PaperLoom 8.6 发布合成棋谱绘图功能。'), DEFAULT_DAILY_CONFIG)
    const oneGroup = importanceScore({ features, messageCount: 3, conversationCount: 1, senderCount: 3, hasHighDiscussion: true, isNewTopic: false })
    const threeGroups = importanceScore({ features, messageCount: 3, conversationCount: 3, senderCount: 3, hasHighDiscussion: true, isNewTopic: false })
    expect(threeGroups.score).toBeGreaterThan(oneGroup.score)
    expect(threeGroups.reasonCodes).toContain('MULTI_CONVERSATION')
  })

  it('相似候选能够保守归并', () => {
    const input = [
      message('1', '合成剧场用 Claude Code 发布纸偶编号规范。', { conversationId: 'g1', senderId: 'u1' }),
      message('2', 'Claude 编程工具的合成公告包含纸环涂色规则。', { conversationId: 'g2', senderId: 'u2' }),
      message('3', 'Anthropic coding agent 演示如何更新虚构棋盘文档。', { conversationId: 'g3', senderId: 'u3' })
    ]
    const result = buildDailyCandidates(input, '2004-02-03')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].sourceMessageIds).toEqual(['1', '2', '3'])
  })

  it('完全不同事件不会错误归并', () => {
    const result = buildDailyCandidates([
      message('1', 'PaperLoom 8.6 发布六角纹样的绘图版本。'),
      message('2', '虚构纸轮剧场公告：明天下午发布紫色转盘的巡检报告。', { conversationId: 'g2', senderId: 'u2' })
    ], '2004-02-03')
    expect(result.candidates).toHaveLength(2)
  })

  it('source_message_ids 完整保留所有归并依据', () => {
    const input = [
      message('1', 'PaperLoom 8.6 发布合成棋谱绘图功能。', { senderId: 'u1' }),
      message('2', 'PaperLoom 8.6 的合成演示已支持棋谱绘图功能。', { senderId: 'u2' }),
      message('3', '虚构棋谱绘图功能现已加入 PaperLoom 8.6。', { senderId: 'u3' })
    ]
    const candidate = buildDailyCandidates(input, '2004-02-03').candidates[0]
    expect(candidate.sourceMessageIds).toEqual(['1', '2', '3'])
    expect(candidate.messageCount).toBe(3)
  })

  it('排序在同分时保持稳定', () => {
    const input = [
      message('2', 'QuartzTile 8.6 发布虚构棋格。', { timestamp: '2004-02-03T11:00:00.000Z' }),
      message('1', 'LumenTile 8.6 发布合成纸偶。', { timestamp: '2004-02-03T10:00:00.000Z' })
    ]
    const first = buildDailyCandidates(input, '2004-02-03').candidates.map((item) => item.candidateId)
    const second = buildDailyCandidates([...input].reverse(), '2004-02-03').candidates.map((item) => item.candidateId)
    expect(first).toEqual(second)
  })

  it('同一数据重复运行得到完全一致的候选结果', () => {
    const input = createDemoMessages().map((item) => ({
      id: item.messageId,
      conversationId: item.conversationId,
      conversationName: item.conversationName,
      senderId: item.senderId,
      senderName: item.senderName,
      timestamp: item.timestamp,
      content: item.content,
      messageType: item.messageType,
      links: item.links,
      replyTo: item.replyTo
    }))
    const date = input.at(-1)!.timestamp.slice(0, 10)
    const today = input.filter((item) => item.timestamp.startsWith(date))
    expect(buildDailyCandidates(today, date)).toEqual(buildDailyCandidates([...today].reverse(), date))
  })

  it('五千条不同消息可以在候选上限内完成归并', () => {
    const input = Array.from({ length: 5000 }, (_, index) => message(
      String(index),
      `Tool${index} 1.0 发布说明：https://synthetic.invalid/products/${index}`,
      { conversationId: `g${index % 20}`, senderId: `u${index % 100}`, timestamp: `2004-02-03T${String(8 + (index % 12)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z` }
    ))
    const result = buildDailyCandidates(input, '2004-02-03')
    expect(result.totalMessages).toBe(5000)
    expect(result.candidates).toHaveLength(DEFAULT_DAILY_CONFIG.topLimit)
  })

  it('持久化候选可以读取原始依据和前后文', () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    seedDemoData(db)
    const date = createDemoMessages().at(-1)!.timestamp.slice(0, 10)
    const result = runDailyIntelligence(db, date)
    const candidate = result.candidates[0]
    const evidence = getCandidateEvidence(db, candidate.candidateId)
    expect(evidence).not.toBeNull()
    expect(evidence!.groups.map((group) => group.sourceMessageId)).toEqual(candidate.sourceMessageIds)
    expect(evidence!.groups.every((group) => group.messages.some((item) => item.isSource))).toBe(true)
    expect(evidence!.judgment.informationSignalScore).toBe(candidate.importanceScore)
    expect(evidence!.judgment.informationSignals).toEqual(candidate.reasonCodes)
    expect(evidence!.judgment.dailyValue).toMatch(/must_show|may_show|drop/)
    db.close()
  })
})
