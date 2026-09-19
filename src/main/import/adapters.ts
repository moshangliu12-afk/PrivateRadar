export type FileType = 'JSON' | 'CSV' | 'TXT'

export interface ParsedRow {
  value: unknown
  location: string
}

export interface ParseOutput {
  rows: ParsedRow[]
  errors: string[]
  totalCount: number
}

export function fileTypeFromName(fileName: string): FileType {
  const extension = fileName.toLowerCase().split('.').pop()
  if (extension === 'json') return 'JSON'
  if (extension === 'csv') return 'CSV'
  if (extension === 'txt') return 'TXT'
  throw new Error('仅支持 JSON、CSV 和 TXT 文件')
}

export function parseByFileType(type: FileType, content: string): ParseOutput {
  if (type === 'JSON') return parseJson(content)
  if (type === 'CSV') return parseCsv(content)
  return parseTxt(content)
}

function parseJson(content: string): ParseOutput {
  let root: unknown
  try {
    root = JSON.parse(content.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('JSON 文件语法错误，无法读取')
  }
  const values = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.messages)
      ? root.messages
      : null
  if (!values) throw new Error('JSON 顶层必须是数组，或包含 messages 数组')
  return {
    rows: values.map((value, index) => ({ value, location: `第 ${index + 1} 条` })),
    errors: [],
    totalCount: values.length
  }
}

function parseCsv(content: string): ParseOutput {
  const records = parseDelimited(content.replace(/^\uFEFF/, ''), ',')
  if (records.length === 0) throw new Error('CSV 文件为空')
  const headers = records[0].map((header) => header.trim())
  if (headers.every((header) => header === '')) throw new Error('CSV 缺少表头')
  const rows = records.slice(1)
    .filter((record) => record.some((cell) => cell.trim() !== ''))
    .map((record, index) => ({
      value: Object.fromEntries(headers.map((header, column) => [header, record[column] ?? ''])),
      location: `第 ${index + 2} 行`
    }))
  return { rows, errors: [], totalCount: rows.length }
}

function parseTxt(content: string): ParseOutput {
  const rows: ParsedRow[] = []
  const errors: string[] = []
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  let totalCount = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line || line.startsWith('#')) continue
    if (/^timestamp\tconversation_(?:name|id)\t/i.test(line)) continue
    totalCount += 1
    const tabParts = line.split('\t')
    if (tabParts.length >= 4) {
      const [timestamp, conversationName, senderName, ...rest] = tabParts
      const messageId = rest.length > 1 ? rest.pop() : undefined
      rows.push({
        value: { timestamp, conversation_name: conversationName, sender_name: senderName, content: rest.join('\t'), message_id: messageId },
        location: `第 ${index + 1} 行`
      })
      continue
    }
    const readable = line.match(/^\[([^\]]+)]\s*([^|]+?)\s*\|\s*([^:：]+?)\s*[:：]\s*(.+)$/)
    if (readable) {
      rows.push({
        value: { timestamp: readable[1], conversation_name: readable[2], sender_name: readable[3], content: readable[4] },
        location: `第 ${index + 1} 行`
      })
    } else {
      errors.push(`第 ${index + 1} 行：不符合 TXT 格式`)
    }
  }
  return { rows, errors, totalCount }
}

function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === delimiter) {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号')
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
