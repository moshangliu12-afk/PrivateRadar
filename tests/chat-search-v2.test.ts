import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { understandQuery } from '../src/main/retrieval/query-understanding'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'

describe('问我的聊天 V2 自然语言检索', () => {
  let db: DatabaseSync
  const anchorDate = '2004-02-03'

  beforeAll(() => {
    db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    ingestWorkBuddyMessages(db, {
      source_batch_id: 'search-v2-fire',
      batch_metadata: { conversation_name: '合成演练通知群', conversation_name_source: 'user_supplied' },
      messages: [
        { content: '虚构展馆公告：纸偶演练口令为“清理楼道杂物”，纸制指示牌写着“保障消防安全”。', source_position: 0 },
        { content: '合成沙盘说明：消防通道模型的折叠挡板必须收进圆筒盒。', source_position: 1 }
      ]
    })
    ingestWorkBuddyMessages(db, {
      source_batch_id: 'search-v2-commerce',
      batch_metadata: { conversation_name: '合成道具交换群', conversation_name_source: 'user_supplied' },
      messages: [{ content: '虚构桌游设定：求购游戏币货源样卡，用于纸鲸商店的模拟陈列。', source_position: 0 }]
    })
    ingestWorkBuddyMessages(db, {
      source_batch_id: 'search-v2-tools',
      batch_metadata: { conversation_name: '合成工具演练群', conversation_name_source: 'user_supplied' },
      messages: [
        { content: 'https://workbuddy.example.invalid/catalog', source_position: 0 },
        { content: '虚构沙盘里使用 WorkBuddy 工具给折纸展生成彩格目录。', source_position: 1 },
        { content: '在虚构演示里，Claude Code 的更新内容是纸环编号功能。', source_position: 2 },
        { content: 'DeepSeek 的合成更新公告仅描述沙盘纸鲸的调色功能。', source_position: 3 }
      ]
    })
  })

  afterAll(() => db.close())

  it('S1：精确中文短语仍能命中消防通知', async () => {
    const response = await askChat(db, '清理楼道杂物', { anchorDate, aiProvider: null, embeddingProvider: null })
    expect(response.results.slice(0, 3).some((item) => item.content.includes('保障消防安全'))).toBe(true)
  })

  it('S2：消防主题扩展能命中不同表述的通知', async () => {
    const response = await askChat(db, '小区消防安全', { anchorDate, aiProvider: null, embeddingProvider: null })
    expect(response.results.slice(0, 3).some((item) => item.content.includes('清理楼道杂物'))).toBe(true)
    expect(response.answer).toContain('通知或公告')
    expect(response.understanding.coreTopics).toContain('消防安全')
  })

  it('S3：实体搜索将有上下文的 WorkBuddy 消息排在裸链接前', async () => {
    const response = await askChat(db, 'WorkBuddy', { anchorDate, aiProvider: null, embeddingProvider: null })
    expect(response.results[0].content).toContain('给折纸展生成彩格目录')
    expect(response.results[0].content).not.toBe('https://workbuddy.example.invalid/catalog')
  })

  it('S4：谁在找游戏币货源会剥离问句外壳并保留发送者未知说明', async () => {
    const response = await askChat(db, '谁在找游戏币货源', { anchorDate, aiProvider: null, embeddingProvider: null })
    expect(response.results[0].content).toContain('游戏币货源')
    expect(response.answer).toContain('无法确认是谁发送的')
    expect(response.senderCount).toBe(0)
    expect(response.understanding.personIntent).toBe('who')
  })

  it('S5：最近工具更新将无原始时间的相关证据单独返回', async () => {
    const response = await askChat(db, '最近有人提到什么工具更新吗', { anchorDate, aiProvider: null, embeddingProvider: null })
    const contents = response.unverifiedTimeResults.map((item) => item.content).join('\n')
    expect(contents).toMatch(/Claude Code|DeepSeek/)
    expect(response.unverifiedTimeResults.every((item) => item.timeVerification === 'unknown')).toBe(true)
    expect(response.answer).toContain('原始时间未提供，无法确认是否发生在最近30天')
  })

  it('S6：不存在的特斯拉降价证据仍明确拒答', async () => {
    const response = await askChat(db, '有没有人讨论特斯拉降价', { anchorDate, aiProvider: null, embeddingProvider: null })
    expect(response.insufficientEvidence).toBe(true)
    expect(response.answer).toBe('没有找到足够相关的聊天记录。')
  })

  it('产品、群与发送人结构化筛选仍保留', async () => {
    const understanding = understandQuery(db, '合成工具演练群里 WorkBuddy', anchorDate)
    expect(understanding.conversationNames).toEqual(['合成工具演练群'])
    const response = await askChat(db, '合成工具演练群里 WorkBuddy', { anchorDate, aiProvider: null, embeddingProvider: null })
    expect(response.results.every((item) => item.conversationName === '合成工具演练群')).toBe(true)
  })

  it('严格日期查询不混入缺少原始时间的消息', async () => {
    const response = await askChat(db, '今天 Claude Code', { anchorDate, aiProvider: null, embeddingProvider: null })
    expect(response.insufficientEvidence).toBe(true)
    expect(response.unverifiedTimeResults).toEqual([])
  })
})
