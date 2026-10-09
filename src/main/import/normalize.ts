import type { MetadataProvenance, StandardMessage } from '../../shared/models'
import { createIdentityFingerprint, createMessageFingerprint, createScopedId, createStableMessageIdentity } from './fingerprint'
import { isRecord } from './adapters'

export interface NormalizedMessage {
  message: StandardMessage
  fingerprint: string
  sourceMessageId: string | null
}

export interface NormalizeMessageOptions {
  allowMissingMetadata?: boolean
  metadataDefaultSource?: MetadataProvenance
  contentDefaultSource?: MetadataProvenance
  sourceBatchId?: string
  sourcePosition?: number
  identityScopedFingerprint?: boolean
  messageSource?: string
  preserveSourceContent?: boolean
}

export function normalizeMessage(value: unknown, sourceName: string, options: NormalizeMessageOptions = {}): NormalizedMessage {
  if (!isRecord(value)) throw new Error('消息必须是对象')

  const platform = text(value, ['platform']) || 'local-file'
  const conversationName = optionalOrRequiredText(value, ['conversationName', 'conversation_name', 'chatName', 'chat_name', 'groupName', 'group_name', 'group'], '缺少群名', options.allowMissingMetadata)
  const senderName = optionalOrRequiredText(value, ['senderName', 'sender_name', 'sender'], '缺少发送人', options.allowMissingMetadata)
  const content = options.preserveSourceContent
    ? sourceContent(value)
    : requiredText(value, ['content', 'text', 'message'], '缺少正文')
  const timestampText = optionalOrRequiredText(value, ['timestamp', 'time', 'datetime'], '缺少时间', options.allowMissingMetadata)
  const timestamp = timestampText ? normalizeTimestamp(timestampText) : ''
  const rawConversationId = text(value, ['conversationId', 'conversation_id', 'chatId', 'chat_id'])
  const rawSenderId = text(value, ['senderId', 'sender_id'])
  const sourceMessageId = text(value, ['messageId', 'message_id', 'sourceMessageId', 'source_message_id', 'id']) || null
  const sourceBatchId = options.sourceBatchId || text(value, ['sourceBatchId', 'source_batch_id']) || createScopedId('batch', sourceName)
  const sourcePosition = options.sourcePosition ?? numericPosition(value) ?? 0
  const conversationId = createScopedId('conversation', platform, rawConversationId || conversationName || sourceBatchId)
  const senderId = createScopedId('sender', platform, rawSenderId || senderName || sourceBatchId)
  const links = normalizeLinks(value.links, content)
  const attachments = normalizeArray(value.attachments)
  const metadataDefault = options.metadataDefaultSource ?? 'source_native'
  const conversationNameSource = conversationName
    ? provenance(value, ['conversationNameSource', 'conversation_name_source'], metadataDefault)
    : 'unknown'
  const senderNameSource = senderName
    ? provenance(value, ['senderNameSource', 'sender_name_source'], metadataDefault)
    : 'unknown'
  const timestampSource = timestamp
    ? provenance(value, ['timestampSource', 'timestamp_source'], metadataDefault)
    : 'unknown'
  const contentSource = provenance(value, ['contentSource', 'content_source'], options.contentDefaultSource ?? 'source_native')
  const stableIdentity = createStableMessageIdentity({ platform, sourceMessageId, sourceBatchId, sourcePosition, content })

  const message: StandardMessage = {
    messageId: '',
    platform,
    conversationId,
    conversationName,
    senderId,
    senderName,
    timestamp,
    content,
    messageType: text(value, ['messageType', 'message_type', 'type']) || (links.length > 0 ? 'link' : 'text'),
    links,
    attachments,
    replyTo: text(value, ['replyTo', 'reply_to']) || null,
    source: options.messageSource ?? `file:${sourceName}`,
    rawMetadata: value,
    conversationNameSource,
    senderNameSource,
    timestampSource,
    contentSource,
    stableIdentity,
    sourceBatchId,
    sourcePosition
  }
  const fingerprint = options.identityScopedFingerprint ? createIdentityFingerprint(stableIdentity) : createMessageFingerprint(message)
  message.messageId = `message:${stableIdentity.slice('identity:'.length)}`
  return { message, fingerprint, sourceMessageId }
}

function text(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function sourceContent(record: Record<string, unknown>): string {
  for (const key of ['content', 'text', 'message']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  throw new Error('缺少正文')
}

function requiredText(record: Record<string, unknown>, keys: string[], error: string): string {
  const value = text(record, keys)
  if (!value) throw new Error(error)
  return value
}

function optionalOrRequiredText(record: Record<string, unknown>, keys: string[], error: string, optional = false): string {
  const value = text(record, keys)
  if (!value && !optional) throw new Error(error)
  return value
}

function numericPosition(record: Record<string, unknown>): number | null {
  const value = record.source_position ?? record.sourcePosition
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function provenance(record: Record<string, unknown>, keys: string[], fallback: MetadataProvenance): MetadataProvenance {
  const value = text(record, keys)
  if (!value) return fallback
  if (value === 'source_native' || value === 'user_supplied' || value === 'inferred' || value === 'unknown') return value
  throw new Error(`元数据来源标记无效：${value}`)
}

function normalizeTimestamp(value: string): string {
  let candidate = value.trim()
  const simple = candidate.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/)
  if (simple) candidate = `${simple[1]}T${simple[2]}:${simple[3] ?? '00'}+08:00`
  const timestamp = Date.parse(candidate)
  if (!Number.isFinite(timestamp)) throw new Error('时间格式无效')
  return new Date(timestamp).toISOString()
}

function normalizeLinks(value: unknown, content: string): string[] {
  const supplied = normalizeArray(value).filter((item): item is string => typeof item === 'string')
  const fromString = typeof value === 'string' ? value.split(/[;\s]+/) : []
  const detected = content.match(/https?:\/\/[^\s，。；;!?！？]+/g) ?? []
  return Array.from(new Set([...supplied, ...fromString, ...detected].map((item) => item.trim()).filter(isHttpUrl)))
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : [value]
  } catch {
    return [value]
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
