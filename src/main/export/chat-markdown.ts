import { createHash } from 'node:crypto'
import type { CanonicalExportSnapshot } from '../../shared/markdown-export'
import { EXPORT_LIMITS } from '../../shared/markdown-export'
import { ExportSelectionError, platformDisplayName } from './chat-selection'

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

/** 对象键固定排序；数组保留规范消息和来源顺序。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function exportProjection(snapshot: CanonicalExportSnapshot) {
  const { captured_at: _capturedAt, ...selection } = snapshot.selection
  return {
    policy: snapshot.policy,
    conversation: snapshot.conversation,
    selection,
    messages: snapshot.messages.map(({ content, ...message }) => ({ ...message, content_sha256: sha256(content), content_bytes: Buffer.byteLength(content, 'utf8') })),
    sources: snapshot.sources,
    evidence: snapshot.evidence,
    attachments: snapshot.attachments
  }
}

export function markdownText(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~]/g, '\\$&')
}

/** 不 trim、不换行归一化；复杂原文放入比原文最长反引号串更长的字面文本围栏。 */
export function renderMessageBody(body: string): string {
  if (body.length && body.trim() === body && !/[\r\n\t\\`*_{}\[\]()<>#+!|~&]/.test(body)
    && !/ {2,}|^(?:[-=>]|\d+[.)])/.test(body) && !/(?:https?:|www\.)/i.test(body)) return body
  let longest = 0
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${body.trim() ? '' : '（空白消息，原文保留如下）\n\n'}${fence}text\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}`
}

export function createMarkdownExport(snapshot: CanonicalExportSnapshot, appVersion: string) {
  const projection = exportProjection(snapshot), selectionDigest = sha256(canonicalJson(projection))
  const parts: string[] = []
  let size = 0
  function append(text: string) {
    size += Buffer.byteLength(text, 'utf8')
    if (size > EXPORT_LIMITS.max_markdown_bytes) throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', 'Markdown 超过安全大小，未写入输出文件。')
    parts.push(text)
  }
  const range = snapshot.selection.range
  append(`# ${markdownText(snapshot.conversation.displayConversationName)}\n\n`)
  append(`- 来源平台：${markdownText(platformDisplayName(snapshot.platform))}\n`)
  append(`- 来源会话名称：${markdownText(snapshot.conversation.sourceConversationName ?? '未提供')}\n`)
  append(`- 用户自定义名称：${markdownText(snapshot.conversation.userConversationLabel ?? '未设置')}\n`)
  append(`- 导出时间：${snapshot.selection.captured_at}\n- 消息数：${snapshot.messages.length}\n`)
  append(`- 范围：${range.type === 'conversation' ? '完整会话（包含未知时间消息）' : `${range.start_date} 至 ${range.end_date}`}\n`)
  append(`- 时区：${markdownText(snapshot.selection.timezone)}\n- 元数据：[export.json](export.json)\n`)
  append('- 本文件是静态聊天导出，不是 Evidence 备份；附件未复制，来源证据未重新验证。\n')
  if (snapshot.selection.excluded_unknown_time_count) append(`- 本日期范围排除 ${snapshot.selection.excluded_unknown_time_count} 条未知时间消息。\n`)
  const attachments = new Map<string, typeof snapshot.attachments[number][]>()
  for (const item of snapshot.attachments) {
    const values = attachments.get(item.message_id) ?? []
    values.push(item); attachments.set(item.message_id, values)
  }
  const labels = { image: '图片', video: '视频', audio: '语音', file: '文件', unknown: '未知附件', missing: '附件登记缺失', ambiguous: '附件关联不明确' }
  let day: string | null = null
  for (const message of snapshot.messages) {
    const nextDay = message.local_date ?? '时间未提供'
    if (nextDay !== day) { append(`\n## ${nextDay}\n`); day = nextDay }
    append(`\n**${message.local_time ?? '时间未提供'} · ${markdownText(message.sender_name ?? '发送人未提供')}**\n\n`)
    append(renderMessageBody(message.content) + '\n')
    for (const item of attachments.get(message.id) ?? []) append(`\n附件 ${item.ordinal + 1}：${labels[item.kind]}（未复制；未检查文件）。\n`)
  }
  const markdown = Buffer.from(parts.join(''), 'utf8')
  const metadata = {
    schema_version: 1, export_version: 'markdown-v1', exportedAt: snapshot.selection.captured_at,
    privateRadarVersion: appVersion, selection_digest: selectionDigest, ...projection,
    output_files: ['聊天.md', 'export.json'],
    markdown: { path: '聊天.md', bytes: markdown.length, sha256: sha256(markdown) }
  }
  const manifest = Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8')
  if (manifest.length > EXPORT_LIMITS.max_manifest_bytes || manifest.length + markdown.length > EXPORT_LIMITS.max_export_bytes) {
    throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', '导出元数据超过安全大小，未写入输出文件。')
  }
  return { markdown, manifest, selectionDigest, projection }
}
