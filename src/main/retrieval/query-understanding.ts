import type { DatabaseSync } from 'node:sqlite'
import type { QueryDateRange, QueryUnderstanding } from '../../shared/models'
import { DEFAULT_DAILY_CONFIG } from '../intelligence/daily/config'
import { extractEntityKeys } from '../intelligence/daily/similarity'

interface NamedRow { id: string; name: string }
interface SenderRow { id: string; name: string }

export function understandQuery(db: DatabaseSync, question: string, anchorDate: string): QueryUnderstanding {
  const conversations = db.prepare('SELECT id, name FROM conversations ORDER BY length(name) DESC, name').all() as unknown as NamedRow[]
  const senders = db.prepare(`
    SELECT sender_id AS id, MAX(sender_name) AS name
    FROM messages
    WHERE sender_name_source IN ('source_native', 'user_supplied')
      AND sender_name IS NOT NULL AND sender_name <> ''
    GROUP BY sender_id
    ORDER BY length(name) DESC, name
  `).all() as unknown as SenderRow[]
  const matchedConversations = conversations.filter((item) => matchesConversation(question, item.name))
  const matchedSenders = senders.filter((item) => isUsableName(item.name) && question.includes(item.name))
  const dateRange = parseDateRange(question, anchorDate)
  const timeIntent = inferTimeIntent(question, dateRange)
  const personIntent = /谁在|谁提到|谁发|谁分享|谁推荐|哪个人|哪位/.test(question) ? 'who' : 'none'
  const strippedQuestion = stripQuestionShell(question, [...matchedConversations, ...matchedSenders].map((item) => item.name))
  const entityKeys = extractQueryEntityKeys(question)
  const expansion = expandQuery(strippedQuestion, entityKeys)
  return {
    intent: /怎么看|怎么样|如何评价|评价|看法|观点|反馈如何|体验如何|大家认为/.test(question) ? 'summarize' : 'find',
    sort: /最早|第一次|首次/.test(question) ? 'oldest' : 'relevance',
    dateRange,
    timeIntent,
    personIntent,
    isNaturalLanguage: strippedQuestion !== question || /[？?]/.test(question) || timeIntent !== 'none'
      || expansion.eventTerms.length > 0 || expansion.coreTopics.includes('消防安全') || expansion.coreTopics.includes('故障'),
    conversationIds: matchedConversations.map((item) => item.id),
    conversationNames: matchedConversations.map((item) => item.name),
    senderIds: matchedSenders.map((item) => item.id),
    senderNames: matchedSenders.map((item) => item.name),
    entityKeys,
    coreTopics: expansion.coreTopics,
    eventTerms: expansion.eventTerms,
    expandedTerms: expansion.terms,
    searchTerms: extractSearchTerms(strippedQuestion, entityKeys, [], [])
  }
}

export function parseDateRange(question: string, anchorDate: string): QueryDateRange {
  const compactQuestion = question.replace(/\s+/g, '')
  const explicit = [...question.matchAll(/(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})日?/g)]
    .map((match) => formatDate(Number(match[1]), Number(match[2]), Number(match[3])))
  if (explicit.length >= 2) return { label: `${explicit[0]} 至 ${explicit[1]}`, start: explicit[0], end: explicit[1] }
  if (explicit.length === 1) return { label: explicit[0], start: explicit[0], end: explicit[0] }

  if (/最近三个月|近三个月/.test(compactQuestion)) return { label: '最近三个月', start: shiftMonths(anchorDate, -3), end: anchorDate }
  if (/最近30天|近30天|最近一个月|近一个月/.test(compactQuestion)) return { label: '最近30天', start: shiftDays(anchorDate, -29), end: anchorDate }
  if (/最近7天|近7天/.test(compactQuestion)) return { label: '最近7天', start: shiftDays(anchorDate, -6), end: anchorDate }
  if (/上个月/.test(compactQuestion)) {
    const current = toDate(anchorDate)
    const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1, 12))
    const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0, 12))
    return { label: '上个月', start: isoDate(start), end: isoDate(end) }
  }
  if (/本月|这个月/.test(compactQuestion)) return { label: '本月', start: `${anchorDate.slice(0, 7)}-01`, end: anchorDate }
  if (/上周/.test(compactQuestion)) {
    const thisMonday = mondayOf(anchorDate)
    return { label: '上周', start: shiftDays(thisMonday, -7), end: shiftDays(thisMonday, -1) }
  }
  if (/本周|这周/.test(compactQuestion)) return { label: '本周', start: mondayOf(anchorDate), end: anchorDate }
  if (/昨天/.test(compactQuestion)) {
    const yesterday = shiftDays(anchorDate, -1)
    return { label: '昨天', start: yesterday, end: yesterday }
  }
  if (/今天/.test(compactQuestion)) return { label: '今天', start: anchorDate, end: anchorDate }
  if (/最近|近期/.test(compactQuestion)) return { label: '最近30天', start: shiftDays(anchorDate, -29), end: anchorDate }
  return { label: '全部时间', start: null, end: anchorDate }
}

function extractSearchTerms(question: string, entityKeys: string[], conversationNames: string[], senderNames: string[]): string[] {
  const terms = new Set<string>()
  const names = [...conversationNames, ...senderNames].filter(isUsableName)
  const contentQuestion = names.reduce((value, name) => value.replaceAll(name, ' '), question)
  const expansions: Record<string, string[]> = {
    'claude-code': ['Claude Code', 'Claude', 'Anthropic coding agent'],
    'wechat-layout': ['公众号排版', '公众号', 'Markdown'],
    'wechat-miniprogram': ['微信小程序', '小程序', 'GitHub'],
    ollama: ['Ollama'],
    'hybrid-search': ['知识库检索', '全文搜索', '语义检索']
  }
  for (const key of entityKeys) {
    for (const term of expansions[key] ?? []) terms.add(term)
    if (key.startsWith('github:')) terms.add(key.slice('github:'.length))
    if (key.startsWith('product:')) terms.add(key.slice('product:'.length))
  }
  for (const match of contentQuestion.match(/[A-Za-z][A-Za-z0-9_.\/-]*(?:\s+[A-Za-z][A-Za-z0-9_.-]*)?/g) ?? []) {
    if (!['github'].includes(match.toLowerCase()) || /github/i.test(contentQuestion)) terms.add(match.trim())
  }
  const dictionary = [
    '公众号', '排版', '美化', '微信小程序', '小程序', 'GitHub', '开源', 'Markdown',
    'Claude', 'DataNest', 'Ollama', 'NovaFlow', 'MeshNote', 'LocalLens', '报告', '漏洞',
    '增量同步', '敏感资料', '本地', '重新扫描', '扫描', '文件', '编程代理', '长任务',
    '聊天索引', '数据库', '工具', '项目'
  ]
  for (const term of dictionary) if (contentQuestion.toLowerCase().includes(term.toLowerCase())) terms.add(term)
  for (const version of contentQuestion.match(/\bv?\d+(?:\.\d+){1,3}\b/gi) ?? []) terms.add(version)
  for (const name of names) terms.delete(name)
  if (terms.size === 0) {
    const literal = contentQuestion.replace(/[？?!！。]+$/g, '').trim()
    if (literal.length >= 2) terms.add(literal)
  }
  return [...terms].filter((term) => term.length >= 2).sort((left, right) => right.length - left.length || left.localeCompare(right))
}

function stripQuestionShell(question: string, knownNames: string[]): string {
  let value = knownNames.filter(isUsableName).reduce((current, name) => current.replaceAll(name, ' '), question)
    .replace(/^\s*(最近|近期|之前|以前|今天|昨天|本周|上周|本月|上个月|最近\s*\d+\s*天)?\s*/u, '')
    .replace(/^\s*(谁在找|谁提到过|谁提到|谁发过|谁发|谁分享过|谁分享|谁推荐过|谁推荐|有没有人讨论|大家有没有讨论|最近有人提到什么|有人提到什么|哪个群说过|我之前看过)\s*/u, '')
    .replace(/[？?！!。]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

  value = value
    .replace(/^(?:什么|哪些|有关|关于)?\s*/u, '')
    .replace(/(?:吗|呀|呢)$/u, '')
    .trim()
  return value || question.trim()
}

function expandQuery(question: string, entityKeys: string[]): { coreTopics: string[]; eventTerms: string[]; terms: string[] } {
  const terms = new Set<string>()
  const coreTopics = new Set<string>()
  const eventTerms = new Set<string>()
  const compact = question.replace(/\s+/g, '')

  const addTopic = (topic: string, values: string[]): void => {
    coreTopics.add(topic)
    values.forEach((value) => terms.add(value))
  }
  const addEvent = (values: string[]): void => {
    values.forEach((value) => {
      eventTerms.add(value)
      terms.add(value)
    })
  }

  if (/消防安全|消防|火灾|消防通道|疏散通道/.test(compact)) {
    addTopic('消防安全', ['消防安全', '消防', '火灾', '消防通道', '疏散通道', '楼道', '安全隐患'])
  }
  if (/游戏币.{0,6}货源|货源.{0,6}游戏币/.test(compact)) {
    addTopic('游戏币货源', ['游戏币货源', '游戏币', '货源'])
  }
  const hasSpecificConstraint = /重新扫描|全部文件|文件|敏感资料|长任务|本地/.test(compact)
  if (/工具.{0,6}(更新|发布|上线|新功能|新版本|升级|推出)|(?:更新|发布|上线|新功能|新版本|升级|推出).{0,6}工具/.test(compact) && !hasSpecificConstraint) {
    addTopic('工具更新', ['工具', '产品', '软件'])
    addEvent(['更新', '发布', '上线', '新功能', '新版本', '升级', '推出', 'release'])
  } else if (/(更新|发布|上线|新功能|新版本|升级|推出|release)/i.test(compact) && !hasSpecificConstraint) {
    addEvent(['更新', '发布', '上线', '新功能', '新版本', '升级', '推出', 'release'])
  }
  if (/(故障|连不上|异常|不可用|失败|崩溃)/.test(compact)) {
    addTopic('故障', ['故障', '连不上', '异常', '不可用', '失败', '崩溃'])
  }

  const literal = question.replace(/[？?!！。]+$/g, '').trim()
  if (literal.length >= 2) {
    coreTopics.add(literal)
    terms.add(literal)
  }
  for (const key of entityKeys) {
    if (key.startsWith('product:')) terms.add(key.slice('product:'.length))
    if (key.startsWith('github:')) terms.add(key.slice('github:'.length))
  }
  return {
    coreTopics: [...coreTopics].sort(),
    eventTerms: [...eventTerms].sort(),
    terms: [...terms].filter((term) => term.length >= 2).sort((left, right) => right.length - left.length || left.localeCompare(right))
  }
}

function inferTimeIntent(question: string, dateRange: QueryDateRange): QueryUnderstanding['timeIntent'] {
  if (dateRange.label === '全部时间') return 'none'
  return /最近|近期/.test(question) ? 'recent' : 'strict'
}

function extractQueryEntityKeys(question: string): string[] {
  const keys = extractEntityKeys(question, DEFAULT_DAILY_CONFIG)
  if (/github/i.test(question)) {
    for (const match of question.matchAll(/\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/g)) {
      keys.add(`github:${match[1].toLowerCase()}/${match[2].toLowerCase()}`)
    }
  }
  return [...keys].sort()
}

function isUsableName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function matchesConversation(question: string, name: unknown): boolean {
  if (!isUsableName(name)) return false
  if (question.includes(name)) return true
  const groupHint = question.match(/([A-Za-z\p{Script=Han}]{1,12})\s*群/u)?.[1]
  if (!groupHint) return false
  return groupHint.length >= 2 && name.toLowerCase().includes(groupHint.toLowerCase())
}

function mondayOf(date: string): string {
  const value = toDate(date)
  const day = value.getUTCDay() || 7
  value.setUTCDate(value.getUTCDate() - day + 1)
  return isoDate(value)
}

function shiftDays(date: string, days: number): string {
  const value = toDate(date)
  value.setUTCDate(value.getUTCDate() + days)
  return isoDate(value)
}

function shiftMonths(date: string, months: number): string {
  const value = toDate(date)
  value.setUTCMonth(value.getUTCMonth() + months)
  return isoDate(value)
}

function toDate(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`)
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
