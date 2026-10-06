import { reliableTimestampSql } from './time-semantics'
import { batchMessageMembershipSql } from './batch-import/message-sources'
import { version as productVersion } from '../../package.json'
import type { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import type { DataStatus, DataStatusImport, FirstUseStatus, LatestGuidedImport } from '../shared/models'
import { acknowledgeConnectorTrust, connectorSetupState, detectWorkBuddyInstalled, inspectWorkBuddyConnection, isWorkBuddyConnectorRegistered } from './deployment'

const CONNECTOR_FRESH_MS = 45_000

export function getFirstUseStatus(
  db: DatabaseSync,
  databasePath: string,
  now = new Date(),
  appVersion = productVersion
): FirstUseStatus {
  const messageCount = Number((db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count)
  const batchCount = Number((db.prepare('SELECT COUNT(*) AS count FROM message_import_batches').get() as { count: number }).count)
  const onboarding = setting(db, 'onboarding_completed') === true
  const demoMode = setting(db, 'demo_mode') === true
  const dataDirectory = dirname(databasePath)
  const inspection = inspectWorkBuddyConnection(dataDirectory)
  const connected = inspection.connected || connectorConnected(db, now)
  const connectorState = connectorSetupState(dataDirectory)
  if (connected) acknowledgeConnectorTrust(dataDirectory)
  return {
    firstLaunch: !onboarding && messageCount === 0,
    demoMode,
    appVersion,
    workBuddyConnected: connected,
    workBuddyConnectionMessage: connected ? 'WorkBuddy 已连接。' : inspection.message,
    workBuddyInstalled: detectWorkBuddyInstalled(),
    connectorPrepared: connectorState !== null && isWorkBuddyConnectorRegistered(dataDirectory),
    connectorRequiresRetrust: !connected && connectorState?.trustReason === 'configuration_changed',
    databaseHealthy: databaseQuickCheck(db),
    totalMessageCount: messageCount,
    importBatchCount: batchCount,
    databasePath,
    dataDirectory,
    logDirectory: join(dataDirectory, 'logs'),
    latestImport: latestGuidedImport(db),
    dataStatus: readDataStatus(db)
  }
}

export function markOnboardingComplete(db: DatabaseSync): void {
  setSetting(db, 'onboarding_completed', true)
}

export function markConnectorHeartbeat(db: DatabaseSync, state: 'connected' | 'disconnected', now = new Date()): void {
  setSetting(db, 'workbuddy_connector_status', { connectorId: 'privateradar-workbuddy', state, lastSeenAt: now.toISOString(), pid: process.pid })
}

function connectorConnected(db: DatabaseSync, now: Date): boolean {
  const value = setting(db, 'workbuddy_connector_status')
  if (!isRecord(value) || value.connectorId !== 'privateradar-workbuddy' || value.state !== 'connected' || typeof value.lastSeenAt !== 'string') return false
  const seenAt = Date.parse(value.lastSeenAt)
  return Number.isFinite(seenAt) && now.getTime() - seenAt <= CONNECTOR_FRESH_MS
}

function databaseQuickCheck(db: DatabaseSync): boolean {
  try {
    return (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check === 'ok'
  } catch {
    return false
  }
}

function latestGuidedImport(db: DatabaseSync): LatestGuidedImport | null {
  const row = db.prepare(`
    SELECT b.source_batch_id, b.completeness_level, b.approximate_date,
           j.id AS job_id, j.status, j.recognized_count, j.imported_count, j.duplicate_count,
           j.updated_count, j.error_count, COALESCE(j.completed_at, j.started_at) AS completed_at
    FROM message_import_batches b
    JOIN import_jobs j ON j.id = b.import_job_id
    ORDER BY completed_at DESC, j.id DESC LIMIT 1
  `).get() as LatestImportRow | undefined
  if (!row) return null
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN conversation_name_source <> 'unknown' AND conversation_name IS NOT NULL THEN 1 ELSE 0 END) AS conversation_known,
      SUM(CASE WHEN sender_name_source IN ('source_native', 'user_supplied') AND sender_name IS NOT NULL THEN 1 ELSE 0 END) AS sender_known,
      SUM(CASE WHEN ${reliableTimestampSql()} THEN 1 ELSE 0 END) AS timestamp_known
    FROM messages m WHERE ${batchMessageMembershipSql()}
  `).get(row.source_batch_id, row.source_batch_id, row.source_batch_id) as unknown as BatchStatsRow
  const total = Number(stats.total)
  const conversationStatus = total > 0 && Number(stats.conversation_known) === total ? 'confirmed' : 'missing'
  const senderStatus = total > 0 && Number(stats.sender_known) === total ? 'confirmed' : 'missing'
  const timestampStatus = total > 0 && Number(stats.timestamp_known) === total
    ? 'confirmed' : row.approximate_date ? 'approximate' : 'missing'
  return {
    jobId: row.job_id,
    sourceBatchId: row.source_batch_id,
    status: row.status,
    recognizedCount: Number(row.recognized_count),
    importedCount: Number(row.imported_count),
    duplicateCount: Number(row.duplicate_count),
    updatedCount: Number(row.updated_count),
    invalidCount: Number(row.error_count),
    completenessLevel: row.completeness_level,
    conversationStatus,
    senderStatus,
    timestampStatus,
    contentStatus: Number(row.error_count) === 0 ? 'complete' : 'partial',
    capabilityNotice: capabilityNotice(senderStatus, timestampStatus),
    completedAt: row.completed_at
  }
}

function readDataStatus(db: DatabaseSync): DataStatus {
  const latestAttempt = importStatus(db.prepare(`
    SELECT adapter, source_name, file_type, status, recognized_count, imported_count,
           duplicate_count, updated_count, error_count, started_at,
           COALESCE(completed_at, started_at) AS completed_at
    FROM import_jobs
    WHERE status IN ('success', 'partial', 'failed')
    ORDER BY completed_at DESC, id DESC LIMIT 1
  `).get() as ImportJobStatusRow | undefined)
  const lastSuccessfulImport = importStatus(db.prepare(`
    SELECT adapter, source_name, file_type, status, recognized_count, imported_count,
           duplicate_count, updated_count, error_count, started_at,
           COALESCE(completed_at, started_at) AS completed_at
    FROM import_jobs
    WHERE status IN ('success', 'partial')
    ORDER BY completed_at DESC, id DESC LIMIT 1
  `).get() as ImportJobStatusRow | undefined)
  const row = db.prepare(`
    SELECT MAX(date(timestamp, 'localtime')) AS latest_message_date
    FROM messages WHERE ${reliableTimestampSql()}
  `).get() as { latest_message_date: string | null }
  return { latestAttempt, lastSuccessfulImport, latestMessageDate: row.latest_message_date }
}

function importStatus(row: ImportJobStatusRow | undefined): DataStatusImport | null {
  if (!row) return null
  return {
    status: row.status,
    source: displayImportSource(row),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    recognizedCount: Number(row.recognized_count),
    importedCount: Number(row.imported_count),
    duplicateCount: Number(row.duplicate_count),
    updatedCount: Number(row.updated_count),
    errorCount: Number(row.error_count)
  }
}

function displayImportSource(row: ImportJobStatusRow): string {
  if (row.adapter === 'workbuddy' || row.adapter.includes('workbuddy')) return 'WorkBuddy'
  if (row.adapter === 'file' || row.file_type) return '文件导入'
  return '其他导入'
}

function capabilityNotice(sender: 'confirmed' | 'missing', timestamp: 'confirmed' | 'approximate' | 'missing'): string {
  if (sender === 'confirmed' && timestamp === 'confirmed') return '今日情报、话题雷达和聊天搜索都可以正常使用。'
  if (sender === 'missing' && timestamp !== 'confirmed') return '今日情报和聊天搜索可以正常使用；由于缺少原始发送人和时间，部分趋势统计精度会降低。'
  if (sender === 'missing') return '今日情报和聊天搜索可以正常使用；由于缺少原始发送人，部分人数统计精度会降低。'
  return '今日情报和聊天搜索可以正常使用；由于缺少精确原始时间，部分趋势统计精度会降低。'
}

function setting(db: DatabaseSync, key: string): unknown {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as { value_json: string } | undefined
  if (!row) return null
  try { return JSON.parse(row.value_json) as unknown } catch { return null }
}

function setSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface LatestImportRow {
  source_batch_id: string
  completeness_level: LatestGuidedImport['completenessLevel']
  approximate_date: string | null
  job_id: string
  status: LatestGuidedImport['status']
  recognized_count: number
  imported_count: number
  duplicate_count: number
  updated_count: number
  error_count: number
  completed_at: string
}

interface BatchStatsRow {
  total: number
  conversation_known: number | null
  sender_known: number | null
  timestamp_known: number | null
}

interface ImportJobStatusRow {
  adapter: string
  source_name: string | null
  file_type: string | null
  status: DataStatusImport['status']
  recognized_count: number
  imported_count: number
  duplicate_count: number
  updated_count: number
  error_count: number
  started_at: string
  completed_at: string
}
