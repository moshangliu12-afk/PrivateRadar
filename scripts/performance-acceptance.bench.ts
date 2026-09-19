import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { MockEmbeddingProvider } from '../src/main/embedding/mock-provider'
import { parseByFileType } from '../src/main/import/adapters'
import { importChatFile } from '../src/main/import/importer'
import { normalizeMessage } from '../src/main/import/normalize'
import { loadMessagesForDate, runDailyIntelligence } from '../src/main/intelligence/daily/repository'
import { buildDailyBrief } from '../src/main/intelligence/daily/brief'
import { runTopicRadar } from '../src/main/intelligence/topics/repository'
import { hybridSearch } from '../src/main/retrieval/hybrid-search'
import { understandQuery } from '../src/main/retrieval/query-understanding'
import { askChat } from '../src/main/retrieval/service'
import { initializeDatabase } from '../src/main/schema'

const END_DATE = '2026-09-12'
const workspace = path.resolve(process.cwd(), '..', '..')
const outputDir = path.join(workspace, 'work', 'performance', 'run-20260913-e')
const sizes = [100, 10_000, 100_000] as const

interface RawMessage {
  platform: string
  conversation_id: string
  conversation_name: string
  sender_id: string
  sender_name: string
  timestamp: string
  content?: string
  message_id: string
}

describe('PrivateRadar V0.1 性能验收', () => {
  it('完成三档隔离数据集与十万条稳定性验证', async () => {
    expect(existsSync(outputDir), `性能目录已存在，请更换运行编号：${outputDir}`).toBe(false)
    mkdirSync(outputDir, { recursive: true })
    const metrics: Record<string, unknown> = { generatedAt: new Date().toISOString(), datasets: {} }
    let largeDb: DatabaseSync | null = null
    let largeDbPath = ''
    let largeRows: RawMessage[] = []

    for (const size of sizes) {
      const datasetDir = path.join(outputDir, String(size))
      mkdirSync(datasetDir, { recursive: true })
      const generated = generateDataset(size)
      const filePath = path.join(datasetDir, `messages-${size}.json`)
      writeFileSync(filePath, JSON.stringify({ messages: generated.rows }))
      const fileBytes = statSync(filePath).size

      const readStart = performance.now()
      const content = readFileSync(filePath, 'utf8')
      const readMs = performance.now() - readStart
      const parseStart = performance.now()
      const parsed = parseByFileType('JSON', content)
      const parseMs = performance.now() - parseStart
      const normalizeStart = performance.now()
      let normalizedCount = 0
      let invalidCount = 0
      for (const row of parsed.rows) {
        try {
          normalizeMessage(row.value, path.basename(filePath))
          normalizedCount += 1
        } catch {
          invalidCount += 1
        }
      }
      const normalizeAndFingerprintMs = performance.now() - normalizeStart

      const dbPath = path.join(datasetDir, 'private-radar.db')
      const db = new DatabaseSync(dbPath)
      initializeDatabase(db)
      const memoryBefore = process.memoryUsage().rss
      const importStart = performance.now()
      const result = importChatFile(db, filePath)
      const importTotalMs = performance.now() - importStart
      const memoryAfterImport = process.memoryUsage().rss
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const uniqueMessages = count(db, 'messages')
      const ftsMessages = Number((db.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'NovaPulse OR Claude OR DataNest'`).get() as { count: number }).count)
      const database = databaseStats(db, dbPath)
      const datasetMetrics: Record<string, unknown> = {
        requestedRows: size,
        generatedUniqueRows: generated.uniqueCount,
        generatedDuplicateRows: generated.duplicateCount,
        generatedInvalidRows: generated.invalidCount,
        fileBytes,
        readMs: round(readMs),
        parseMs: round(parseMs),
        normalizeAndFingerprintMs: round(normalizeAndFingerprintMs),
        estimatedSqliteAndFtsMs: round(Math.max(0, importTotalMs - readMs - parseMs - normalizeAndFingerprintMs)),
        importTotalMs: round(importTotalMs),
        importResult: result,
        normalizedCount,
        invalidCount,
        uniqueMessages,
        ftsMatchedMessages: ftsMessages,
        database,
        processRssBeforeMb: mb(memoryBefore),
        processRssAfterImportMb: mb(memoryAfterImport)
      }
      ;(metrics.datasets as Record<string, unknown>)[String(size)] = datasetMetrics

      expect(result.recognizedCount).toBe(size - generated.invalidCount)
      expect(result.importedCount).toBe(generated.uniqueCount)
      expect(result.duplicateCount).toBe(generated.duplicateCount)
      expect(result.invalidCount).toBe(generated.invalidCount)
      expect(uniqueMessages).toBe(generated.uniqueCount)

      if (size === 100_000) {
        largeDb = db
        largeDbPath = dbPath
        largeRows = generated.uniqueRows
      } else {
        db.close()
      }
      writeFileSync(path.join(outputDir, 'metrics.partial.json'), JSON.stringify(metrics, null, 2))
    }

    expect(largeDb).not.toBeNull()
    const db = largeDb!
    const largeDataset = (metrics.datasets as Record<string, Record<string, unknown>>)['100000']
    const largeFile = path.join(outputDir, '100000', 'messages-100000.json')

    const repeatStart = performance.now()
    const repeatResult = importChatFile(db, largeFile)
    const repeatMs = performance.now() - repeatStart
    expect(repeatResult.importedCount).toBe(0)
    expect(repeatResult.duplicateCount).toBe(99_900)
    expect(count(db, 'messages')).toBe(98_000)
    largeDataset.repeatImportMs = round(repeatMs)
    largeDataset.repeatImportResult = repeatResult
    writeFileSync(path.join(outputDir, 'metrics.partial.json'), JSON.stringify(metrics, null, 2))

    const incrementRows = [
      ...largeRows.slice(0, 8_000),
      ...Array.from({ length: 2_000 }, (_, index) => {
        const message = makeMessage(200_000 + index, 0)
        return { ...message, content: `${message.content} 增量批次 ${index}` }
      })
    ]
    deterministicShuffle(incrementRows, 91)
    const incrementPath = path.join(outputDir, '100000', 'increment-10000.json')
    writeFileSync(incrementPath, JSON.stringify({ messages: incrementRows }))
    const incrementStart = performance.now()
    const incrementResult = importChatFile(db, incrementPath)
    const incrementMs = performance.now() - incrementStart
    expect(incrementResult.importedCount).toBe(2_000)
    expect(incrementResult.duplicateCount).toBe(8_000)
    expect(count(db, 'messages')).toBe(100_000)
    largeDataset.incrementImportMs = round(incrementMs)
    largeDataset.incrementImportResult = incrementResult
    writeFileSync(path.join(outputDir, 'metrics.partial.json'), JSON.stringify(metrics, null, 2))

    const rssBeforeAnalysis = process.memoryUsage().rss
    const readDailyStart = performance.now()
    const selectedDayMessages = loadMessagesForDate(db, END_DATE)
    const dailyReadMs = performance.now() - readDailyStart
    const dailyStart = performance.now()
    const daily = runDailyIntelligence(db, END_DATE)
    const dailyTotalMs = performance.now() - dailyStart
    const d2Start = performance.now()
    const brief = await buildDailyBrief(db, END_DATE, daily.candidates, null)
    const d2RuleMs = performance.now() - d2Start
    largeDataset.daily = {
      selectedDayMessages: selectedDayMessages.length,
      readMs: round(dailyReadMs),
      pipelineAndSaveMs: round(dailyTotalMs),
      estimatedFilterClusterSaveMs: round(Math.max(0, dailyTotalMs - dailyReadMs)),
      candidateCount: daily.candidates.length,
      d2RuleMs: round(d2RuleMs),
      finalItemCount: brief.items.length
    }
    writeFileSync(path.join(outputDir, 'metrics.partial.json'), JSON.stringify(metrics, null, 2))

    const topicReadStart = performance.now()
    const topicWindowMessages = dateRange(END_DATE, 7).reduce((sum, date) => sum + loadMessagesForDate(db, date).length, 0)
    const topicReadMs = performance.now() - topicReadStart
    const topicStart = performance.now()
    const radar = runTopicRadar(db, END_DATE, daily.candidates)
    const topicTotalMs = performance.now() - topicStart
    largeDataset.topicRadar = {
      windowMessages: topicWindowMessages,
      readMs: round(topicReadMs),
      totalMs: round(topicTotalMs),
      estimatedAnalyzeAndSaveMs: round(Math.max(0, topicTotalMs - topicReadMs)),
      topicCount: radar.topics.length
    }
    writeFileSync(path.join(outputDir, 'metrics.partial.json'), JSON.stringify(metrics, null, 2))

    const searchQueries = [
      '谁提到过 NovaPulse 3.2？',
      '谁分享过 GitHub 项目 demo/novapulse？',
      '谁推荐过美化公众号文章的工具？',
      '哪个工具适合在本地处理敏感资料？',
      '今天谁提到 DataNest？',
      '用户001 分享过哪些 GitHub 项目？',
      '性能测试群01 最近讨论过哪些 Claude Code 信息？',
      '最近 7 天有哪些 GitHub 项目？',
      '谁推荐过 Photoshop 2027？',
      '最近大家怎么看 Claude Code？'
    ]
    const searchRows: Array<Record<string, unknown>> = []
    const provider = new MockEmbeddingProvider()
    for (const query of searchQueries) {
      const understandingStart = performance.now()
      const understanding = understandQuery(db, query, END_DATE)
      const understandingMs = performance.now() - understandingStart
      const ftsStart = performance.now()
      const ftsResult = await hybridSearch(db, query, understanding, null)
      const ftsMs = performance.now() - ftsStart
      const hybridStart = performance.now()
      const hybridResult = await hybridSearch(db, query, understanding, provider)
      const hybridMs = performance.now() - hybridStart
      const totalStart = performance.now()
      const response = await askChat(db, query, { anchorDate: END_DATE, aiProvider: null, embeddingProvider: provider })
      const totalMs = performance.now() - totalStart
      searchRows.push({
        query,
        understandingMs: round(understandingMs),
        ftsAndInitialMs: round(ftsMs),
        hybridMs: round(hybridMs),
        estimatedEmbeddingRerankMs: round(Math.max(0, hybridMs - ftsMs)),
        totalQueryMs: round(totalMs),
        resultCount: response.results.length,
        refused: response.insufficientEvidence,
        retrievalMode: response.telemetry.retrievalMode,
        embeddingCandidates: hybridResult.embeddingCandidateCount,
        ftsResultCount: ftsResult.results.length
      })
      largeDataset.searches = searchRows
      writeFileSync(path.join(outputDir, 'metrics.partial.json'), JSON.stringify(metrics, null, 2))
    }
    const queryTimes = searchRows.map((row) => Number(row.totalQueryMs)).sort((left, right) => left - right)
    largeDataset.searches = searchRows
    largeDataset.searchSummary = {
      p50Ms: queryTimes[Math.floor((queryTimes.length - 1) / 2)],
      slowestMs: queryTimes.at(-1),
      slowestQuery: searchRows.sort((left, right) => Number(right.totalQueryMs) - Number(left.totalQueryMs))[0].query
    }

    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const quickCheck = String((db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check)
    const sourceIntegrity = {
      dailySources: count(db, 'daily_candidate_sources'),
      orphanDailySources: Number((db.prepare(`SELECT COUNT(*) AS count FROM daily_candidate_sources s LEFT JOIN messages m ON m.id = s.message_id WHERE m.id IS NULL`).get() as { count: number }).count),
      topicSources: count(db, 'topic_daily_sources'),
      orphanTopicSources: Number((db.prepare(`SELECT COUNT(*) AS count FROM topic_daily_sources s LEFT JOIN messages m ON m.id = s.message_id WHERE m.id IS NULL`).get() as { count: number }).count)
    }
    expect(quickCheck).toBe('ok')
    expect(sourceIntegrity.orphanDailySources).toBe(0)
    expect(sourceIntegrity.orphanTopicSources).toBe(0)
    expect(Number((db.prepare(`SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'NovaPulse'`).get() as { count: number }).count)).toBeGreaterThan(0)
    largeDataset.quickCheck = quickCheck
    largeDataset.sourceIntegrity = sourceIntegrity
    largeDataset.databaseAfterAll = databaseStats(db, largeDbPath)
    largeDataset.processMemory = {
      beforeAnalysisMb: mb(rssBeforeAnalysis),
      afterAnalysisAndSearchMb: mb(process.memoryUsage().rss)
    }
    db.close()

    metrics.largeDatabasePath = largeDbPath
    writeFileSync(path.join(outputDir, 'metrics.json'), JSON.stringify(metrics, null, 2))
    console.log(`PERFORMANCE_METRICS=${path.join(outputDir, 'metrics.json')}`)
  }, 600_000)
})

function generateDataset(total: number): { rows: RawMessage[]; uniqueRows: RawMessage[]; uniqueCount: number; duplicateCount: number; invalidCount: number } {
  const uniqueCount = Math.floor(total * 0.98)
  const invalidCount = Math.max(1, Math.floor(total * 0.001))
  const duplicateCount = total - uniqueCount - invalidCount
  const uniqueRows = Array.from({ length: uniqueCount }, (_, index) => makeMessage(index, index % 45))
  const duplicates = Array.from({ length: duplicateCount }, (_, index) => ({ ...uniqueRows[(index * 47) % uniqueRows.length] }))
  const invalid = Array.from({ length: invalidCount }, (_, index): RawMessage => ({
    platform: 'performance', conversation_id: 'invalid', conversation_name: '无效记录', sender_id: 'invalid',
    sender_name: '无效用户', timestamp: 'not-a-date', message_id: `invalid-${index}`
  }))
  const rows = [...uniqueRows, ...duplicates, ...invalid]
  deterministicShuffle(rows, total + 17)
  return { rows, uniqueRows, uniqueCount, duplicateCount, invalidCount }
}

function makeMessage(index: number, daysAgo: number): RawMessage {
  const group = index % 36
  const sender = index % 144
  const date = shiftDate(END_DATE, -daysAgo)
  const hour = 8 + (index % 14)
  const minute = (index * 7) % 60
  const second = index % 60
  const millisecond = index % 1000
  return {
    platform: 'performance',
    conversation_id: `group-${group}`,
    conversation_name: `性能测试群${String(group + 1).padStart(2, '0')}`,
    sender_id: `user-${sender}`,
    sender_name: `用户${String(sender + 1).padStart(3, '0')}`,
    timestamp: `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(millisecond).padStart(3, '0')}+08:00`,
    content: contentFor(index),
    message_id: `perf-${index}`
  }
}

function contentFor(index: number): string {
  const code = createHash('sha1').update(String(index)).digest('hex').slice(0, 6)
  const highValue = [
    `NovaPulse 3.2 发布增量索引，详情 https://github.com/demo/novapulse/issues/${index % 97}，记录 ${code}。`,
    `Claude Code 长任务体验更新，第 ${index % 31} 位成员反馈上下文保持更稳定，编号 ${code}。`,
    `DataNest 1.4 增量同步已上线，处理文件无需全量扫描，批次 ${code}。`,
    `推荐支持 Markdown 的公众号排版工具 https://tools.example.com/layout/${index % 13}，样式编号 ${code}。`,
    `本地 Ollama 适合处理敏感资料，原文不离开电脑，测试记录 ${code}。`,
    `LocalLens 2.0 离线文档检索发布，官方说明 https://docs.example.com/locallens/${index % 19}，编号 ${code}。`,
    `开源微信小程序项目 https://github.com/demo/miniprogram-${index % 11}，构建编号 ${code}。`,
    `安全公告：依赖解析漏洞已在 4.${index % 9}.1 修复，公告编号 ${code}。`
  ]
  const ordinary = [
    `今天继续整理第 ${index % 83} 项工作，晚些时候同步进度 ${code}。`,
    `这个方案我先看一下，记录编号 ${code}，有结论再回复。`,
    `下午会议调整到 ${9 + index % 9} 点，相关同事注意时间 ${code}。`,
    `刚完成一轮常规检查，暂时没有异常，批次 ${code}。`,
    `周末活动安排还在确认，稍后发最终版本 ${code}。`,
    `文档第 ${index % 27} 节需要补充例子，备注 ${code}。`
  ]
  const noise = ['收到', '好的', '哈哈哈', '谢谢分享', '早上好', '晚点看一下']
  const bucket = index % 20
  if (bucket < 3) return highValue[(Math.floor(index / 20) + bucket) % highValue.length]
  if (bucket < 6) return noise[index % noise.length]
  return ordinary[index % ordinary.length]
}

function deterministicShuffle<T>(items: T[], seed: number): void {
  let state = seed >>> 0
  for (let index = items.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const target = state % (index + 1)
    ;[items[index], items[target]] = [items[target], items[index]]
  }
}

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
}

function databaseStats(db: DatabaseSync, dbPath: string): Record<string, number | null> {
  const pageCount = Number((db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
  const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
  let ftsBytes: number | null = null
  try {
    ftsBytes = Number((db.prepare(`SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name LIKE 'messages_fts%'`).get() as { bytes: number }).bytes)
  } catch {
    ftsBytes = null
  }
  return { fileBytes: statSync(dbPath).size, allocatedBytes: pageCount * pageSize, ftsBytes }
}

function dateRange(date: string, days: number): string[] {
  return Array.from({ length: days + 1 }, (_, index) => shiftDate(date, index - days))
}

function shiftDate(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

function mb(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(1))
}
