import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportResult, MetadataProvenance } from '../../../shared/models'
import { importChatContent, type ImportPipelineTiming } from '../../import/importer'
import { saveWorkBuddyBatch, type WorkBuddyBatchSummary } from './batch-metadata'
import { markOnboardingComplete } from '../../first-use'
import type { WorkBuddyIngestInput, WorkBuddyMessageInput } from './validation'

export type { WorkBuddyIngestInput, WorkBuddyMessageInput } from './validation'

export interface WorkBuddyTiming {
  validationMs: number
  adapterPrepareMs: number
  parseMs: number
  normalizeMs: number
  dedupeMs: number
  sqliteWriteAndFtsMs: number
  ftsVerificationMs: number
  batchAndImportJobMs: number
  rpcHandlerMs: number
}

export interface WorkBuddyIngestResult extends ImportResult, WorkBuddyBatchSummary {
  timestampPresentCount: number
  timestampMissingCount: number
  timestampInvalidCount: number
  timingMs: WorkBuddyTiming
}

export interface WorkBuddyImportContext {
  batchItemId?: string
  sourceBatchId?: string
}

export class WorkBuddyAdapter {
  constructor(private readonly db: DatabaseSync) {}

  ingest(input: WorkBuddyIngestInput, validationMs = 0, context: WorkBuddyImportContext = {}): WorkBuddyIngestResult {
    const handlerStarted = performance.now()
    const prepareStarted = performance.now()
    const sourceBatchId = context.sourceBatchId ?? resolveSourceBatchId(input)
    const messages = input.messages.map((message, index) => applyBatchMetadata(message, index, input))
    const serialized = JSON.stringify({ messages })
    const adapterPrepareMs = performance.now() - prepareStarted
    let pipelineTiming: ImportPipelineTiming | null = null
    const timestampCounts = { present: 0, missing: 0, invalid: 0 }
    const result = importChatContent(
      this.db,
      'workbuddy-mcp.json',
      'JSON',
      serialized,
      {
        adapter: 'workbuddy',
        allowMissingMetadata: true,
        metadataDefaultSource: 'user_supplied',
        contentDefaultSource: 'source_native',
        sourceBatchId,
        batchItemId: context.batchItemId,
        identityScopedFingerprint: true,
        useLegacyFingerprintDedup: false,
        messageSource: 'workbuddy',
        onTimestampClassified: (status) => { timestampCounts[status] += 1 },
        onTiming: (timing) => { pipelineTiming = timing }
      }
    )
    const batchStarted = performance.now()
    const batch = saveWorkBuddyBatch(this.db, sourceBatchId, input, result.jobId, result.invalidCount)
    if (result.recognizedCount > 0 && result.status !== 'failed') markOnboardingComplete(this.db)
    const batchMs = performance.now() - batchStarted
    const measured = pipelineTiming ?? emptyPipelineTiming()
    return {
      ...result,
      ...batch,
      timestampPresentCount: timestampCounts.present,
      timestampMissingCount: timestampCounts.missing,
      timestampInvalidCount: timestampCounts.invalid,
      timingMs: {
        validationMs,
        adapterPrepareMs,
        parseMs: measured.parseMs,
        normalizeMs: measured.normalizeMs,
        dedupeMs: measured.dedupeMs,
        sqliteWriteAndFtsMs: measured.sqliteWriteAndFtsMs,
        ftsVerificationMs: measured.ftsVerificationMs,
        batchAndImportJobMs: measured.importJobMs + batchMs,
        rpcHandlerMs: performance.now() - handlerStarted
      }
    }
  }
}

export function ingestWorkBuddyMessages(
  db: DatabaseSync,
  input: WorkBuddyIngestInput,
  validationMs = 0,
  context: WorkBuddyImportContext = {}
): WorkBuddyIngestResult {
  return new WorkBuddyAdapter(db).ingest(input, validationMs, context)
}

function emptyPipelineTiming(): ImportPipelineTiming {
  return { parseMs: 0, normalizeMs: 0, dedupeMs: 0, sqliteWriteAndFtsMs: 0, importJobMs: 0, ftsVerificationMs: 0, totalMs: 0 }
}

function applyBatchMetadata(message: WorkBuddyMessageInput, index: number, input: WorkBuddyIngestInput): WorkBuddyMessageInput {
  const metadata = input.batch_metadata
  const conversationSource = message.conversation_name_source ?? (message.conversation_name ? 'user_supplied' : 'unknown')
  const batchConversationSource = metadata?.conversation_name_source ?? (metadata?.conversation_name ? 'user_supplied' : 'unknown')
  const useBatchConversation = Boolean(metadata?.conversation_name) && provenanceRank(batchConversationSource) > provenanceRank(conversationSource)
  const marker = message.sender_marker ?? message.sender_name
  const mappedSender = marker ? metadata?.sender_mapping?.[marker] : undefined
  const senderSource = message.sender_name_source ?? (message.sender_name ? 'user_supplied' : 'unknown')
  const useMappedSender = Boolean(mappedSender) && provenanceRank('user_supplied') > provenanceRank(senderSource)
  return {
    ...message,
    conversation_name: useBatchConversation ? metadata!.conversation_name : message.conversation_name,
    conversation_name_source: useBatchConversation ? batchConversationSource : message.conversation_name_source,
    sender_name: useMappedSender ? mappedSender : message.sender_name,
    sender_name_source: useMappedSender ? 'user_supplied' : message.sender_name_source,
    source_position: message.source_position ?? index
  }
}

function provenanceRank(value: MetadataProvenance): number {
  return { unknown: 0, inferred: 1, user_supplied: 2, source_native: 3 }[value]
}

function resolveSourceBatchId(input: WorkBuddyIngestInput): string {
  if (input.source_batch_id) return `workbuddy:${input.source_batch_id}`
  if (input.source_attachment_identity) return `workbuddy-attachment:${input.source_attachment_identity}`
  const stableContents = input.messages.map((message: WorkBuddyMessageInput, index) => ({
    position: message.source_position ?? index,
    platform: message.platform?.trim().toLowerCase() || 'wechat',
    content: (message.content ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  }))
  return `workbuddy-derived:${createHash('sha256').update(JSON.stringify(stableContents)).digest('hex')}`
}
