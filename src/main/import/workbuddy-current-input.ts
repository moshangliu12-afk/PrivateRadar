import { parseWorkBuddyChatHistoryText, type WorkBuddyChatParseResult } from './workbuddy-chat-history'

/** 每项来自当前输入中一个 transcript 元素；正文已经按 XML 规则解码一次。 */
export interface WorkBuddyCurrentContextBlock {
  extracted_dir_path: string
  file: string
  message_count: number
  transcript: string
  first_sender?: string
  first_message_at?: string
  truncated?: boolean
}

export interface WorkBuddyLogicalAttachment extends WorkBuddyChatParseResult {
  extracted_dir_path: string
  file: string
  message_count: number
  first_sender?: string
  first_message_at?: string
  truncated: false
  /** 保留第一次出现的原始上下文正文；不以比较用文本替换来源。 */
  transcript: string
  context_indexes: number[]
}

export interface WorkBuddyCurrentInput {
  raw_context_count: number
  logical_attachments: WorkBuddyLogicalAttachment[]
}

type CurrentInputErrorCode = 'INVALID_CURRENT_CONTEXT' | 'INVALID_CURRENT_TRANSCRIPT' |
  'TRUNCATED_CURRENT_CONTEXT' | 'DUPLICATE_CONTEXT_CONFLICT' | 'LOGICAL_ATTACHMENT_COUNT_MISMATCH'

export class WorkBuddyCurrentInputError extends Error {
  constructor(
    readonly code: CurrentInputErrorCode,
    readonly contextIndex: number | null,
    detail: string,
    cause?: unknown
  ) {
    super(`${contextIndex === null ? '当前输入' : `当前输入第 ${contextIndex + 1} 个上下文`}：${detail}`, { cause })
    this.name = 'WorkBuddyCurrentInputError'
  }
}

interface ContextGroup {
  first: WorkBuddyCurrentContextBlock
  contexts: Array<{ block: WorkBuddyCurrentContextBlock; index: number }>
}

/** 只在本次调用内按精确路径归组，不查询目录，不按正文或文件哈希归组。 */
export function normalizeWorkBuddyCurrentInput(
  blocks: readonly WorkBuddyCurrentContextBlock[]
): WorkBuddyCurrentInput {
  if (!Array.isArray(blocks)) {
    throw new WorkBuddyCurrentInputError('INVALID_CURRENT_CONTEXT', null, '当前上下文必须是数组')
  }
  const groups = new Map<string, ContextGroup>()
  for (const [index, block] of blocks.entries()) {
    validateBlock(block, index)
    const group = groups.get(block.extracted_dir_path)
    if (group) {
      if (group.first.file !== block.file || group.first.message_count !== block.message_count ||
          group.first.first_sender !== block.first_sender ||
          group.first.first_message_at !== block.first_message_at ||
          (group.first.truncated ?? false) !== (block.truncated ?? false)) {
        throw new WorkBuddyCurrentInputError('DUPLICATE_CONTEXT_CONFLICT', index, '同一路径的附件元数据不一致')
      }
      group.contexts.push({ block, index })
    } else {
      groups.set(block.extracted_dir_path, { first: block, contexts: [{ block, index }] })
    }
  }

  // 先检查全部同路径元数据，使截断状态冲突不依赖副本的出现顺序。
  const attachments: WorkBuddyLogicalAttachment[] = []
  for (const group of groups.values()) {
    const firstIndex = group.contexts[0].index
    if (group.first.truncated) {
      throw new WorkBuddyCurrentInputError('TRUNCATED_CURRENT_CONTEXT', firstIndex, '聊天上下文已截断，停止处理')
    }
    let firstParsed: WorkBuddyChatParseResult | undefined
    let firstComparisonText: string | undefined
    for (const { block, index } of group.contexts) {
      const text = transportText(block.transcript)
      let parsed: WorkBuddyChatParseResult
      try {
        parsed = parseWorkBuddyChatHistoryText(text, { expectedMessageCount: block.message_count })
      } catch (error) {
        throw new WorkBuddyCurrentInputError(
          group.contexts.length > 1 ? 'DUPLICATE_CONTEXT_CONFLICT' : 'INVALID_CURRENT_TRANSCRIPT', index,
          '无法确认完整消息边界，不返回部分附件', error)
      }
      const firstMessage = parsed.messages[0]
      if ((block.first_sender !== undefined && block.first_sender !== firstMessage.sender_name) ||
          (block.first_message_at !== undefined && block.first_message_at !== firstMessage.source_time_text)) {
        throw new WorkBuddyCurrentInputError(
          group.contexts.length > 1 ? 'DUPLICATE_CONTEXT_CONFLICT' : 'INVALID_CURRENT_CONTEXT', index,
          '首条消息与当前卡片元数据不一致')
      }
      // 仅忽略文档末尾一个行终止符；多余空行仍是正文，不能用 trim 清除。
      const comparisonText = text.endsWith('\n') ? text.slice(0, -1) : text
      if (firstParsed) {
        if (firstComparisonText !== comparisonText || JSON.stringify(firstParsed) !== JSON.stringify(parsed)) {
          throw new WorkBuddyCurrentInputError('DUPLICATE_CONTEXT_CONFLICT', index, '同一路径的聊天正文或消息顺序不一致')
        }
      } else {
        firstParsed = parsed
        firstComparisonText = comparisonText
      }
    }
    attachments.push({
      ...firstParsed!,
      extracted_dir_path: group.first.extracted_dir_path,
      file: group.first.file,
      message_count: group.first.message_count,
      first_sender: group.first.first_sender,
      first_message_at: group.first.first_message_at,
      truncated: false,
      transcript: group.first.transcript,
      context_indexes: group.contexts.map(({ index }) => index)
    })
  }
  return { raw_context_count: blocks.length, logical_attachments: attachments }
}

/** 独立批量门禁：先归一化，再保持当前产品恰好两个附件的限制。 */
export function gateWorkBuddyBatchCurrentInput(
  blocks: readonly WorkBuddyCurrentContextBlock[]
): WorkBuddyCurrentInput {
  const result = normalizeWorkBuddyCurrentInput(blocks)
  if (result.logical_attachments.length !== 2) {
    throw new WorkBuddyCurrentInputError('LOGICAL_ATTACHMENT_COUNT_MISMATCH', null,
      `批量入口要求恰好两个独立附件，当前为 ${result.logical_attachments.length} 个`)
  }
  return result
}

function transportText(text: string): string {
  // 首个发送人行不能为空，开头的纯换行可确认为外层包裹；不移除空格、缩进或正文空行。
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/^\n+/, '')
}

function validateBlock(block: WorkBuddyCurrentContextBlock, index: number): void {
  if (!block || typeof block !== 'object' ||
      typeof block.extracted_dir_path !== 'string' || !block.extracted_dir_path.trim() ||
      typeof block.file !== 'string' || !block.file.trim() ||
      !Number.isInteger(block.message_count) || block.message_count < 1 ||
      typeof block.transcript !== 'string' ||
      (block.first_sender !== undefined && (typeof block.first_sender !== 'string' || !block.first_sender.trim())) ||
      (block.first_message_at !== undefined && (typeof block.first_message_at !== 'string' || !block.first_message_at.trim())) ||
      (block.truncated !== undefined && typeof block.truncated !== 'boolean')) {
    throw new WorkBuddyCurrentInputError('INVALID_CURRENT_CONTEXT', index, '缺少合法的当前卡片字段，不猜测路径或消息信息')
  }
}
