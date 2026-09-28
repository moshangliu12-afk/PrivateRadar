import type { WorkBuddyMessageInput } from '../integrations/workbuddy/validation'

const TIME_LINE = /^(\d{4})年(\d{1,2})月(\d{1,2})日 (\d{2}):(\d{2})$/
const TIME_ATTEMPT = /^(?:\d{4}年\d{1,2}月|\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]|$)|\d{1,2}:\d{1,2}(?:\s|$))/
const MAX_MESSAGES = 500

export interface WorkBuddyChatParseOptions {
  expectedMessageCount: number
}

export interface WorkBuddyParsedChatMessage extends WorkBuddyMessageInput {
  platform: 'wechat'
  sender_name: string
  sender_name_source: 'source_native'
  content: string
  content_source: 'source_native'
  timestamp: string
  timestamp_source: 'source_native'
  source_position: number
  source_time_text: string
}

export interface WorkBuddyChatParseResult {
  grammar_version: 1
  messages: WorkBuddyParsedChatMessage[]
  timezone_interpretation: {
    offset: '+08:00'
    source: 'system_interpretation'
    source_provided_timezone: false
    source_precision: 'minute'
  }
}

export class WorkBuddyChatParseError extends Error {
  constructor(readonly code: string, readonly lineNumber: number, detail: string) {
    super(`第 ${lineNumber} 行：${detail}`)
    this.name = 'WorkBuddyChatParseError'
  }
}

interface Header {
  senderLine: number
  bodyLine: number
  sender: string
  sourceTime: string
  timestamp: string
}

export function parseWorkBuddyChatHistoryText(
  text: string,
  options: WorkBuddyChatParseOptions
): WorkBuddyChatParseResult {
  if (!options || !Number.isInteger(options.expectedMessageCount) ||
      options.expectedMessageCount < 1 || options.expectedMessageCount > MAX_MESSAGES) {
    throw new WorkBuddyChatParseError('MESSAGE_COUNT_REQUIRED', 1, '必须提供当前卡片明确声明的消息数，范围为 1–500')
  }
  if (!text || text.includes('\u0000') || /\r(?!\n)/.test(text)) {
    throw new WorkBuddyChatParseError('INVALID_TEXT', 1, '文本为空或包含不支持的控制字符、换行格式')
  }
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const messages: WorkBuddyParsedChatMessage[] = []
  let header = readHeader(lines, 0)

  for (let index = header.bodyLine; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    const nextLine = lines[index + 1] ?? ''
    const afterSeparator = lines[index - 1] === ''
    const fullTime = TIME_LINE.test(nextLine)
    const markedSender = line.startsWith('·') || line === '-'

    if (afterSeparator && (fullTime || TIME_ATTEMPT.test(nextLine) || markedSender)) {
      const nextHeader = readHeader(lines, index)
      messages.push(messageFrom(lines, header, index - 1, messages.length))
      header = nextHeader
      index = header.bodyLine - 1
    } else if (markedSender && fullTime) {
      throw new WorkBuddyChatParseError('MISSING_SEPARATOR', index + 1, '消息头前缺少空行，不能将其合并到正文')
    }
  }
  messages.push(messageFrom(lines, header, lines.length, messages.length))
  if (messages.length !== options.expectedMessageCount) {
    throw new WorkBuddyChatParseError('MESSAGE_COUNT_MISMATCH', 1,
      `解析得到 ${messages.length} 条，当前卡片声明 ${options.expectedMessageCount} 条，消息边界无法确认`)
  }
  return {
    grammar_version: 1,
    messages,
    timezone_interpretation: {
      offset: '+08:00', source: 'system_interpretation',
      source_provided_timezone: false, source_precision: 'minute'
    }
  }
}

function readHeader(lines: string[], senderLine: number): Header {
  const sender = lines[senderLine] ?? ''
  if (!sender.trim() || TIME_LINE.test(sender) || TIME_ATTEMPT.test(sender)) {
    throw new WorkBuddyChatParseError('INVALID_SENDER', senderLine + 1, '缺少可确认的发送人行')
  }
  const sourceTime = lines[senderLine + 1] ?? ''
  const matched = sourceTime.match(TIME_LINE)
  if (!matched) {
    throw new WorkBuddyChatParseError('MISSING_OR_INVALID_TIME', senderLine + 2,
      '消息头缺少受支持的完整日期与 HH:mm，不补造时间')
  }
  const [, yearText, monthText, dayText, hourText, minuteText] = matched
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59) {
    throw new WorkBuddyChatParseError('INVALID_CALENDAR_TIME', senderLine + 2, '日期或时分范围不合法')
  }
  return {
    senderLine, bodyLine: senderLine + 2, sender, sourceTime,
    timestamp: `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')}T${hourText}:${minuteText}:00+08:00`
  }
}

function messageFrom(lines: string[], header: Header, bodyEnd: number, position: number): WorkBuddyParsedChatMessage {
  const content = lines.slice(header.bodyLine, bodyEnd).join('\n')
  if (!content.trim()) {
    throw new WorkBuddyChatParseError('MISSING_CONTENT', header.bodyLine + 1, '消息正文为空，停止解析')
  }
  return {
    platform: 'wechat', sender_name: header.sender, sender_name_source: 'source_native',
    content, content_source: 'source_native', timestamp: header.timestamp,
    timestamp_source: 'source_native', source_position: position, source_time_text: header.sourceTime
  }
}
