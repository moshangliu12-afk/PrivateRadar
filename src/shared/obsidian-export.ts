import type { ExportRange, MarkdownExportResult } from './markdown-export'

export interface ObsidianExportRequest {
  readonly conversation_ids: readonly string[]
  readonly range: ExportRange
}
export interface ObsidianVaultSettings { path: string | null; supported: boolean }
export interface ObsidianExportOutcome {
  status: 'completed' | 'cancelled'
  directory: string
  conversationCount: number
  created: number
  updated: number
  skipped: number
  preserved: number
  failed: number
  manifestRecovered: boolean
  userModifiedFilePreserved: boolean
}
export interface ObsidianExportApi {
  settings: () => Promise<MarkdownExportResult<ObsidianVaultSettings>>
  chooseVault: () => Promise<MarkdownExportResult<string | null>>
  start: (request: ObsidianExportRequest) => Promise<MarkdownExportResult<ObsidianExportOutcome>>
  cancel: () => Promise<MarkdownExportResult<null>>
  openOutput: () => Promise<MarkdownExportResult<null>>
}
