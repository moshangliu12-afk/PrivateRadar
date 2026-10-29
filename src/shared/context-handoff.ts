import type { ExportSourceOccurrence, MarkdownExportOutcome, MarkdownExportResult } from './markdown-export'

export const CONTEXT_LIMITS = Object.freeze({ max_messages: 200, max_conversations: 20, max_body_bytes: 2097152, max_output_bytes: 8388608, warning_characters: 20000 })
export interface ContextSelection { readonly message_ids: readonly string[] }
export interface ContextItem {
  readonly type: 'message'
  readonly id: string
  readonly conversationId: string
  readonly displayConversationName: string
  readonly sourceConversationName: string | null
  readonly userConversationLabel: string | null
  readonly platform: string | null
  readonly sender: string | null
  readonly timestamp: string | null
  readonly localDate: string | null
  readonly localTime: string | null
  readonly content: string
  readonly evidenceIds: readonly string[]
  readonly provenance: {
    readonly canonicalOrigin: { readonly source_batch_id: string; readonly source_position: number }
    readonly senderSource: string
    readonly timestampSource: string
    readonly contentSource: string
    readonly sourceMessageId: string | null
    readonly occurrences: readonly ExportSourceOccurrence[]
  }
}
export interface ContextEvidence {
  readonly type: 'evidence'
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly snapshotSha256: string | null
  readonly sourceMessageIds: readonly string[]
  readonly occurrences: readonly ExportSourceOccurrence[]
}
export interface ContextSnapshot {
  readonly schema_version: 1
  readonly generated_at: string
  readonly timezone: string
  readonly items: readonly ContextItem[]
  readonly evidence: readonly ContextEvidence[]
  readonly statistics: { readonly message_count: number; readonly evidence_count: number; readonly character_count: number; readonly large_context: boolean }
}
export interface ContextPreview { readonly snapshot: ContextSnapshot; readonly markdown: string }
export interface ContextHandoffApi {
  preview: (selection: ContextSelection) => Promise<MarkdownExportResult<ContextPreview>>
  copyMarkdown: (selection: ContextSelection) => Promise<MarkdownExportResult<null>>
  chooseDirectory: () => Promise<MarkdownExportResult<string | null>>
  export: (selection: ContextSelection, format: 'markdown' | 'json') => Promise<MarkdownExportResult<MarkdownExportOutcome>>
  cancel: () => Promise<MarkdownExportResult<null>>
  openOutput: () => Promise<MarkdownExportResult<null>>
}
