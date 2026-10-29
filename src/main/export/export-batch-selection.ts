import { dirname } from 'node:path'
import { EXPORT_LIMITS, type ExportBatchSummary, type ExportFormat, type ExportRange, type MarkdownExportOutcome } from '../../shared/markdown-export'
import { captureExportSelection, ExportSelectionError } from './chat-selection'

/** 只固定身份和日期选择；正文仍由原单会话导出逐次读取，不累计整批快照。 */
export function captureConversationBatch(value: unknown, range: unknown, primaryId?: unknown) {
  if (!Array.isArray(value) || !value.length || value.includes(undefined) || (primaryId !== undefined && value[0] !== primaryId)
    || value.some(id => typeof id !== 'string' || !id.trim() || Buffer.byteLength(id, 'utf8') > EXPORT_LIMITS.max_metadata_string_bytes)
    || new Set(value).size !== value.length) {
    throw new ExportSelectionError('INVALID_SELECTION', '请选择有效且不重复的会话。')
  }
  const ids: readonly string[] = Object.freeze([...value])
  const selection = captureExportSelection({ conversation_id: ids[0], range: range as ExportRange })
  return { ids, selection }
}

export function assertConversationBatchTimezone(timezone: string): void {
  if (new Intl.DateTimeFormat().resolvedOptions().timeZone !== timezone) {
    throw new ExportSelectionError('TIMEZONE_CHANGED', '系统时区已改变，请重新导出。')
  }
}

/** 主进程区分全局写入故障与单个会话渲染故障，不暴露新公开错误码。 */
export class ConversationBatchFailure {
  constructor(readonly error: unknown, readonly stop: boolean) {}
}
export function stopsConversationBatch(error: unknown): boolean {
  return error instanceof ExportSelectionError && ['TIMEZONE_CHANGED', 'EXPORT_PATH_UNSAFE', 'EXPORT_UNSUPPORTED',
    'EXPORT_LIMIT_EXCEEDED', 'EXPORT_DATABASE_BUSY', 'EXPORT_DATABASE_UNAVAILABLE', 'READ_SNAPSHOT_TIMEOUT', 'EXPORT_IO_ERROR'].includes(error.code)
    || !!error && typeof error === 'object' && ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO', 'ENOTDIR'].includes(String((error as { code?: unknown }).code))
}

/** 依次复用单会话出口，安全写入与容量边界由每个原出口保持。 */
export async function runFormattedExportBatch(value: unknown, range: unknown, primaryId: unknown, format: ExportFormat,
  exportOne: (id: string, range: ExportRange) => Promise<MarkdownExportOutcome>, signal?: AbortSignal): Promise<MarkdownExportOutcome> {
  if (typeof primaryId !== 'string' || !primaryId.trim()) throw new ExportSelectionError('INVALID_SELECTION', '请选择有效的首个会话。')
  const { ids, selection } = captureConversationBatch(value, range, primaryId)
  const summary: ExportBatchSummary = { requested: ids.length, succeeded: 0, created: 0, unchanged: 0,
    empty: 0, failed: 0, remaining: ids.length, errors: [] }
  let output: string | null = null, messageCount = 0, excluded = 0, cancelled = false
  for (const id of ids) {
    if (signal?.aborted) { cancelled = true; break }
    try {
      assertConversationBatchTimezone(selection.timezone)
      const result = await exportOne(id, selection.range)
      messageCount += result.messageCount; excluded += result.excludedUnknownTimeCount
      if (result.status === 'cancelled') { cancelled = true; break }
      if (result.status === 'empty') summary.empty++
      else {
        summary.succeeded++
        if (result.status === 'unchanged') summary.unchanged++; else summary.created++
        output ??= result.directory ? dirname(result.directory) : null
      }
    } catch (caught) {
      const error = caught instanceof ConversationBatchFailure ? caught.error : caught
      if (error instanceof ExportSelectionError && error.code === 'EXPORT_CANCELLED') { cancelled = true; break }
      summary.failed++
      summary.errors.push({ conversationId: id, code: error instanceof ExportSelectionError ? error.code : 'EXPORT_IO_ERROR',
        message: error instanceof ExportSelectionError ? error.message.replace(/^[A-Z_]+: /, '') : '生成或保存文件失败，已有文件已保留。' })
      if (caught instanceof ConversationBatchFailure ? caught.stop : stopsConversationBatch(error)) break
    }
  }
  summary.remaining = summary.requested - summary.succeeded - summary.empty - summary.failed
  return { status: cancelled ? 'cancelled' : summary.failed ? (summary.succeeded ? 'partial' : 'failed')
    : summary.created ? 'created' : summary.unchanged ? 'unchanged' : 'empty', directory: output,
    messageCount, excludedUnknownTimeCount: excluded, batch: summary, ...(format === 'pdf' ? { pdf: summary } : {}) }
}
