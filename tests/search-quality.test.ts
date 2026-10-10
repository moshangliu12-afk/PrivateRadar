import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedDemoData } from '../src/main/demo'
import { MockEmbeddingProvider } from '../src/main/embedding/mock-provider'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'
import type { ChatQueryResponse } from '../src/shared/models'

interface QualityCase {
  query: string
  top1?: RegExp
  valid?: RegExp
  refused?: boolean
  sender?: string
  conversation?: string
  dateCheck?: (response: ChatQueryResponse, anchorDate: string) => void
}

const cases: QualityCase[] = [
  { query: '谁分享过 PrivateIndex？', top1: /PrivateIndex/, valid: /PrivateIndex|private-index/ },
  { query: 'DataNest 1.4 是谁提到的？', top1: /DataNest 1\.4/, valid: /DataNest/ },
  { query: '谁发过微信小程序 GitHub 项目？', top1: /miniprogram-starter/, valid: /微信小程序.*github\.com/i },
  { query: '公众号排版工具是谁推荐的？', top1: /公众号排版工具|Markdown 编辑器/, valid: /公众号.*排版|Markdown.*公众号/ },
  { query: '谁发布了 LocalLens 2.0？', top1: /LocalLens 2\.0/, valid: /LocalLens/ },
  { query: '谁发过依赖解析漏洞修复公告？', top1: /依赖解析漏洞/, valid: /依赖解析漏洞/ },

  { query: '谁推荐过美化公众号文章的工具？', top1: /公众号排版工具|Markdown 编辑器/, valid: /公众号.*排版|Markdown.*公众号/ },
  { query: '哪个工具适合在本地处理敏感资料？', top1: /Ollama/, valid: /Ollama|private-index/ },
  { query: '哪个产品升级后不用重新扫描全部文件？', top1: /DataNest/, valid: /DataNest/ },
  { query: '谁分享过开源的本地聊天索引？', top1: /PrivateIndex/, valid: /PrivateIndex|private-index/ },
  { query: '编程代理处理长任务的体验怎么样？', top1: /Claude/, valid: /Claude|Anthropic coding agent/ },

  {
    query: '昨天谁讨论过 Claude Code？', top1: /Claude/, valid: /Claude|Anthropic coding agent/,
    dateCheck: (response, anchor) => {
      const expected = shiftDays(anchor, -1)
      expect(response.understanding.dateRange).toEqual({ label: '昨天', start: expected, end: expected })
      expect(response.results.every((item) => localDate(item.timestamp) === expected)).toBe(true)
    }
  },
  {
    query: '最近 7 天有哪些 GitHub 项目？', top1: /github\.com/i, valid: /github\.com/i,
    dateCheck: (response, anchor) => {
      expect(response.understanding.dateRange).toEqual({ label: '最近7天', start: shiftDays(anchor, -6), end: anchor })
      expect(inRange(response, shiftDays(anchor, -6), anchor)).toBe(true)
    }
  },
  {
    query: '本周谁分享过公众号工具？', top1: /公众号.*排版|Markdown.*公众号/, valid: /公众号.*排版|Markdown.*公众号/,
    dateCheck: (response, anchor) => {
      expect(response.understanding.dateRange.label).toBe('本周')
      expect(inRange(response, response.understanding.dateRange.start!, anchor)).toBe(true)
    }
  },
  {
    query: '今天谁提到 DataNest？', top1: /DataNest/, valid: /DataNest/,
    dateCheck: (response, anchor) => {
      expect(response.understanding.dateRange).toEqual({ label: '今天', start: anchor, end: anchor })
      expect(response.results.every((item) => localDate(item.timestamp) === anchor)).toBe(true)
    }
  },

  { query: '云舒推荐过哪些工具？', top1: /公众号排版工具|Markdown 编辑器/, valid: /公众号排版工具|Markdown 编辑器|内容工具调研报告/, sender: '云舒' },
  { query: '嘉木分享过哪些 GitHub 项目？', top1: /github\.com/i, valid: /github\.com/i, sender: '嘉木' },
  { query: '林舟提到过哪些 Claude Code 信息？', top1: /Claude/, valid: /Claude/, sender: '林舟' },

  { query: 'AI 产品观察站最近讨论过哪些 AI 工具？', top1: /Claude|GPT|DataNest|LocalLens|Ollama|PrivateIndex/, valid: /Claude|Anthropic|GPT|DataNest|LocalLens|Ollama|PrivateIndex|知识库检索/, conversation: 'AI 产品观察站' },
  { query: '效率工具交流群里谁分享过 GitHub 项目？', top1: /github\.com/i, valid: /github\.com/i, conversation: '效率工具交流群' },
  { query: '内容创作实验室里谁讨论过公众号工具？', top1: /公众号.*排版|Markdown.*公众号/, valid: /公众号.*排版|Markdown.*公众号/, conversation: '内容创作实验室' },

  { query: '谁推荐过 Photoshop 2027？', refused: true },
  { query: '谁分享过 GitHub 项目 ghost/never？', refused: true },
  { query: '谁用过 QuantumNote 9.9？', refused: true },
  { query: '谁推荐过火星数据库？', refused: true }
]

describe('搜索质量验收', () => {
  let db: DatabaseSync
  let anchorDate: string
  const provider = new MockEmbeddingProvider()

  beforeAll(() => {
    db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    seedDemoData(db)
    anchorDate = (db.prepare(`SELECT MAX(date(timestamp, 'localtime')) AS date FROM messages`).get() as { date: string }).date
  })

  afterAll(() => db.close())

  it.each(cases)('$query', async (qualityCase) => {
    const response = await askChat(db, qualityCase.query, { anchorDate, aiProvider: null, embeddingProvider: provider })
    if (qualityCase.refused) {
      expect(response.insufficientEvidence).toBe(true)
      expect(response.results).toEqual([])
      expect(response.answer).toBe('没有找到足够相关的聊天记录。')
      return
    }

    expect(response.insufficientEvidence).toBe(false)
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.results[0].content).toMatch(qualityCase.top1!)
    expect(response.results.slice(0, 3).some((item) => qualityCase.valid!.test(item.content))).toBe(true)
    const invalidTop5 = response.results.slice(0, 5).filter((item) => !qualityCase.valid!.test(item.content))
    expect(invalidTop5.map((item) => item.content)).toEqual([])
    if (qualityCase.sender) expect(response.results.every((item) => item.senderName === qualityCase.sender)).toBe(true)
    if (qualityCase.conversation) expect(response.results.every((item) => item.conversationName === qualityCase.conversation)).toBe(true)
    qualityCase.dateCheck?.(response, anchorDate)
  }, 20_000)
})

function shiftDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function inRange(response: ChatQueryResponse, start: string, end: string): boolean {
  return response.results.every((item) => {
    const date = localDate(item.timestamp)
    return date >= start && date <= end
  })
}

function localDate(timestamp: string): string {
  const date = new Date(timestamp)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
