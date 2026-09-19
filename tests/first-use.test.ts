import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { getTopicRadarSummary, openDatabase } from '../src/main/database'
import { seedDemoData } from '../src/main/demo'
import { getFirstUseStatus, markConnectorHeartbeat, markOnboardingComplete } from '../src/main/first-use'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { initializeDatabase } from '../src/main/schema'

const databases: DatabaseSync[] = []
const tempDirectories: string[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
  while (tempDirectories.length > 0) rmSync(tempDirectories.pop()!, { recursive: true, force: true })
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  initializeDatabase(db)
  databases.push(db)
  return db
}

describe('首次使用体验状态', () => {
  it('首次无数据启动显示欢迎状态且本地数据库正常', () => {
    const status = getFirstUseStatus(database(), '测试数据库')
    expect(status).toMatchObject({
      firstLaunch: true, demoMode: false, workBuddyConnected: false,
      databaseHealthy: true, totalMessageCount: 0, importBatchCount: 0, latestImport: null
    })
  })

  it('体验 Demo 后不再显示首次欢迎页，三个核心功能数据可用', () => {
    const db = database()
    seedDemoData(db)
    markOnboardingComplete(db)
    const status = getFirstUseStatus(db, '测试数据库')
    expect(status.firstLaunch).toBe(false)
    expect(status.demoMode).toBe(true)
    expect(status.totalMessageCount).toBeGreaterThan(1000)
  })

  it('连接心跳只在有效时间内显示已连接，断开后显示未连接', () => {
    const db = database()
    const now = new Date('2026-09-13T04:00:00.000Z')
    markConnectorHeartbeat(db, 'connected', now)
    expect(getFirstUseStatus(db, '测试数据库', new Date(now.getTime() + 30_000)).workBuddyConnected).toBe(true)
    expect(getFirstUseStatus(db, '测试数据库', new Date(now.getTime() + 60_000)).workBuddyConnected).toBe(false)
    markConnectorHeartbeat(db, 'disconnected', now)
    expect(getFirstUseStatus(db, '测试数据库', now).workBuddyConnected).toBe(false)
  })

  it('快速导入、部分无效和失败状态都能生成普通用户完成反馈', () => {
    const db = database()
    const partial = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '首次体验-部分成功',
      batch_metadata: { conversation_name: '体验群' },
      messages: [{ content: '有效消息' }, {}]
    })
    let status = getFirstUseStatus(db, '测试数据库')
    expect(partial.status).toBe('partial')
    expect(status.latestImport).toMatchObject({
      status: 'partial', recognizedCount: 1, importedCount: 1, invalidCount: 1,
      conversationStatus: 'confirmed', senderStatus: 'missing', timestampStatus: 'missing'
    })
    const failed = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '首次体验-失败',
      batch_metadata: { conversation_name: '体验群' }, messages: [{}]
    })
    status = getFirstUseStatus(db, '测试数据库')
    expect(failed.status).toBe('failed')
    expect(status.latestImport).toMatchObject({ status: 'failed', recognizedCount: 0, importedCount: 0, invalidCount: 1 })
  })

  it('导入后重启仍保留首次使用状态、消息、批次和趋势降级提示', () => {
    const directory = mkdtempSync(join(tmpdir(), 'privateradar-first-use-'))
    tempDirectories.push(directory)
    const path = join(directory, 'private-radar.db')
    let db = openDatabase(path)
    ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '首次体验-重启',
      batch_metadata: { conversation_name: '重启测试群' },
      messages: [{ content: 'NovaFlow 正在升温。' }]
    })
    db.close()
    db = openDatabase(path)
    databases.push(db)
    const status = getFirstUseStatus(db, path)
    expect(status).toMatchObject({ firstLaunch: false, totalMessageCount: 1, importBatchCount: 1 })
    expect(getTopicRadarSummary(db).dataQualityNotice).toContain('仅基于时间完整的数据')
  })
})
