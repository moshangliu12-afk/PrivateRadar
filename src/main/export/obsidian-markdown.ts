import type { CanonicalExportMessage, CanonicalExportSnapshot } from '../../shared/markdown-export'
import { EXPORT_LIMITS } from '../../shared/markdown-export'
import { canonicalJson, markdownText, renderMessageBody, sha256 } from './chat-markdown'
import { ExportSelectionError } from './chat-selection'

export const VAULT_EXPORT_VERSION = 'obsidian-v1'
export interface ObsidianDay { date: string | null; messages: readonly CanonicalExportMessage[] }

/** 只使用双引号字符串、空值和整数；不解释外部输入为 YAML 语法。 */
export function yamlScalar(value: string | number | null): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('无效的元数据整数')
    return String(value)
  }
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g,
    character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
}
export function groupObsidianDays(snapshot: CanonicalExportSnapshot): ObsidianDay[] {
  const groups = new Map<string | null, CanonicalExportMessage[]>()
  for (const message of snapshot.messages) {
    const messages = groups.get(message.local_date) ?? []
    messages.push(message); groups.set(message.local_date, messages)
  }
  return [...groups].map(([date, messages]) => ({ date, messages }))
}
export function obsidianSourceDigest(snapshot: CanonicalExportSnapshot, day: ObsidianDay): string {
  return sha256(canonicalJson({
    version: VAULT_EXPORT_VERSION, conversation: snapshot.conversation, date: day.date,
    timezone: snapshot.selection.timezone,
    messages: day.messages.map(({ content, ...message }) => ({
      ...message, content_sha256: sha256(content), content_bytes: Buffer.byteLength(content, 'utf8')
    }))
  }))
}
export function renderObsidianMarkdown(snapshot: CanonicalExportSnapshot, day: ObsidianDay, attachmentCounts?: ReadonlyMap<string, number>): Buffer {
  const names = snapshot.conversation
  const frontmatter = {
    type: 'privateradar-chat', conversation: names.displayConversationName,
    source_conversation: names.sourceConversationName, user_conversation_label: names.userConversationLabel,
    conversation_id: names.id, platform: names.platform, date: day.date,
    message_count: day.messages.length, timezone: snapshot.selection.timezone,
    exported_at: snapshot.selection.captured_at
  }
  const parts = ['---\n', ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${yamlScalar(value)}\n`),
    '---\n\n', `# ${markdownText(names.displayConversationName)}\n\n## ${day.date ?? '时间未提供'}\n`]
  const attachments = new Map<string, number>()
  if (!attachmentCounts) for (const entry of snapshot.attachments) attachments.set(entry.message_id, (attachments.get(entry.message_id) ?? 0) + 1)
  const counts = attachmentCounts ?? attachments
  for (const message of day.messages) {
    parts.push(`\n**${message.local_time ?? '时间未提供'} · ${markdownText(message.sender_name ?? '发送人未提供')}**\n\n`,
      renderMessageBody(message.content), '\n')
    if (counts.has(message.id)) parts.push(`\n附件：${counts.get(message.id)} 项（未复制；未检查文件）。\n`)
  }
  const bytes = Buffer.from(parts.join(''), 'utf8')
  if (bytes.length > EXPORT_LIMITS.max_markdown_bytes) throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', '日期文件超过安全大小，请缩小导出范围。')
  return bytes
}
