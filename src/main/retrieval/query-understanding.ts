import type { DatabaseSync } from 'node:sqlite'
import type { QueryDateRange, QueryUnderstanding } from '../../shared/models'
import { DEFAULT_DAILY_CONFIG } from '../intelligence/daily/config'
import { extractEntityKeys } from '../intelligence/daily/similarity'
import { rankSearchTerms, type RankedSearchTerm, type SearchTermSource } from './term-ranking'

interface NamedRow { id: string; name: string }
interface SenderRow { id: string; name: string }

export function understandQuery(db: DatabaseSync, question: string, anchorDate: string, originalQuery = question): QueryUnderstanding {
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
  const contentQuestion = stripParsedExplicitDates(question, dateRange)
  const strippedQuestion = stripQuestionShell(contentQuestion, [...matchedConversations, ...matchedSenders].map((item) => item.name))
  const entityKeys = extractQueryEntityKeys(contentQuestion)
  const hasQuestionShell = /[？?]|什么|哪些|怎么|如何|有没有|请问/.test(question)
  const isQuestion = strippedQuestion !== question || hasQuestionShell
    || timeIntent !== 'none'
  const { primary, expansion } = generateTermSources(strippedQuestion, entityKeys, dateRange, hasQuestionShell)
  const ranked = rankSearchTerms(originalQuery, [
    ...primary.map((source) => ({ ...source, primary: true })),
    ...expansion.sources
  ])
  const primaryTexts = new Set(primary.map((source) => source.text))
  const expandedTexts = new Set(expansion.sources.map((source) => source.text))
  const searchTerms = ranked.filter((term) => primaryTexts.has(term.text)).map((term) => term.text)
  return {
    intent: /怎么看|怎么样|如何评价|评价|看法|观点|反馈如何|体验如何|大家认为/.test(question) ? 'summarize' : 'find',
    sort: /最早|第一次|首次/.test(question) ? 'oldest' : 'relevance',
    dateRange,
    timeIntent,
    personIntent,
    isNaturalLanguage: isQuestion
      || expansion.eventTerms.length > 0 || expansion.coreTopics.includes('消防安全') || expansion.coreTopics.includes('故障'),
    conversationIds: matchedConversations.map((item) => item.id),
    conversationNames: matchedConversations.map((item) => item.name),
    senderIds: matchedSenders.map((item) => item.id),
    senderNames: matchedSenders.map((item) => item.name),
    entityKeys,
    coreTopics: expansion.coreTopics,
    eventTerms: expansion.eventTerms,
    expandedTerms: ranked.filter((term) => expandedTexts.has(term.text)).map((term) => term.text),
    searchTerms
  }
}

// 只复用已有纯生成阶段，不查询数据库，也不替换调用者提供的词集合。
export function planSearchTerms(question: string, understanding: QueryUnderstanding, originalQuery = question): RankedSearchTerm[] {
  const content = stripParsedExplicitDates(question, understanding.dateRange)
  const stripped = stripQuestionShell(content, [...understanding.conversationNames, ...understanding.senderNames])
  const generated = generateTermSources(stripped, understanding.entityKeys, understanding.dateRange,
    /[？?]|什么|哪些|怎么|如何|有没有|请问/.test(question))
  const primary = new Set(understanding.searchTerms)
  const actual = new Set([...understanding.searchTerms, ...understanding.expandedTerms])
  const sources = [...generated.primary, ...generated.expansion.sources]
    .filter((source) => actual.has(source.text))
    .map((source) => ({ ...source, primary: primary.has(source.text) }))
  // 人工构造的历史错误规划缺少可靠生成依据，保守归为普通词。
  for (const text of actual) sources.push({ text, kind: 'word', primary: primary.has(text) })
  return rankSearchTerms(originalQuery, sources)
}

function generateTermSources(question: string, entityKeys: string[], dateRange: QueryDateRange, hasQuestionShell: boolean) {
  const explicit = extractSearchTerms(question, entityKeys, [], [])
  const fallback = explicit.length === 0 && hasQuestionShell ? segmentNaturalLanguageFallback(question, dateRange) : undefined
  const literal = question.replace(/[？?!！。]+$/g, '').trim()
  const primary: SearchTermSource[] = fallback ?? (explicit.length > 0 ? explicit
    : literal.length >= 2 && /[\p{L}\p{N}]/u.test(literal) ? [{ text: literal, kind: 'complete' }] : [])
  return { primary, expansion: expandQuery(question, entityKeys, fallback) }
}

// 只给已经存在的固定查询对象标注类型，不生成新词或推断新短语。
const completeQueryObjects = new Set(['Claude Code', '公众号排版', '微信小程序', 'Ollama', '知识库检索'])
function termSource(text: string, kind: SearchTermSource['kind'] = 'word'): SearchTermSource {
  return { text, kind: completeQueryObjects.has(text) ? 'complete' : kind }
}

export function parseDateRange(question: string, anchorDate: string): QueryDateRange {
  const compactQuestion = question.replace(/\s+/g, '')
  const explicit = matchExplicitDates(question).map((match) => match.date)
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
  if (/前天/.test(compactQuestion)) {
    const dayBeforeYesterday = shiftDays(anchorDate, -2)
    return { label: '前天', start: dayBeforeYesterday, end: dayBeforeYesterday }
  }
  if (/今天/.test(compactQuestion)) return { label: '今天', start: anchorDate, end: anchorDate }
  if (/最近|近期/.test(compactQuestion)) return { label: '最近30天', start: shiftDays(anchorDate, -29), end: anchorDate }
  return { label: '全部时间', start: null, end: anchorDate }
}

function matchExplicitDates(question: string): Array<{ start: number; end: number; date: string }> {
  // 沿用原语法；单日期或范围只消费前两个匹配，后续文本不能顺带清理。
  return [...question.matchAll(/(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})日?/g)].slice(0, 2)
    .map((match) => ({
      start: match.index!, end: match.index! + match[0].length,
      date: formatDate(Number(match[1]), Number(match[2]), Number(match[3]))
    }))
}

function stripParsedExplicitDates(question: string, dateRange: QueryDateRange): string {
  const matches = matchExplicitDates(question)
  if (matches.length === 0 || matches[0].date !== dateRange.start || matches.at(-1)!.date !== dateRange.end) return question
  let spans = matches.map(({ start, end }) => ({ start, end }))
  if (matches.length === 2 && /^\s*(?:至|到|和|与|以及|及|[-~～—–,，、])?\s*$/u.test(question.slice(matches[0].end, matches[1].start))) {
    // 只清理两个已消费日期之间的范围连接符；中间业务内容必须保留。
    spans = [{ start: matches[0].start, end: matches[1].end }]
  }
  let content = question
  for (const { start, end } of spans.reverse()) content = content.slice(0, start) + ' ' + content.slice(end)
  return content
}

function extractSearchTerms(question: string, entityKeys: string[], conversationNames: string[], senderNames: string[]): SearchTermSource[] {
  const terms: SearchTermSource[] = []
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
    for (const term of expansions[key] ?? []) terms.push(termSource(term))
    if (key.startsWith('github:')) terms.push(termSource(key.slice('github:'.length), 'complete'))
    if (key.startsWith('product:')) terms.push(termSource(key.slice('product:'.length), 'complete'))
  }
  for (const match of contentQuestion.match(/[A-Za-z][A-Za-z0-9_.\/-]*(?:\s+[A-Za-z][A-Za-z0-9_.-]*)?/g) ?? []) {
    if (!['github'].includes(match.toLowerCase()) || /github/i.test(contentQuestion)) {
      terms.push(termSource(match.trim(), /\s/.test(match.trim()) ? 'complete' : 'word'))
    }
  }
  const dictionary = [
    '公众号', '排版', '美化', '微信小程序', '小程序', 'GitHub', '开源', 'Markdown',
    'Claude', 'DataNest', 'Ollama', 'NovaFlow', 'MeshNote', 'LocalLens', '报告', '漏洞',
    '增量同步', '敏感资料', '本地', '重新扫描', '扫描', '文件', '编程代理', '长任务',
    '聊天索引', '数据库', '工具', '项目'
  ]
  for (const term of dictionary) if (contentQuestion.toLowerCase().includes(term.toLowerCase())) terms.push(termSource(term))
  for (const version of contentQuestion.match(/\bv?\d+(?:\.\d+){1,3}\b/gi) ?? []) terms.push(termSource(version))
  return terms.filter((term) => term.text.length >= 2 && !names.includes(term.text))
}

const MAX_FALLBACK_TERMS = 8
const fallbackFunctionWords = new Set([
  '关于', '有关', '和', '与', '以及', '及', '的', '了', '什么', '哪些', '是',
  '吗', '呀', '呢', '谁', '大家', '到', '从', '有', '在', '里', '中',
  '怎么', '如何', '请问', '有没有'
])
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })

function segmentNaturalLanguageFallback(question: string, dateRange: QueryDateRange): SearchTermSource[] {
  let content = question.replace(/(?:聊|说|讨论|提到)(?:了|过)?(?:什么|哪些)|怎么(?:说|看)|有没有|请问/gu, ' ')
  if (dateRange.label !== '全部时间') {
    content = content
      .replace(/最近\s*(?:\d+\s*天|三个月|一个月)|今天|昨天|前天|本周|这周|上周|本月|这个月|上个月|近期|最近/gu, ' ')
  }
  const words: string[] = []
  const compounds: string[] = []
  let run: string[] = []
  const flush = (): void => {
    const units: string[] = []
    for (let index = 0; index < run.length;) {
      if (run[index].length >= 2) { units.push(run[index++]); continue }
      let singles = ''
      while (index < run.length && run[index].length === 1) singles += run[index++]
      // 单字连续片段合并；孤立尾字接前词、孤立首字接后词，避免专名被截断。
      if (singles.length >= 2) units.push(singles)
      else if (units.length > 0) units[units.length - 1] += singles
      else if (index < run.length) units.push(singles + run[index++])
    }
    words.push(...units)
    // 同一连续内容片段的相邻词组成有限复合词，同时保留组成词用于 OR 召回。
    for (let index = 1; index < units.length; index += 1) {
      const compound = units[index - 1] + units[index]
      if (compound.length <= 8) compounds.push(compound)
    }
    run = []
  }
  for (const item of wordSegmenter.segment(content)) {
    if (!item.isWordLike || fallbackFunctionWords.has(item.segment)) { flush(); continue }
    if (/^\p{Script=Han}+$/u.test(item.segment)) run.push(item.segment)
    else {
      flush()
      if (item.segment.length >= 2 && /[\p{L}\p{N}]/u.test(item.segment)) words.push(item.segment)
    }
  }
  flush()
  // 优先保留独立内容词，并为更具体的复合词保留两个名额；不回退为整句问句。
  const selected = new Set([...new Set([...words.slice(0, MAX_FALLBACK_TERMS - 2), ...compounds, ...words])]
    .slice(0, MAX_FALLBACK_TERMS))
  return [...words.map((text) => termSource(text)), ...compounds.map((text) => termSource(text, 'compound'))]
    .filter((source) => selected.has(source.text))
}

function stripQuestionShell(question: string, knownNames: string[]): string {
  let value = knownNames.filter(isUsableName).reduce((current, name) => current.replaceAll(name, ' '), question)
    .replace(/^\s*(最近|近期|之前|以前|今天|昨天|前天|本周|上周|本月|上个月|最近\s*\d+\s*天)?\s*/u, '')
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

function expandQuery(question: string, entityKeys: string[], fallbackTerms?: SearchTermSource[]): { coreTopics: string[]; eventTerms: string[]; sources: SearchTermSource[] } {
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

  const literals = fallbackTerms?.map((source) => source.text) ?? [question.replace(/[？?!！。]+$/g, '').trim()]
  for (const literal of literals) {
    if (literal.length >= 2 && /[\p{L}\p{N}]/u.test(literal)) {
      coreTopics.add(literal)
      terms.add(literal)
    }
  }
  for (const key of entityKeys) {
    if (key.startsWith('product:')) terms.add(key.slice('product:'.length))
    if (key.startsWith('github:')) terms.add(key.slice('github:'.length))
  }
  return {
    coreTopics: [...coreTopics].sort(),
    eventTerms: [...eventTerms].sort(),
    sources: [
      ...[...terms].filter((term) => term.length >= 2).map((term) => termSource(term)),
      ...(fallbackTerms ?? []),
      ...entityKeys.filter((key) => key.startsWith('product:') || key.startsWith('github:'))
        .map((key) => termSource(key.slice(key.indexOf(':') + 1), 'complete'))
    ]
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
  if (typeof value !== 'string') return false
  const name = value.trim()
  return name.length > 0 && /[\p{L}\p{N}]/u.test(name)
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
