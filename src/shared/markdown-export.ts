/** 公共选择与快照不依赖格式渲染器；此文件沿用冻结的生产文件边界。 */
export const EXPORT_POLICY = Object.freeze({
  schema_version: 1,
  template_version: 'markdown-safe-v1',
  render_policy: 'safe-single-line-else-fence-v1',
  time_policy: 'system-local-at-start-v1',
  order_policy: 'canonical-time-batch-position-id-v1'
} as const)

export const EXPORT_LIMITS = Object.freeze({
  max_message_count: 50000,
  max_single_body_bytes: 1048576,
  max_total_body_bytes: 33554432,
  max_source_relations: 200000,
  max_unique_source_items: 10000,
  max_attachment_placeholders: 100000,
  max_metadata_string_bytes: 8192,
  max_markdown_bytes: 67108864,
  max_manifest_bytes: 67108864,
  max_export_bytes: 134217728,
  read_snapshot_timeout_ms: 30000,
  active_export_timeout_ms: 120000,
  sqlite_lock_wait_ms: 1000,
  page_size: 256,
  body_batch_bytes: 2097152
} as const)

export type ExportRange =
  | { readonly type: 'conversation'; readonly start_date: null; readonly end_date: null }
  | { readonly type: 'date_range'; readonly start_date: string; readonly end_date: string }

export interface ExportSelectionRequest {
  readonly conversation_id: string
  readonly range: ExportRange
}

export type ExportFormat = 'markdown' | 'json' | 'txt'
export interface FormattedExportRequest extends ExportSelectionRequest { readonly format?: ExportFormat }

export interface CapturedExportSelection extends ExportSelectionRequest {
  readonly timezone: string
  readonly captured_at: string
  readonly start_inclusive_utc: string | null
  readonly end_exclusive_utc: string | null
}

export interface ExportSelection extends CapturedExportSelection {
  readonly platform: string | null
  readonly conversation_message_count: number
  readonly message_count: number
  readonly unknown_time_count: number
  readonly excluded_unknown_time_count: number
  readonly total_body_bytes: number
}

export type ExportErrorCode = 'INVALID_SELECTION' | 'CONVERSATION_NOT_FOUND' | 'TIMEZONE_CHANGED'
  | 'TIME_BOUNDARY_UNSUPPORTED' | 'EXPORT_LIMIT_EXCEEDED' | 'EXPORT_CANCELLED'
  | 'READ_SNAPSHOT_TIMEOUT' | 'EXPORT_DATA_INVALID' | 'EXPORT_DATABASE_BUSY' | 'EXPORT_DATABASE_UNAVAILABLE'
  | 'EXPORT_PATH_UNSAFE' | 'EXPORT_IO_ERROR' | 'EXPORT_BUSY' | 'EXPORT_UNSUPPORTED'

export interface ExportConversation {
  readonly id: string
  readonly platform: string | null
  readonly display_name: string
  readonly sourceConversationName: string | null
  readonly userConversationLabel: string | null
  readonly displayConversationName: string
}

export interface CanonicalExportMessage {
  readonly id: string
  readonly platform: string | null
  readonly conversation_name: string | null
  readonly conversation_name_source: string
  readonly sender_id: string
  readonly sender_name: string | null
  readonly sender_name_source: string
  readonly timestamp: string | null
  readonly timestamp_source: string
  readonly canonical_timestamp: string | null
  readonly local_date: string | null
  readonly local_time: string | null
  readonly content: string
  readonly content_source: string
  readonly message_type: string
  readonly reply_to: string | null
  readonly source_message_id: string | null
  readonly canonical_origin: { readonly source_batch_id: string; readonly source_position: number }
  readonly evidence_status: 'registered' | 'unavailable'
}

export interface ExportSource {
  readonly id: string
  readonly source_batch_id: string | null
  readonly evidence_status: 'registered' | 'unavailable'
  readonly registered_status: string
  readonly snapshot_sha256: string | null
  readonly evidence_source_kind: string
}

export interface ExportSourceOccurrence {
  readonly message_id: string
  readonly source_item_id: string
  readonly source_position: number
  readonly sender_name: string | null
  readonly sender_name_source: string | null
  readonly timestamp: string | null
  readonly timestamp_source: string | null
  readonly conversation_name: string | null
  readonly conversation_name_source: string | null
}

export interface ExportAttachmentPlaceholder {
  readonly message_id: string
  readonly ordinal: number
  readonly kind: 'image' | 'video' | 'audio' | 'file' | 'unknown' | 'missing' | 'ambiguous'
  readonly copied: false
  readonly file_state: 'not_checked'
}

/** 只在主进程内使用，完整正文及来源数组不得通过进程间通信发送到界面。 */
export interface CanonicalExportSnapshot {
  readonly policy: typeof EXPORT_POLICY
  readonly platform: string | null
  readonly conversation_id: string
  readonly conversation_name: string
  readonly conversation: ExportConversation
  readonly selection: ExportSelection
  readonly messages: readonly CanonicalExportMessage[]
  readonly sources: readonly ExportSource[]
  readonly evidence: {
    readonly verification: 'not_performed'
    readonly is_evidence_backup: false
    readonly occurrences: readonly ExportSourceOccurrence[]
  }
  readonly attachments: readonly ExportAttachmentPlaceholder[]
}

export interface ExportReadProgress {
  readonly messages_read: number
  readonly total_messages: number
  readonly page_message_count: number
  readonly max_body_batch_bytes: number
  readonly source_relations_read: number
}

export interface MarkdownExportConversation {
  conversationId: string
  sourceConversationName: string | null
  userConversationLabel: string | null
  displayConversationName: string
  messageCount: number
}
export interface MarkdownExportOutcome {
  status: 'created' | 'unchanged' | 'empty' | 'cancelled'
  directory: string | null
  messageCount: number
  excludedUnknownTimeCount: number
}
export type MarkdownExportResult<T> = { ok: true; value: T } | { ok: false; error: { code: ExportErrorCode; message: string } }
export interface MarkdownExportApi {
  listConversations: () => Promise<MarkdownExportResult<MarkdownExportConversation[]>>
  chooseDirectory: () => Promise<MarkdownExportResult<string | null>>
  start: (request: FormattedExportRequest) => Promise<MarkdownExportResult<MarkdownExportOutcome>>
  cancel: () => Promise<MarkdownExportResult<null>>
  openOutput: () => Promise<MarkdownExportResult<null>>
}
