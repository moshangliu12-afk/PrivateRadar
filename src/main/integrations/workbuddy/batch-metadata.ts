import { reliableTimestampSql } from '../../time-semantics'
import { batchMessageMembershipSql } from '../../batch-import/message-sources'
import type { DatabaseSync } from 'node:sqlite'
import type { MetadataProvenance } from '../../../shared/models'
import type { WorkBuddyCompletenessLevel, WorkBuddyIngestInput } from './validation'

export interface WorkBuddyBatchSummary {
  sourceBatchId: string
  /** 兼容字段：批次记录首次创建时间，等同 firstAttemptAt。 */
  importedAt: string
  firstAttemptAt: string
  lastAttemptAt: string
  lastSuccessAt: string | null
  importMode: 'quick' | 'complete'
  completenessLevel: WorkBuddyCompletenessLevel
  contentStatus: 'complete' | 'partial'
  conversationStatus: 'confirmed' | 'missing'
  senderStatus: 'confirmed' | 'missing'
  timestampStatus: 'confirmed' | 'approximate' | 'missing'
  capabilityNotice: string
}

export function saveWorkBuddyBatch(
  db: DatabaseSync,
  sourceBatchId: string,
  input: WorkBuddyIngestInput,
  importJobId: string,
  invalidCount: number
): WorkBuddyBatchSummary {
  const previous = db.prepare(`
    SELECT imported_at, first_attempt_at, last_attempt_at, last_success_at,
           conversation_name, conversation_name_source,
           approximate_date, approximate_date_source, sender_mapping_json
    FROM message_import_batches WHERE source_batch_id = ?
  `).get(sourceBatchId) as ExistingBatch | undefined
  const job = db.prepare(`
    SELECT status, started_at, completed_at FROM import_jobs WHERE id = ?
  `).get(importJobId) as { status: string; started_at: string; completed_at: string | null }
  const metadata = input.batch_metadata
  const conversation = chooseField(
    previous?.conversation_name ?? null,
    previous?.conversation_name_source ?? 'unknown',
    metadata?.conversation_name ?? null,
    metadata?.conversation_name_source ?? (metadata?.conversation_name ? 'user_supplied' : 'unknown')
  )
  const approximateDate = chooseField(
    previous?.approximate_date ?? null,
    previous?.approximate_date_source ?? 'unknown',
    metadata?.approximate_date ?? null,
    metadata?.approximate_date_source ?? (metadata?.approximate_date ? 'user_supplied' : 'unknown')
  )
  const senderMapping = metadata?.sender_mapping
    ? JSON.stringify(metadata.sender_mapping)
    : previous?.sender_mapping_json ?? null
  const stats = batchMessageStats(db, sourceBatchId)
  const completenessLevel = completeness(stats, Boolean(approximateDate.value))
  const firstAttemptAt = previous?.first_attempt_at ?? previous?.imported_at ?? job.started_at
  const lastAttemptAt = job.started_at
  const lastSuccessAt = ['success', 'partial'].includes(job.status)
    ? job.completed_at ?? job.started_at
    : previous?.last_success_at ?? null
  const importedAt = firstAttemptAt

  db.prepare(`
    INSERT INTO message_import_batches (
      source_batch_id, import_job_id, import_mode, imported_at,
      first_attempt_at, last_attempt_at, last_success_at,
      conversation_name, conversation_name_source, approximate_date,
      approximate_date_source, sender_mapping_json, completeness_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_batch_id) DO UPDATE SET
      import_job_id = excluded.import_job_id,
      import_mode = excluded.import_mode,
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = COALESCE(excluded.last_success_at, message_import_batches.last_success_at),
      conversation_name = excluded.conversation_name,
      conversation_name_source = excluded.conversation_name_source,
      approximate_date = excluded.approximate_date,
      approximate_date_source = excluded.approximate_date_source,
      sender_mapping_json = excluded.sender_mapping_json,
      completeness_level = excluded.completeness_level
  `).run(
    sourceBatchId, importJobId, input.import_mode ?? 'quick', importedAt,
    firstAttemptAt, lastAttemptAt, lastSuccessAt,
    conversation.value, conversation.source, approximateDate.value,
    approximateDate.source, senderMapping, completenessLevel
  )

  const conversationStatus = stats.total > 0 && stats.conversationKnown === stats.total ? 'confirmed' : 'missing'
  const senderStatus = stats.total > 0 && stats.senderKnown === stats.total ? 'confirmed' : 'missing'
  const timestampStatus = stats.total > 0 && stats.timestampKnown === stats.total
    ? 'confirmed'
    : approximateDate.value ? 'approximate' : 'missing'
  return {
    sourceBatchId,
    importedAt,
    firstAttemptAt,
    lastAttemptAt,
    lastSuccessAt,
    importMode: input.import_mode ?? 'quick',
    completenessLevel,
    contentStatus: invalidCount === 0 ? 'complete' : 'partial',
    conversationStatus,
    senderStatus,
    timestampStatus,
    capabilityNotice: capabilityNotice(senderStatus, timestampStatus)
  }
}

function batchMessageStats(db: DatabaseSync, sourceBatchId: string): BatchStats {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN conversation_name_source <> 'unknown' AND conversation_name IS NOT NULL AND conversation_name <> '' THEN 1 ELSE 0 END) AS conversation_known,
      SUM(CASE WHEN sender_name_source IN ('source_native', 'user_supplied') AND sender_name IS NOT NULL AND sender_name <> '' THEN 1 ELSE 0 END) AS sender_known,
      SUM(CASE WHEN ${reliableTimestampSql()} THEN 1 ELSE 0 END) AS timestamp_known
    FROM messages m WHERE ${batchMessageMembershipSql()}
  `).get(sourceBatchId, sourceBatchId, sourceBatchId) as unknown as BatchStatsRow
  return toBatchStats(row)
}

function toBatchStats(row: BatchStatsRow): BatchStats {
  return {
    total: Number(row.total),
    conversationKnown: Number(row.conversation_known ?? 0),
    senderKnown: Number(row.sender_known ?? 0),
    timestampKnown: Number(row.timestamp_known ?? 0)
  }
}

function completeness(stats: BatchStats, hasApproximateDate: boolean): WorkBuddyCompletenessLevel {
  if (stats.total > 0 && stats.conversationKnown === stats.total && stats.senderKnown === stats.total && stats.timestampKnown === stats.total) return 'complete'
  if (stats.total > 0 && stats.senderKnown === stats.total) return 'sender_known'
  if (hasApproximateDate) return 'approximate_time_known'
  if (stats.total > 0 && stats.conversationKnown === stats.total) return 'conversation_known'
  return 'content_only'
}

function capabilityNotice(senderStatus: 'confirmed' | 'missing', timestampStatus: 'confirmed' | 'approximate' | 'missing'): string {
  if (senderStatus === 'confirmed' && timestampStatus === 'confirmed') return '今日情报、搜索和话题雷达可正常使用。'
  if (senderStatus === 'missing' && timestampStatus === 'missing') return '今日情报和搜索可正常使用；由于缺少发送人和原始时间，话题雷达的独立人数与精确趋势能力会降级。'
  if (senderStatus === 'missing') return '今日情报和搜索可正常使用；由于缺少发送人，话题雷达的独立人数能力会降级。'
  return '今日情报和搜索可正常使用；由于缺少精确原始时间，话题雷达的精确趋势能力会降级。'
}

function chooseField(
  currentValue: string | null,
  currentSource: MetadataProvenance,
  incomingValue: string | null,
  incomingSource: MetadataProvenance
): { value: string | null; source: MetadataProvenance } {
  if (incomingValue && provenanceRank(incomingSource) > provenanceRank(currentSource)) {
    return { value: incomingValue, source: incomingSource }
  }
  return { value: currentValue, source: currentSource }
}

function provenanceRank(value: MetadataProvenance): number {
  return { unknown: 0, inferred: 1, user_supplied: 2, source_native: 3 }[value]
}

interface ExistingBatch {
  imported_at: string
  first_attempt_at: string | null
  last_attempt_at: string | null
  last_success_at: string | null
  conversation_name: string | null
  conversation_name_source: MetadataProvenance
  approximate_date: string | null
  approximate_date_source: MetadataProvenance
  sender_mapping_json: string | null
}

interface BatchStatsRow {
  total: number
  conversation_known: number | null
  sender_known: number | null
  timestamp_known: number | null
}

interface BatchStats {
  total: number
  conversationKnown: number
  senderKnown: number
  timestampKnown: number
}
