import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldToMain } from 'node:timers/promises'
import { EXPORT_LIMITS as limits, EXPORT_POLICY } from '../../shared/markdown-export'
import { resolveDisplayConversationName } from '../../shared/conversation-labels'
import type {
  CanonicalExportMessage, CanonicalExportSnapshot, CapturedExportSelection, ExportAttachmentPlaceholder,
  ExportErrorCode, ExportReadProgress, ExportSelectionRequest, ExportSource, ExportSourceOccurrence
} from '../../shared/markdown-export'

export class ExportSelectionError extends Error {
  constructor(readonly code: ExportErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'ExportSelectionError'
  }
}

function fail(code: ExportErrorCode, detail: string): never { throw new ExportSelectionError(code, detail) }
function checkLimit(condition: boolean): void {
  if (!condition) fail('EXPORT_LIMIT_EXCEEDED', '导出超过安全容量，请缩小日期范围。')
}
function checkString(value: unknown): void {
  if (typeof value === 'string') checkLimit(Buffer.byteLength(value, 'utf8') <= limits.max_metadata_string_bytes)
}
function checkMetadata(row: object): void { for (const value of Object.values(row)) checkString(value) }
function systemTimezone(): string {
  const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!timezone) fail('TIME_BOUNDARY_UNSUPPORTED', '无法捕获当前系统本地时区。')
  return timezone
}

function platformValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : null
}
export function platformDisplayName(value: unknown): string {
  const platform = platformValue(value)
  if (!platform) return '来源平台未提供'
  switch (platform) {
    case 'wechat': return '微信'
    case 'qq': return 'QQ'
    case 'feishu': return '飞书'
    case 'local-file': return '本地文件'
    default: return platform
  }
}

function calendarDate(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) {
    fail('INVALID_SELECTION', '日期必须是有效的年月日。')
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('INVALID_SELECTION', '日期不存在。')
  return date
}

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
}
function dateParts(formatter: Intl.DateTimeFormat, instant: number) {
  const fields = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]))
  return { date: `${fields.year.padStart(4, '0')}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}`,
    second: fields.second }
}

/** 搜集转换前后的时区偏移并反向验证；不存在或重叠的当地午夜均拒绝。 */
function localMidnight(date: Date, formatter: Intl.DateTimeFormat): string {
  const expected = date.toISOString().slice(0, 10), utc = date.getTime()
  const candidates = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = utc + hours * 3600000, fields = dateParts(formatter, probe)
    const renderedAsUtc = Date.parse(`${fields.date}T${fields.time}:${fields.second}.000Z`)
    const candidate = utc - (renderedAsUtc - probe)
    const actual = dateParts(formatter, candidate)
    if (actual.date === expected && actual.time === '00:00' && actual.second === '00') candidates.add(candidate)
  }
  if (candidates.size !== 1) fail('TIME_BOUNDARY_UNSUPPORTED', '无法安全确定当地日界，请选择其他范围。')
  return new Date([...candidates][0]).toISOString()
}

export function captureExportSelection(request: ExportSelectionRequest): CapturedExportSelection {
  if (!request || typeof request.conversation_id !== 'string' || !request.conversation_id.trim()) {
    fail('INVALID_SELECTION', '必须选择一个已有会话。')
  }
  checkString(request.conversation_id)
  const range = request.range
  if (!range || !['conversation', 'date_range'].includes(range.type)) fail('INVALID_SELECTION', '导出范围无效。')
  const timezone = systemTimezone(), captured_at = new Date().toISOString()
  let start: string | null = null, end: string | null = null
  if (range.type === 'conversation') {
    if (range.start_date !== null || range.end_date !== null) fail('INVALID_SELECTION', '整个会话不能附带日期边界。')
  } else {
    const first = calendarDate(range.start_date), last = calendarDate(range.end_date)
    if (first > last) fail('INVALID_SELECTION', '开始日期不能晚于结束日期。')
    const formatter = dateFormatter(timezone)
    start = localMidnight(first, formatter)
    last.setUTCDate(last.getUTCDate() + 1)
    if (last.getUTCFullYear() > 9999) fail('TIME_BOUNDARY_UNSUPPORTED', '结束日期的次日超出支持范围。')
    end = localMidnight(last, formatter)
    if (start >= end) fail('TIME_BOUNDARY_UNSUPPORTED', '当地日期范围不能安全解释。')
  }
  if (systemTimezone() !== timezone) fail('TIMEZONE_CHANGED', '导出期间系统时区已改变，请重试。')
  return Object.freeze({ conversation_id: request.conversation_id, range: Object.freeze({ ...range }), timezone,
    captured_at, start_inclusive_utc: start, end_exclusive_utc: end })
}

/** 只接受数据库已经保存的规范时间；不再次解释无时区的历史输入。 */
function canonicalTime(timestamp: unknown, source: unknown): number | null {
  if (source !== 'source_native' && source !== 'user_supplied') return null
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) return null
  const value = Date.parse(timestamp)
  return Number.isFinite(value) && new Date(value).toISOString() === timestamp ? value : null
}

interface MessageRow {
  id: string; platform: string; conversation_name: string | null; conversation_name_source: string
  sender_id: string; sender_name: string | null; sender_name_source: string; timestamp: string | null
  timestamp_source: string; content_source: string; message_type: string; reply_to: string | null
  source_message_id: string | null; source_batch_id: string; source_position: number; attachments_json: string
  body_bytes: number; time_key: number; unknown_key: number
}
interface SourceRow {
  message_id: string; batch_item_id: string; source_position: number
  source_sender_name: string | null; source_sender_name_source: string | null
  source_timestamp: string | null; source_timestamp_source: string | null
  source_conversation_name: string | null; source_conversation_name_source: string | null
  item_id: string | null; source_batch_id: string | null; evidence_status: string; snapshot_sha256: string | null
  evidence_source_kind: string
}

const metadataColumns = ['id', 'platform', 'conversation_name', 'conversation_name_source', 'sender_id', 'sender_name',
  'sender_name_source', 'timestamp', 'timestamp_source', 'content_source', 'message_type', 'reply_to', 'source_message_id',
  'source_batch_id', 'attachments_json'] as const
const selectedCte = `WITH timed AS (SELECT ${metadataColumns.join(',')},source_position,
  length(CAST(content AS BLOB)) AS body_bytes,export_canonical_time(timestamp,timestamp_source) AS canonical_ms
  FROM messages WHERE conversation_id=?), selected AS (
  SELECT *,CASE WHEN canonical_ms IS NULL THEN 1 ELSE 0 END AS unknown_key,COALESCE(canonical_ms,0) AS time_key
  FROM timed WHERE (?=0 OR (canonical_ms>=? AND canonical_ms<?)))`
const placeholderSql = (length: number) => Array.from({ length }, () => '?').join(',')
const binaryCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

function attachmentProjections(row: MessageRow): ExportAttachmentPlaceholder[] {
  let entries: unknown
  try { entries = JSON.parse(row.attachments_json) } catch { entries = null }
  if (!Array.isArray(entries)) entries = [null]
  const records = entries as unknown[]
  if (!records.length && ['image', 'audio', 'video', 'file', 'attachment'].includes(row.message_type)) records.push({ missing: true })
  return records.map((entry, ordinal) => {
    let kind: ExportAttachmentPlaceholder['kind'] = 'unknown'
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>
      if (record.missing === true) kind = 'missing'
      else if (record.message_id !== undefined && record.message_id !== row.id) kind = 'ambiguous'
      else if (['image', 'audio', 'video', 'file'].includes(String(record.type))) kind = record.type as typeof kind
    }
    return { message_id: row.id, ordinal, kind, copied: false, file_state: 'not_checked' }
  })
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child)
    Object.freeze(value)
  }
  return value
}

/** 路径仅由主进程提供；创建独立只读连接，绝不经过初始化、修复或迁移入口。 */
export async function buildCanonicalExportSnapshot(
  databasePath: string, request: ExportSelectionRequest,
  options: { signal?: AbortSignal; onProgress?: (progress: ExportReadProgress) => void } = {}
): Promise<CanonicalExportSnapshot> {
  const started = performance.now(), selection = captureExportSelection(request)
  const guard = () => {
    if (options.signal?.aborted) fail('EXPORT_CANCELLED', '导出已取消。')
    if (performance.now() - started >= limits.read_snapshot_timeout_ms) fail('READ_SNAPSHOT_TIMEOUT', '读取快照超时，请缩小范围。')
    if (systemTimezone() !== selection.timezone) fail('TIMEZONE_CHANGED', '导出期间系统时区已改变，请重试。')
  }
  guard()
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(databasePath, { readOnly: true })
    db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${limits.sqlite_lock_wait_ms}; BEGIN`)
    const timeCache = new Map<string, number | null>()
    let timeChecks = 0
    db.function('export_canonical_time', { deterministic: true }, (timestamp, source) => {
      if (++timeChecks % 4096 === 0) guard()
      checkString(timestamp); checkString(source)
      const key = JSON.stringify([timestamp, source])
      if (timeCache.has(key)) return timeCache.get(key)!
      const time = canonicalTime(timestamp, source)
      if (timeCache.size < limits.max_message_count) timeCache.set(key, time)
      return time
    })
    const conversation = db.prepare('SELECT id,platform,name,user_conversation_label FROM conversations WHERE id=?').get(selection.conversation_id) as
      { id: string; platform: string; name: string; user_conversation_label: string | null } | undefined
    if (!conversation) fail('CONVERSATION_NOT_FOUND', '所选会话不存在。')
    checkMetadata(conversation)
    const platform = platformValue(conversation.platform)
    const names = { sourceConversationName: conversation.name?.trim() ? conversation.name : null, userConversationLabel: conversation.user_conversation_label }
    const displayConversationName = resolveDisplayConversationName(names)
    const baseParams: SQLInputValue[] = [selection.conversation_id, selection.range.type === 'date_range' ? 1 : 0,
      selection.start_inclusive_utc === null ? 0 : Date.parse(selection.start_inclusive_utc),
      selection.end_exclusive_utc === null ? 0 : Date.parse(selection.end_exclusive_utc)]
    const totals = db.prepare(`${selectedCte} SELECT
      (SELECT COUNT(*) FROM timed) AS conversation_count,
      (SELECT COUNT(*) FROM timed WHERE canonical_ms IS NULL) AS unknown_count,
      COUNT(*) AS message_count,COALESCE(SUM(body_bytes),0) AS body_bytes,COALESCE(MAX(body_bytes),0) AS max_body_bytes,
      COALESCE(MAX(MAX(${metadataColumns.map(key => `COALESCE(length(CAST(${key} AS BLOB)),0)`).join(',')})),0) AS metadata_bytes
      FROM selected`).get(...baseParams) as unknown as {
        conversation_count: number; unknown_count: number; message_count: number; body_bytes: number; max_body_bytes: number; metadata_bytes: number
      }
    checkLimit(totals.message_count <= limits.max_message_count && totals.body_bytes <= limits.max_total_body_bytes &&
      totals.max_body_bytes <= limits.max_single_body_bytes && totals.metadata_bytes <= limits.max_metadata_string_bytes)
    const sourceTotals = db.prepare(`${selectedCte} SELECT COUNT(*) AS relation_count,
      COUNT(DISTINCT s.batch_item_id) AS item_count FROM selected m
      JOIN batch_item_message_sources s ON s.message_id=m.id`).get(...baseParams) as unknown as { relation_count: number; item_count: number }
    checkLimit(sourceTotals.relation_count <= limits.max_source_relations && sourceTotals.item_count <= limits.max_unique_source_items)
    guard()
    const formatter = dateFormatter(selection.timezone)
    const messages: CanonicalExportMessage[] = [], sources = new Map<string, ExportSource>()
    const occurrences: ExportSourceOccurrence[] = [], attachments: ExportAttachmentPlaceholder[] = []
    let cursor: MessageRow | undefined, maxBodyBatch = 0, readingUnknown = false
    // 规范时间已是固定宽度的协调世界时文本，顺序等价于时间顺序。
    // 显式时间下界复用已有会话时间索引，避免每一页重新排序整个会话。
    const projection = `${metadataColumns.join(',')},source_position,length(CAST(content AS BLOB)) AS body_bytes`
    const readKnownPage = db.prepare(`SELECT ${projection},0 AS unknown_key,
      export_canonical_time(timestamp,timestamp_source) AS time_key FROM messages
      WHERE conversation_id=? AND timestamp>=? AND timestamp<? AND export_canonical_time(timestamp,timestamp_source) IS NOT NULL
      AND (?=0 OR (timestamp COLLATE BINARY,source_batch_id COLLATE BINARY,source_position,id COLLATE BINARY)>(?,?,?,?))
      ORDER BY timestamp COLLATE BINARY,source_batch_id COLLATE BINARY,source_position,id COLLATE BINARY LIMIT ?`)
    const readUnknownPage = db.prepare(`SELECT ${projection},1 AS unknown_key,0 AS time_key FROM messages
      WHERE conversation_id=? AND export_canonical_time(timestamp,timestamp_source) IS NULL
      AND (?=0 OR (source_batch_id COLLATE BINARY,source_position,id COLLATE BINARY)>(?,?,?))
      ORDER BY source_batch_id COLLATE BINARY,source_position,id COLLATE BINARY LIMIT ?`)
    while (messages.length < totals.message_count) {
      guard()
      const page = (readingUnknown ? readUnknownPage.all(selection.conversation_id, cursor ? 1 : 0,
        cursor?.source_batch_id ?? '', cursor?.source_position ?? 0, cursor?.id ?? '', limits.page_size) :
        readKnownPage.all(selection.conversation_id, cursor?.timestamp ?? selection.start_inclusive_utc ?? '',
          selection.end_exclusive_utc ?? '\uffff', cursor ? 1 : 0, cursor?.timestamp ?? '',
          cursor?.source_batch_id ?? '', cursor?.source_position ?? 0, cursor?.id ?? '', limits.page_size)) as unknown as MessageRow[]
      if (!page.length) {
        if (!readingUnknown && selection.range.type === 'conversation') { readingUnknown = true; cursor = undefined; continue }
        fail('EXPORT_DATA_INVALID', '消息分页与快照计数不一致。')
      }
      for (const row of page) {
        checkMetadata(row)
        if (!Number.isSafeInteger(row.source_position) || row.source_position < 0) fail('EXPORT_DATA_INVALID', '消息来源位置无效。')
      }
      const registeredMessages = new Set<string>()
      const sourceQuery = db.prepare(`SELECT s.message_id,s.batch_item_id,s.source_position,
        s.source_sender_name,s.source_sender_name_source,s.source_timestamp,s.source_timestamp_source,
        s.source_conversation_name,s.source_conversation_name_source,
        i.id AS item_id,i.source_batch_id,i.evidence_status,i.snapshot_sha256,i.evidence_source_kind
        FROM batch_item_message_sources s LEFT JOIN batch_import_items i ON i.id=s.batch_item_id
        WHERE s.message_id IN (${placeholderSql(page.length)})
        ORDER BY s.message_id COLLATE BINARY,s.batch_item_id COLLATE BINARY,s.source_position`)
      // 每个消息页只查询一次来源关系，使用有序游标流式读取，避免大扇出反复排序或整体物化。
      let relationBatch = 0
      for (const value of sourceQuery.iterate(...page.map(row => row.id))) {
        const row = value as unknown as SourceRow
        checkLimit(occurrences.length < limits.max_source_relations)
        checkMetadata(row)
        if (!row.item_id || !Number.isSafeInteger(row.source_position) || row.source_position < 0) {
          fail('EXPORT_DATA_INVALID', '来源关系登记无效。')
        }
        const registered = row.evidence_status === 'available'
        if (registered) registeredMessages.add(row.message_id)
        sources.set(row.item_id, { id: row.item_id, source_batch_id: row.source_batch_id,
          evidence_status: registered ? 'registered' : 'unavailable', registered_status: row.evidence_status,
          snapshot_sha256: row.snapshot_sha256 && /^[0-9a-f]{64}$/i.test(row.snapshot_sha256) ? row.snapshot_sha256 : null,
          evidence_source_kind: row.evidence_source_kind })
        checkLimit(sources.size <= limits.max_unique_source_items)
        occurrences.push({ message_id: row.message_id, source_item_id: row.batch_item_id, source_position: row.source_position,
          sender_name: row.source_sender_name, sender_name_source: row.source_sender_name_source,
          timestamp: row.source_timestamp, timestamp_source: row.source_timestamp_source,
          conversation_name: row.source_conversation_name, conversation_name_source: row.source_conversation_name_source })
        if (++relationBatch === limits.page_size) {
          relationBatch = 0
          await yieldToMain()
          guard()
        }
      }
      const bodies = new Map<string, string>()
      for (let start = 0; start < page.length;) {
        let end = start, bytes = 0
        while (end < page.length && bytes + page[end].body_bytes <= limits.body_batch_bytes) bytes += page[end++].body_bytes
        const group = page.slice(start, end)
        guard()
        const rows = db.prepare(`SELECT id,content FROM messages WHERE id IN (${placeholderSql(group.length)})`)
          .all(...group.map(row => row.id)) as unknown as Array<{ id: string; content: string }>
        maxBodyBatch = Math.max(maxBodyBatch, bytes)
        for (const row of rows) bodies.set(row.id, row.content)
        start = end
        await yieldToMain()
      }
      for (const row of page) {
        const content = bodies.get(row.id)
        if (content === undefined || Buffer.byteLength(content, 'utf8') !== row.body_bytes) fail('EXPORT_DATA_INVALID', '规范正文读取不一致。')
        const known = row.unknown_key === 0, local = known ? dateParts(formatter, row.time_key) : null
        const projectedAttachments = attachmentProjections(row)
        checkLimit(attachments.length + projectedAttachments.length <= limits.max_attachment_placeholders)
        attachments.push(...projectedAttachments)
        messages.push({ id: row.id, platform: platformValue(row.platform), conversation_name: row.conversation_name,
          conversation_name_source: row.conversation_name_source, sender_id: row.sender_id,
          sender_name: ['source_native', 'user_supplied'].includes(row.sender_name_source) && row.sender_name?.trim() ? row.sender_name : null,
          sender_name_source: row.sender_name_source, timestamp: row.timestamp, timestamp_source: row.timestamp_source,
          canonical_timestamp: known ? new Date(row.time_key).toISOString() : null,
          local_date: local?.date ?? null, local_time: local?.time ?? null, content, content_source: row.content_source,
          message_type: row.message_type, reply_to: row.reply_to, source_message_id: row.source_message_id,
          canonical_origin: { source_batch_id: row.source_batch_id, source_position: row.source_position },
          evidence_status: registeredMessages.has(row.id) ? 'registered' : 'unavailable' })
      }
      cursor = page.at(-1)
      options.onProgress?.({ messages_read: messages.length, total_messages: totals.message_count, page_message_count: page.length,
        max_body_batch_bytes: maxBodyBatch, source_relations_read: occurrences.length })
      await yieldToMain()
    }
    guard()
    if (messages.length !== totals.message_count) fail('EXPORT_DATA_INVALID', '消息总数与快照计数不一致。')
    if (occurrences.length !== sourceTotals.relation_count || sources.size !== sourceTotals.item_count) {
      fail('EXPORT_DATA_INVALID', '来源关系与快照计数不一致。')
    }
    // 来源出现独立于规范正文，采用规范消息顺序，再按来源标识和位置稳定排序。
    const order = new Map(messages.map((message, index) => [message.id, index]))
    occurrences.sort((a, b) => order.get(a.message_id)! - order.get(b.message_id)! ||
      binaryCompare(a.source_item_id, b.source_item_id) || a.source_position - b.source_position)
    const snapshot: CanonicalExportSnapshot = {
      policy: EXPORT_POLICY, platform, conversation_id: conversation.id, conversation_name: conversation.name,
      conversation: { id: conversation.id, platform, display_name: displayConversationName, ...names, displayConversationName },
      selection: { ...selection, platform, conversation_message_count: totals.conversation_count, message_count: totals.message_count,
        unknown_time_count: totals.unknown_count, excluded_unknown_time_count: selection.range.type === 'date_range' ? totals.unknown_count : 0,
        total_body_bytes: totals.body_bytes }, messages, sources: [...sources.values()].sort((a, b) => binaryCompare(a.id, b.id)),
      evidence: { verification: 'not_performed', is_evidence_backup: false, occurrences }, attachments
    }
    const frozen = freezeTree(snapshot)
    guard()
    db.exec('COMMIT')
    return frozen
  } catch (error) {
    if (error instanceof ExportSelectionError) throw error
    const code = (error as { errcode?: number }).errcode
    if (code === 5 || code === 6) fail('EXPORT_DATABASE_BUSY', '数据库忙，请稍后重试。')
    // 不向未来界面传递含本机绝对路径或数据库内部信息的底层异常。
    return fail('EXPORT_DATABASE_UNAVAILABLE', '无法读取导出数据库，未执行初始化或修复。')
  } finally {
    if (db) {
      try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() }
    }
  }
}
