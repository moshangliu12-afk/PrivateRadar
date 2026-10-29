import type { CanonicalExportSnapshot } from '../../shared/markdown-export'
import { EXPORT_LIMITS } from '../../shared/markdown-export'
import { canonicalJson, exportProjection, sha256 } from './chat-markdown'
import { ExportSelectionError } from './chat-selection'

export type PdfRenderer = (snapshot: CanonicalExportSnapshot, appVersion: string, signal?: AbortSignal) => Promise<Buffer>
export const PDF_RENDERER_VERSION = 'pdf-v1'
export const PDF_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

/** 聊天内容只作为文本节点，所有 HTML 元字符均转义，不解释 Markdown 或用户标签。 */
export function pdfText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
export function createPdfHtml(snapshot: CanonicalExportSnapshot): string {
  const parts: string[] = []
  let bytes = 0
  const append = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > EXPORT_LIMITS.max_markdown_bytes) throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', 'PDF 排版内容超过安全大小，请缩小日期范围。')
    parts.push(text)
  }
  const conversation = snapshot.conversation
  append('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">')
  append('<meta http-equiv="Content-Security-Policy" content="' + pdfText(PDF_CONTENT_SECURITY_POLICY) + '">')
  append('<title>' + pdfText(conversation.displayConversationName) + '</title><style>')
  append('@page{size:A4}*{box-sizing:border-box}html{font-size:10.5pt;color:#20242a;background:#fff}body{margin:0;font-family:"Microsoft YaHei","Segoe UI","Segoe UI Emoji",sans-serif;line-height:1.65;overflow-wrap:anywhere;word-break:break-word}h1{font-size:22pt;line-height:1.35;margin:0 0 12pt;font-weight:650;break-after:avoid-page}h2{font-size:13pt;margin:22pt 0 10pt;padding-bottom:4pt;border-bottom:1px solid #dce1e6;break-after:avoid-page}h3{font-size:10pt;line-height:1.6;margin:12pt 0 5pt;color:#3d4a59;break-after:avoid-page}.metadata{font-size:9pt;line-height:1.65;color:#596370;margin-bottom:18pt}.metadata p{margin:2pt 0}.message-body{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;tab-size:4;orphans:3;widows:3;break-inside:auto}.attachment,.notice{font-size:8.5pt;color:#66717f}.attachment{margin:5pt 0 12pt}.notice{margin-top:12pt}.message{break-inside:auto}header{break-inside:avoid-page}</style></head><body><header>')
  append('<h1>' + pdfText(conversation.displayConversationName) + '</h1><div class="metadata">')
  if (conversation.sourceConversationName !== null) append('<p>来源会话名称：' + pdfText(conversation.sourceConversationName) + '</p>')
  if (conversation.userConversationLabel !== null) append('<p>用户自定义名称：' + pdfText(conversation.userConversationLabel) + '</p>')
  if (snapshot.platform !== null) append('<p>来源平台：' + pdfText(snapshot.platform) + '</p>')
  append('<p>导出时间：' + pdfText(snapshot.selection.captured_at) + '（UTC）</p><p>消息时区：' + pdfText(snapshot.selection.timezone) + ' · 消息数：' + snapshot.messages.length + '</p>')
  const range = snapshot.selection.range
  append('<p>范围：' + (range.type === 'conversation' ? '完整会话（包含未知时间消息）' : pdfText(range.start_date + ' 至 ' + range.end_date)) + '</p>')
  if (snapshot.selection.excluded_unknown_time_count) append('<p>已排除 ' + snapshot.selection.excluded_unknown_time_count + ' 条未知时间消息。</p>')
  append('</div></header>')
  const attachments = new Map<string, number>()
  for (const item of snapshot.attachments) attachments.set(item.message_id, (attachments.get(item.message_id) ?? 0) + 1)
  let day: string | null = null
  for (const message of snapshot.messages) {
    const date = message.local_date ?? '时间未提供'
    if (date !== day) { append('<h2>' + pdfText(date) + '</h2>'); day = date }
    append('<section class="message"><h3>' + pdfText(message.local_time ?? '时间未提供') + ' · ' + pdfText(message.sender_name ?? '发送人未提供') + '</h3>')
    append('<div class="message-body">' + pdfText(message.content) + '</div>')
    if (attachments.has(message.id)) append('<p class="attachment">附件：' + attachments.get(message.id) + ' 项（未复制；未检查文件）。</p>')
    append('</section>')
  }
  append('<p class="notice">PrivateRadar 静态聊天导出；来源证据未重新验证，本文件不是 Evidence 备份。</p></body></html>')
  return parts.join('')
}
export function assertPdfBytes(bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || bytes.length < 50 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
    || !bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from('%%EOF'))) {
    throw new ExportSelectionError('EXPORT_IO_ERROR', 'PDF 生成结果无效，未发布输出文件。')
  }
  if (bytes.length > EXPORT_LIMITS.max_markdown_bytes) throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', 'PDF 超过安全大小，请缩小日期范围。')
}
export async function createPdfExportFiles(snapshot: CanonicalExportSnapshot, appVersion: string, filename: string, renderer: PdfRenderer, signal?: AbortSignal) {
  const content = await renderer(snapshot, appVersion, signal)
  assertPdfBytes(content)
  const projection = { ...exportProjection(snapshot), policy: { ...snapshot.policy,
    template_version: PDF_RENDERER_VERSION, render_policy: 'escaped-html-a4-v1' },
    export_format: 'pdf', renderer_version: PDF_RENDERER_VERSION }
  const selectionDigest = sha256(canonicalJson(projection))
  const metadata = { schema_version: 1, export_version: PDF_RENDERER_VERSION, exportedAt: snapshot.selection.captured_at,
    privateRadarVersion: appVersion, selection_digest: selectionDigest, ...projection,
    output_files: [filename, 'export.json'], output: { path: filename, bytes: content.length, sha256: sha256(content) } }
  const manifest = Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8')
  if (manifest.length > EXPORT_LIMITS.max_manifest_bytes || content.length + manifest.length > EXPORT_LIMITS.max_export_bytes) {
    throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', 'PDF 导出元数据超过安全大小，未发布输出文件。')
  }
  return { content, filename, manifest, selectionDigest, digestProjection: projection, format: 'pdf' as const, exportVersion: PDF_RENDERER_VERSION }
}
