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
    expect(status.dataStatus).toEqual({ latestAttempt: null, lastSuccessfulImport: null, latestMessageDate: null })
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

  it('数据状态读取最近任意来源导入、最近成功导入和本地消息日期', () => {
    const db = database()
    const imported = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '数据状态-成功',
      batch_metadata: { conversation_name: '数据状态群' },
      messages: [{ content: '有明确时间的消息', timestamp: '2026-09-19T16:01:00.000Z' }]
    })
    setCompletedAt(db, imported.jobId, '2026-09-20T04:26:04.367Z')
    const status = getFirstUseStatus(db, '测试数据库')
    expect(status.dataStatus).toMatchObject({
      latestAttempt: {
        status: 'success', source: 'WorkBuddy', completedAt: '2026-09-20T04:26:04.367Z',
        recognizedCount: 1, importedCount: 1, duplicateCount: 0, updatedCount: 0, errorCount: 0
      },
      lastSuccessfulImport: { status: 'success', source: 'WorkBuddy', completedAt: '2026-09-20T04:26:04.367Z' },
      latestMessageDate: '2026-09-20'
    })
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count)).toBe(1)
  })

  it('全部重复仍显示为正常完成，并保留重复数量', () => {
    const db = database()
    const first = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '数据状态-重复', batch_metadata: { conversation_name: '重复群' },
      messages: [{ content: '同一条消息', source_message_id: 'same-message' }]
    })
    setCompletedAt(db, first.jobId, '2026-09-20T04:00:00.000Z')
    const duplicate = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '数据状态-重复', batch_metadata: { conversation_name: '重复群' },
      messages: [{ content: '同一条消息', source_message_id: 'same-message' }]
    })
    setCompletedAt(db, duplicate.jobId, '2026-09-20T05:00:00.000Z')
    expect(getFirstUseStatus(db, '测试数据库').dataStatus.latestAttempt).toMatchObject({
      status: 'success', importedCount: 0, duplicateCount: 1, updatedCount: 0, errorCount: 0
    })
  })

  it('最近失败时仍保留之前成功导入，部分成功也如实返回', () => {
    const db = database()
    const successful = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '数据状态-先成功', batch_metadata: { conversation_name: '状态群' }, messages: [{ content: '先成功' }]
    })
    setCompletedAt(db, successful.jobId, '2026-09-20T04:00:00.000Z')
    const partial = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '数据状态-部分成功', batch_metadata: { conversation_name: '状态群' }, messages: [{ content: '部分成功' }, {}]
    })
    setCompletedAt(db, partial.jobId, '2026-09-20T05:00:00.000Z')
    expect(getFirstUseStatus(db, '测试数据库').dataStatus.latestAttempt).toMatchObject({ status: 'partial', importedCount: 1, errorCount: 1 })
    const failed = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '数据状态-失败', batch_metadata: { conversation_name: '状态群' }, messages: [{}]
    })
    setCompletedAt(db, failed.jobId, '2026-09-20T06:00:00.000Z')
    const status = getFirstUseStatus(db, '测试数据库')
    expect(status.dataStatus.latestAttempt).toMatchObject({ status: 'failed', importedCount: 0, errorCount: 1 })
    expect(status.dataStatus.lastSuccessfulImport).toMatchObject({ status: 'partial', completedAt: '2026-09-20T05:00:00.000Z' })
  })

  it('较早失败不会覆盖较晚成功的数据状态', () => {
    const db = database()
    const failed = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '数据状态-旧失败', batch_metadata: { conversation_name: '状态群' }, messages: [{}]
    })
    setCompletedAt(db, failed.jobId, '2026-09-20T04:00:00.000Z')
    const successful = ingestWorkBuddyMessages(db, {
      import_mode: 'quick', source_batch_id: '数据状态-新成功', batch_metadata: { conversation_name: '状态群' }, messages: [{ content: '后来成功' }]
    })
    setCompletedAt(db, successful.jobId, '2026-09-20T05:00:00.000Z')
    const status = getFirstUseStatus(db, '测试数据库')
    expect(status.dataStatus.latestAttempt).toMatchObject({ status: 'success', importedCount: 1 })
    expect(status.dataStatus.lastSuccessfulImport).toMatchObject({ status: 'success', completedAt: '2026-09-20T05:00:00.000Z' })
  })
})

function setCompletedAt(db: DatabaseSync, jobId: string, completedAt: string): void {
  db.prepare('UPDATE import_jobs SET completed_at = ? WHERE id = ?').run(completedAt, jobId)
}
