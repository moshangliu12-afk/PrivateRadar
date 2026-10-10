import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ImportResult, MetadataProvenance } from '../../shared/models'
import { fileTypeFromName, parseByFileType, type FileType } from './adapters'
import { normalizeMessage, type NormalizedMessage } from './normalize'
import { bindItemMessageSource } from '../batch-import/message-sources'
import { registerKeywordRadarRun } from '../keyword-radar/runs'
import { registerCommitmentExtractorRun } from '../commitment/runs'
import { COMMITMENT_RULE_VERSION } from '../commitment/matcher'
import { getManualJsonItem, SourceContentConflictError } from './manual-json-contract'
import { importManualJsonFile } from './manual-json'

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_REPORTED_ERRORS = 20

export async function importChatFile(db: DatabaseSync, filePath: string, databasePath?: string): Promise<ImportResult> {
  if (process.platform === 'darwin' && !basename(filePath).toLowerCase().endsWith('.json')) {
    throw new Error('当前 macOS 内部版本只支持 JSON 原始证据导入')
  }
  if (fileTypeFromName(basename(filePath)) === 'JSON') {
    const path = databasePath ?? db.location()
    if (!path) throw new Error('JSON 原始证据导入需要文件数据库')
    return importManualJsonFile(db, path, filePath)
  }
  const info = statSync(filePath)
  if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 50 MB，请拆分后再导入')
  const fileName = basename(filePath)
  return importChatContent(db, fileName, fileTypeFromName(fileName), readFileSync(filePath, 'utf8'))
}

export interface ImportChatOptions {
  adapter?: string
  allowMissingMetadata?: boolean
  metadataDefaultSource?: MetadataProvenance
  contentDefaultSource?: MetadataProvenance
  sourceBatchId?: string
  batchItemId?: string
  identityScopedFingerprint?: boolean
  useLegacyFingerprintDedup?: boolean
  messageSource?: string
  onTimestampClassified?: (status: 'present' | 'missing' | 'invalid') => void
  onTiming?: (timing: ImportPipelineTiming) => void
}

export interface ImportPipelineTiming {
  parseMs: number
  normalizeMs: number
  dedupeMs: number
  sqliteWriteAndFtsMs: number
  importJobMs: number
  ftsVerificationMs: number
  totalMs: number
}

export function importChatContent(
  db: DatabaseSync,
  fileName: string,
  fileType: FileType,
  content: string,
  options: ImportChatOptions = {}
): ImportResult {
  const totalStarted = performance.now()
  const jobId = randomUUID()
  const startedAt = new Date().toISOString()
  const manualJson = getManualJsonItem(db, options.batchItemId)
  const committed: { result: ImportResult | null } = { result: null }
  const createJobStarted = performance.now()
  createJob(db, jobId, fileName, fileType, startedAt, manualJson ? 'file' : options.adapter ?? 'file', options.batchItemId)
  let importJobMs = performance.now() - createJobStarted

  try {
    if (manualJson && (fileType !== 'JSON' || manualJson.status !== 'in_progress' || manualJson.effectiveJobId !== null ||
        options.sourceBatchId !== manualJson.sourceBatchId)) throw new Error('手动 JSON 来源未取得执行权')
    const parseStarted = performance.now()
    const parsed = parseByFileType(fileType, content)
    const parseMs = performance.now() - parseStarted
    const normalized: NormalizedMessage[] = []
    const errors = [...parsed.errors]
    const sourceBatchId = options.sourceBatchId ?? `file:${createHash('sha256').update(content).digest('hex')}`
    const normalizeStarted = performance.now()
    for (const [index, row] of parsed.rows.entries()) {
      try {
        const item = normalizeMessage(row.value, fileName, {
          allowMissingMetadata: manualJson ? false : options.allowMissingMetadata,
          metadataDefaultSource: manualJson ? 'source_native' : options.metadataDefaultSource,
          contentDefaultSource: manualJson ? 'source_native' : options.contentDefaultSource,
          sourceBatchId,
          sourcePosition: index,
          identityScopedFingerprint: manualJson ? false : options.identityScopedFingerprint,
          messageSource: manualJson ? 'file' : options.messageSource,
          preserveSourceContent: manualJson !== null
        })
        normalized.push(item)
        options.onTimestampClassified?.(item.message.timestamp ? 'present' : 'missing')
      } catch (error) {
        if (error instanceof Error && error.message === '时间格式无效') {
          options.onTimestampClassified?.('invalid')
        }
        errors.push(`${row.location}：${error instanceof Error ? error.message : '消息无效'}`)
      }
    }
    const normalizeMs = performance.now() - normalizeStarted
    if (manualJson && normalized.length === 0) throw new Error('NO_VALID_MESSAGES: 本来源未导入，没有有效消息；原始证据已保留。')

    let importedCount = 0
    let duplicateCount = 0
    let updatedCount = 0
    let dedupeMs = 0
    let sqliteWriteAndFtsMs = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      const newSourcePositions: number[] = []
      const statements = prepareStatements(db)
      const cacheStarted = performance.now()
      const caches = prepareCaches(db)
      dedupeMs += performance.now() - cacheStarted
      for (const item of normalized) {
        const dedupeStarted = performance.now()
        const sameFingerprint = manualJson ? caches.fingerprints.get(item.fingerprint) : undefined
        if (sameFingerprint && sameFingerprint.content !== item.message.content) {
          throw new SourceContentConflictError(item.message.sourcePosition)
        }
        const existing = findExisting(caches, item, manualJson ? true : options.useLegacyFingerprintDedup ?? true)
        dedupeMs += performance.now() - dedupeStarted
        if (existing) {
          const updateStarted = performance.now()
          const crossItemSource = options.batchItemId && existing.source_batch_id !== item.message.sourceBatchId
          if (options.batchItemId && existing.content !== item.message.content) {
            if (manualJson) throw new SourceContentConflictError(item.message.sourcePosition, false)
            throw new Error('SOURCE_IDENTITY_CONFLICT: 来源身份与正文不一致')
          }
          // 强身份跨附件复用只增加来源，不补全或覆盖已有 canonical 的字段。
          if (manualJson || crossItemSource) {
            duplicateCount += 1
          } else if (enrichExistingMessage(statements, caches, existing, item, startedAt)) updatedCount += 1
          else duplicateCount += 1
          if (options.batchItemId && bindItemMessageSource(db, options.batchItemId, item.message.sourcePosition, existing.id, startedAt, item.message)) {
            newSourcePositions.push(item.message.sourcePosition)
          }
          sqliteWriteAndFtsMs += performance.now() - updateStarted
          continue
        }
        const insertStarted = performance.now()
        insertNormalizedMessage(statements, caches, item, jobId, startedAt)
        if (options.batchItemId && bindItemMessageSource(db, options.batchItemId, item.message.sourcePosition, item.message.messageId, startedAt, item.message)) {
          newSourcePositions.push(item.message.sourcePosition)
        }
        sqliteWriteAndFtsMs += performance.now() - insertStarted
        importedCount += 1
      }
      const invalidCount = errors.length
      const status = invalidCount > 0 ? (normalized.length > 0 ? 'partial' : 'failed') : 'success'
      const result: ImportResult = {
        jobId,
        fileName,
        fileType,
        recognizedCount: normalized.length,
        importedCount,
        duplicateCount,
        updatedCount,
        invalidCount,
        status,
        errors: errors.slice(0, MAX_REPORTED_ERRORS)
      }
      const finishStarted = performance.now()
      if (options.batchItemId) registerKeywordRadarRun(db, options.batchItemId, jobId, newSourcePositions, startedAt)
      // 只登记结构八启用后本次真正新增的来源；旧结构迁移测试不补建任务。
      if (options.batchItemId && newSourcePositions.length > 0 && Number(db.prepare('PRAGMA user_version').get()!.user_version) >= 8) {
        registerCommitmentExtractorRun(db, options.batchItemId, jobId, COMMITMENT_RULE_VERSION, newSourcePositions, startedAt)
      }
      finishJob(db, result, parsed.totalCount)
      if (manualJson) finishManualJsonItem(db, options.batchItemId!, manualJson.batchSessionId, result)
      db.exec('COMMIT')
      if (manualJson) committed.result = result
      importJobMs += performance.now() - finishStarted
      const verifyStarted = performance.now()
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM messages_fts f
        JOIN messages m ON m.rowid = f.rowid
        WHERE m.import_job_id = ?
      `).get(jobId)
      const ftsVerificationMs = performance.now() - verifyStarted
      options.onTiming?.({
        parseMs,
        normalizeMs,
        dedupeMs,
        sqliteWriteAndFtsMs,
        importJobMs,
        ftsVerificationMs,
        totalMs: performance.now() - totalStarted
      })
      return result
    } catch (error) {
      if (!committed.result) db.exec('ROLLBACK')
      throw error
    }
  } catch (error) {
    const committedResult = committed.result
    if (committedResult) {
      return { ...committedResult, errors: [...committedResult.errors,
        'POST_COMMIT_DIAGNOSTIC_FAILED: 核心导入已提交，导入后诊断未完成；已提交的消息和来源保持有效。'] }
    }
    const message = manualJson
      ? error instanceof SourceContentConflictError ? error.message
        : error instanceof Error && error.message.startsWith('NO_VALID_MESSAGES:') ? error.message
          : 'MANUAL_JSON_CORE_FAILED: 本来源未导入，核心事务未能完成；未绑定、覆盖或修改已有记录。'
      : error instanceof Error ? error.message : '未知导入错误'
    const result: ImportResult = {
      jobId,
      fileName,
      fileType,
      recognizedCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      updatedCount: 0,
      invalidCount: 0,
      status: 'failed',
      errors: [message]
    }
    if (manualJson) {
      db.exec('BEGIN IMMEDIATE')
      try {
        finishJob(db, result, 0)
        finishManualJsonItem(db, options.batchItemId!, manualJson.batchSessionId, result)
        db.exec('COMMIT')
      } catch (failure) { db.exec('ROLLBACK'); throw failure }
    } else finishJob(db, result, 0)
    return result
  }
}

function finishManualJsonItem(
  db: DatabaseSync, itemId: string, sessionId: string, result: ImportResult
): void {
  if (!db.isTransaction) throw new Error('手动 JSON 终态必须与核心事务一起保存')
  const now = new Date().toISOString(), status = result.status === 'partial' ? 'partial_success' : result.status
  const changed = db.prepare(
    'UPDATE batch_import_items SET status=?,effective_job_id=?,error_summary=?,updated_at=?,completed_at=? ' +
    "WHERE id=? AND status='in_progress' AND effective_job_id IS NULL"
  ).run(status, result.jobId, result.status === 'failed' ? result.errors[0] : null, now, now, itemId)
  if (changed.changes !== 1) throw new Error('手动 JSON 来源执行权或终态冲突')
  db.prepare('UPDATE batch_import_sessions SET status=?,updated_at=?,completed_at=? WHERE id=?').run(status, now, now, sessionId)
}

function createJob(db: DatabaseSync, jobId: string, fileName: string, fileType: FileType, startedAt: string, adapter: string, batchItemId?: string): void {
  db.prepare(`
    INSERT INTO import_jobs (id, adapter, source_name, file_type, status, started_at, batch_item_id)
    VALUES (?, ?, ?, ?, 'running', ?, ?)
  `).run(jobId, adapter, fileName, fileType, startedAt, batchItemId ?? null)
}

function finishJob(db: DatabaseSync, result: ImportResult, totalCount: number): void {
  db.prepare(`
    UPDATE import_jobs SET
      status = ?, total_count = ?, recognized_count = ?, imported_count = ?,
      duplicate_count = ?, updated_count = ?, error_count = ?, error_details_json = ?, completed_at = ?
    WHERE id = ?
  `).run(
    result.status,
    totalCount,
    result.recognizedCount,
    result.importedCount,
    result.duplicateCount,
    result.updatedCount,
    result.invalidCount,
    JSON.stringify(result.errors),
    new Date().toISOString(),
    result.jobId
  )
}

interface ImportStatements {
  insertConversation: StatementSync
  insertParticipant: StatementSync
  insertMessage: StatementSync
  insertLink: StatementSync
  updateMessage: StatementSync
}

interface ImportCaches {
  sources: Map<string, ExistingMessage>
  identities: Map<string, ExistingMessage>
  fingerprints: Map<string, ExistingMessage>
  conversations: Set<string>
  participants: Set<string>
}

interface ExistingMessage {
  id: string
  content: string
  source_batch_id: string
  platform: string
  conversation_id: string
  conversation_name: string
  conversation_name_source: MetadataProvenance
  sender_id: string
  sender_name: string
  sender_name_source: MetadataProvenance
  timestamp: string
  timestamp_source: MetadataProvenance
  content_source: MetadataProvenance
  source_message_id: string | null
  stable_identity: string | null
  fingerprint: string
}

function prepareStatements(db: DatabaseSync): ImportStatements {
  return {
    insertConversation: db.prepare(`
      INSERT INTO conversations (id, platform, name, conversation_type, created_at)
      VALUES (?, ?, ?, 'group', ?)
      ON CONFLICT(id) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE conversations.name END
    `),
    insertParticipant: db.prepare(`
      INSERT INTO participants (id, platform, display_name, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, id) DO UPDATE SET display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE participants.display_name END
    `),
    insertMessage: db.prepare(`
      INSERT INTO messages (
        id, platform, conversation_id, conversation_name, sender_id, sender_name,
        timestamp, content, message_type, links_json, attachments_json, reply_to,
        source, raw_metadata_json, source_message_id, stable_identity, source_batch_id,
        source_position, conversation_name_source, sender_name_source, timestamp_source,
        content_source, fingerprint, import_job_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertLink: db.prepare(`INSERT OR IGNORE INTO message_links (message_id, url, canonical_url) VALUES (?, ?, ?)`),
    updateMessage: db.prepare(`
      UPDATE messages SET
        conversation_id = ?, conversation_name = ?, conversation_name_source = ?,
        sender_id = ?, sender_name = ?, sender_name_source = ?,
        timestamp = ?, timestamp_source = ?, content_source = ?,
        source_message_id = ?, stable_identity = COALESCE(stable_identity, ?)
      WHERE id = ?
    `)
  }
}

function prepareCaches(db: DatabaseSync): ImportCaches {
  const messages = db.prepare(`
    SELECT id, content, source_batch_id, platform, conversation_id, COALESCE(conversation_name, '') AS conversation_name, conversation_name_source,
           sender_id, COALESCE(sender_name, '') AS sender_name, sender_name_source,
           COALESCE(timestamp, '') AS timestamp, timestamp_source,
           content_source, source_message_id, stable_identity, fingerprint
    FROM messages
  `).all() as unknown as ExistingMessage[]
  const conversations = db.prepare('SELECT id FROM conversations').all() as Array<{ id: string }>
  const participants = db.prepare('SELECT platform, id FROM participants').all() as Array<{ platform: string; id: string }>
  return {
    sources: new Map(messages.flatMap((row) => row.source_message_id ? [[sourceKey(row.platform, row.source_message_id), row] as const] : [])),
    identities: new Map(messages.flatMap((row) => row.stable_identity ? [[row.stable_identity, row] as const] : [])),
    fingerprints: new Map(messages.map((row) => [row.fingerprint, row])),
    conversations: new Set(conversations.map((row) => row.id)),
    participants: new Set(participants.map((row) => participantKey(row.platform, row.id)))
  }
}

function findExisting(caches: ImportCaches, item: NormalizedMessage, useLegacyFingerprintDedup: boolean): ExistingMessage | null {
  const byIdentity = caches.identities.get(item.message.stableIdentity)
  if (byIdentity) return byIdentity
  if (item.sourceMessageId) {
    const bySource = caches.sources.get(sourceKey(item.message.platform, item.sourceMessageId))
    if (bySource) return bySource
  }
  return useLegacyFingerprintDedup ? caches.fingerprints.get(item.fingerprint) ?? null : null
}

function insertNormalizedMessage(statements: ImportStatements, caches: ImportCaches, item: NormalizedMessage, jobId: string, importedAt: string): void {
  const message = item.message
  ensureReferences(statements, caches, message, importedAt)
  statements.insertMessage.run(
    message.messageId,
    message.platform,
    message.conversationId,
    message.conversationName || null,
    message.senderId,
    message.senderName || null,
    message.timestamp || null,
    message.content,
    message.messageType,
    JSON.stringify(message.links),
    JSON.stringify(message.attachments),
    message.replyTo,
    message.source,
    JSON.stringify(message.rawMetadata),
    item.sourceMessageId,
    message.stableIdentity,
    message.sourceBatchId,
    message.sourcePosition,
    message.conversationNameSource,
    message.senderNameSource,
    message.timestampSource,
    message.contentSource,
    item.fingerprint,
    jobId,
    importedAt
  )
  for (const url of message.links) statements.insertLink.run(message.messageId, url, canonicalUrl(url))
  const existing = toExistingMessage(item)
  caches.fingerprints.set(item.fingerprint, existing)
  caches.identities.set(message.stableIdentity, existing)
  if (item.sourceMessageId) caches.sources.set(sourceKey(message.platform, item.sourceMessageId), existing)
}

function enrichExistingMessage(
  statements: ImportStatements,
  caches: ImportCaches,
  existing: ExistingMessage,
  item: NormalizedMessage,
  updatedAt: string
): boolean {
  const incoming = item.message
  let enriched = false

  if (shouldReplace(existing.conversation_name, existing.conversation_name_source, incoming.conversationName, incoming.conversationNameSource)) {
    existing.conversation_id = incoming.conversationId
    existing.conversation_name = incoming.conversationName
    existing.conversation_name_source = incoming.conversationNameSource
    enriched = true
  }
  if (shouldReplace(existing.sender_name, existing.sender_name_source, incoming.senderName, incoming.senderNameSource)) {
    existing.sender_id = incoming.senderId
    existing.sender_name = incoming.senderName
    existing.sender_name_source = incoming.senderNameSource
    enriched = true
  }
  if (shouldReplace(existing.timestamp, existing.timestamp_source, incoming.timestamp, incoming.timestampSource)) {
    existing.timestamp = incoming.timestamp
    existing.timestamp_source = incoming.timestampSource
    enriched = true
  }
  if (provenanceRank(incoming.contentSource) > provenanceRank(existing.content_source)) {
    existing.content_source = incoming.contentSource
    enriched = true
  }
  if (!existing.source_message_id && item.sourceMessageId) {
    existing.source_message_id = item.sourceMessageId
    enriched = true
  }
  const identityAttached = !existing.stable_identity
  if (identityAttached) existing.stable_identity = incoming.stableIdentity

  if (!enriched && !identityAttached) {
    if (existing.stable_identity) caches.identities.set(existing.stable_identity, existing)
    return false
  }

  ensureReferences(statements, caches, incoming, updatedAt, existing)
  statements.updateMessage.run(
    existing.conversation_id,
    existing.conversation_name || null,
    existing.conversation_name_source,
    existing.sender_id,
    existing.sender_name || null,
    existing.sender_name_source,
    existing.timestamp || null,
    existing.timestamp_source,
    existing.content_source,
    existing.source_message_id,
    existing.stable_identity,
    existing.id
  )
  if (existing.stable_identity) caches.identities.set(existing.stable_identity, existing)
  if (existing.source_message_id) caches.sources.set(sourceKey(existing.platform, existing.source_message_id), existing)
  return enriched
}

function shouldReplace(
  currentValue: string,
  currentSource: MetadataProvenance,
  incomingValue: string,
  incomingSource: MetadataProvenance
): boolean {
  return Boolean(incomingValue) && provenanceRank(incomingSource) > provenanceRank(currentSource)
}

function provenanceRank(value: MetadataProvenance): number {
  return { unknown: 0, inferred: 1, user_supplied: 2, source_native: 3 }[value]
}

function ensureReferences(
  statements: ImportStatements,
  caches: ImportCaches,
  message: NormalizedMessage['message'],
  createdAt: string,
  existing?: ExistingMessage
): void {
  const conversationId = existing?.conversation_id ?? message.conversationId
  const conversationName = existing?.conversation_name ?? message.conversationName
  if (!caches.conversations.has(conversationId) || (Boolean(existing) && Boolean(conversationName))) {
    statements.insertConversation.run(conversationId, message.platform, conversationName, createdAt)
    caches.conversations.add(conversationId)
  }
  const senderId = existing?.sender_id ?? message.senderId
  const senderName = existing?.sender_name ?? message.senderName
  const participant = participantKey(message.platform, senderId)
  if (!caches.participants.has(participant) || (Boolean(existing) && Boolean(senderName))) {
    statements.insertParticipant.run(senderId, message.platform, senderName, createdAt)
    caches.participants.add(participant)
  }
}

function toExistingMessage(item: NormalizedMessage): ExistingMessage {
  const message = item.message
  return {
    id: message.messageId,
    content: message.content,
    source_batch_id: message.sourceBatchId,
    platform: message.platform,
    conversation_id: message.conversationId,
    conversation_name: message.conversationName,
    conversation_name_source: message.conversationNameSource,
    sender_id: message.senderId,
    sender_name: message.senderName,
    sender_name_source: message.senderNameSource,
    timestamp: message.timestamp,
    timestamp_source: message.timestampSource,
    content_source: message.contentSource,
    source_message_id: item.sourceMessageId,
    stable_identity: message.stableIdentity,
    fingerprint: item.fingerprint
  }
}

function sourceKey(platform: string, sourceMessageId: string): string {
  return `${platform}\u001f${sourceMessageId}`
}

function participantKey(platform: string, participantId: string): string {
  return `${platform}\u001f${participantId}`
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return value
  }
}
