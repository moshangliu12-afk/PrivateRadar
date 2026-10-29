import type { CanonicalExportSnapshot } from '../../shared/markdown-export'
import { EXPORT_LIMITS } from '../../shared/markdown-export'
import { ExportSelectionError } from './chat-selection'

/** 纯文本结构；原文中的 Markdown 字符属于用户内容，不转义或改写。 */
export function renderChatTxt(snapshot: CanonicalExportSnapshot): Buffer {
  const parts: string[] = []
  let bytes = 0
  const append = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > EXPORT_LIMITS.max_markdown_bytes) throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', 'TXT 超过安全大小，未写入输出文件。')
    parts.push(text)
  }
  const headerName = snapshot.conversation.displayConversationName.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
  append(`会话：${headerName}\n导出时间：${snapshot.selection.captured_at}\n消息数量：${snapshot.messages.length}\n时区：${snapshot.selection.timezone}\n`)
  const range = snapshot.selection.range
  append(`范围：${range.type === 'conversation' ? '完整会话（包含未知时间消息）' : `${range.start_date} 至 ${range.end_date}`}\n`)
  append('附件未复制；来源证据仅引用登记信息，未重新验证。\n')
  if (snapshot.selection.excluded_unknown_time_count) append(`此范围排除 ${snapshot.selection.excluded_unknown_time_count} 条未知时间消息。\n`)
  const attachments = new Map<string, typeof snapshot.attachments[number][]>()
  for (const item of snapshot.attachments) {
    const values = attachments.get(item.message_id) ?? []
    values.push(item); attachments.set(item.message_id, values)
  }
  const labels = { image: '图片', video: '视频', audio: '语音', file: '文件', unknown: '附件', missing: '附件登记缺失', ambiguous: '附件关联不明确' }
  let day: string | null = null
  for (const message of snapshot.messages) {
    const nextDay = message.local_date ?? '时间未提供'
    if (day !== nextDay) { append(`\n====================\n${nextDay}\n====================\n`); day = nextDay }
    const sender = (message.sender_name ?? '发送人未提供').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    append(`\n${message.local_time ?? '时间未提供'} · ${sender}\n${message.content}\n`)
    if (!message.content.trim()) append('[空白消息]\n')
    for (const item of attachments.get(message.id) ?? []) append(`[${labels[item.kind]}，未复制]\n`)
  }
  return Buffer.from(parts.join(''), 'utf8')
}
