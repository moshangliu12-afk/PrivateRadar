import type { CanonicalExportSnapshot, ExportFormat } from '../../shared/markdown-export'
import { EXPORT_LIMITS } from '../../shared/markdown-export'
import { ExportSelectionError } from './chat-selection'
import { canonicalJson, createMarkdownExport, exportProjection, sha256 } from './chat-markdown'
import { renderChatJson } from './chat-json'
import { renderChatTxt } from './chat-txt'

export function validateExportFormat(value: unknown): ExportFormat {
  if (value === undefined) return 'markdown'
  if (value === 'markdown' || value === 'json' || value === 'txt' || value === 'pdf') return value
  throw new ExportSelectionError('INVALID_SELECTION', '请选择 Markdown、JSON、TXT 或 PDF 格式。')
}

/** 旧 Markdown 选择摘要保持不变；新格式在同一投影中加入格式和渲染策略。 */
export function storedExportProjection(saved: Record<string, any>, format: ExportFormat): Record<string, unknown> {
  const projection = Object.fromEntries(['policy', 'conversation', 'selection', 'messages', 'sources', 'evidence', 'attachments'].map(key => [key, saved[key]]))
  return format === 'markdown' ? projection : { ...projection, export_format: saved.export_format, renderer_version: saved.renderer_version }
}

export function createExportFiles(snapshot: CanonicalExportSnapshot, appVersion: string, format: ExportFormat) {
  if (format === 'pdf') throw new ExportSelectionError('INVALID_SELECTION', 'PDF 需要通过隔离打印适配器生成。')
  if (format === 'markdown') {
    const previous = createMarkdownExport(snapshot, appVersion)
    const metadata = JSON.parse(previous.manifest.toString('utf8'))
    metadata.export_format = 'markdown'
    metadata.output = metadata.markdown
    const manifest = Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8')
    checkSize(previous.markdown, manifest)
    return { content: previous.markdown, filename: '聊天.md', manifest, selectionDigest: previous.selectionDigest,
      digestProjection: previous.projection, format, exportVersion: 'markdown-v1' }
  }
  const content = format === 'json' ? renderChatJson(snapshot, appVersion) : renderChatTxt(snapshot)
  const filename = format === 'json' ? '聊天.json' : '聊天.txt'
  const rendererVersion = `${format}-v1`
  const projection = { ...exportProjection(snapshot), policy: { ...snapshot.policy, template_version: rendererVersion,
    render_policy: format === 'json' ? 'structured-json-v1' : 'plain-text-v1' }, export_format: format, renderer_version: rendererVersion }
  const selectionDigest = sha256(canonicalJson(projection))
  const metadata = { schema_version: 1, export_version: rendererVersion, exportedAt: snapshot.selection.captured_at,
    privateRadarVersion: appVersion, selection_digest: selectionDigest, ...projection,
    output_files: [filename, 'export.json'], output: { path: filename, bytes: content.length, sha256: sha256(content) } }
  const manifest = Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8')
  checkSize(content, manifest)
  return { content, filename, manifest, selectionDigest, digestProjection: projection, format, exportVersion: rendererVersion }
}

function checkSize(content: Buffer, manifest: Buffer): void {
  if (content.length > EXPORT_LIMITS.max_markdown_bytes || manifest.length > EXPORT_LIMITS.max_manifest_bytes || content.length + manifest.length > EXPORT_LIMITS.max_export_bytes) {
    throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', '导出文件超过安全大小，未写入输出文件。')
  }
}
