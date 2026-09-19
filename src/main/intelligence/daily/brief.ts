import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  DailyBriefItem,
  DailyBriefTelemetry,
  DailyCandidate,
  DailyCategory,
  DailyReasonCode,
  ImportanceLevel
} from '../../../shared/models'
import type { AIProvider } from '../../ai/provider'
import { DAILY_VALUE_VERSION, rankFinalDailyCandidates, type ValuedDailyCandidate } from './daily-value'

const MAX_AI_CANDIDATES = 30
const MAX_FINAL_ITEMS = 10
const MAX_EVIDENCE_PER_CANDIDATE = 4
const MAX_EVIDENCE_TEXT_LENGTH = 360
const MAX_ATTEMPTS = 2
const DAILY_BRIEF_VERSION = `daily-brief-v2-${DAILY_VALUE_VERSION}`
const CATEGORIES: DailyCategory[] = ['产品 / 技术', '行业 / 事件', '资源 / 工具', '机会 / 需求', '其他']
const LEVELS: ImportanceLevel[] = ['high', 'medium', 'low']

export interface DailyBriefResult {
  mode: 'rule' | 'ai'
  items: DailyBriefItem[]
  notice: string | null
  telemetry: DailyBriefTelemetry | null
}

export interface DailyAIInput {
  brief_date: string
  candidates: Array<{
    candidate_id: string
    title: string
    representative_text: string
    importance_score: number
    reason_codes: DailyReasonCode[]
    conversation_count: number
    message_count: number
    first_seen_at: string
    last_seen_at: string
    evidence: Array<{
      message_id: string
      conversation_name: string
      sender_name: string
      timestamp: string
      content: string
    }>
  }>
}

interface ParsedAIItem {
  candidateId: string
  title: string
  summary: string
  whyItMatters: string
  category: DailyCategory
  importanceLevel: ImportanceLevel
}

interface CacheRow {
  result_json: string
  candidate_count: number
  evidence_message_count: number
}

interface EvidenceRow {
  id: string
  conversation_id: string
  conversation_name: string
  sender_id: string
  sender_name: string
  sender_name_source: string
  timestamp: string
  content: string
}

export async function buildDailyBrief(
  db: DatabaseSync,
  date: string,
  allCandidates: DailyCandidate[],
  provider: AIProvider | null,
  forceRegenerate = false
): Promise<DailyBriefResult> {
  const candidates = rankFinalDailyCandidates(allCandidates).slice(0, MAX_AI_CANDIDATES)
  if (!provider) {
    return {
      mode: 'rule',
      items: candidates.slice(0, MAX_FINAL_ITEMS).map(toRuleItem),
      notice: '未配置 AI，当前使用规则模式。',
      telemetry: null
    }
  }

  const rawCandidates = candidates.map((item) => item.candidate)
  const input = buildAIInput(db, date, rawCandidates)
  const candidateSetHash = hashFinalCandidateSet(candidates)
  const evidenceMessageCount = input.candidates.reduce((sum, candidate) => sum + candidate.evidence.length, 0)
  const telemetryBase = {
    provider: provider.id,
    model: provider.model,
    candidateCount: candidates.length,
    evidenceMessageCount
  }
  const cached = forceRegenerate ? null : findCachedBrief(db, date, provider, candidateSetHash)
  if (cached) {
    try {
      const items = parseCachedItems(cached.result_json, candidates)
      return { mode: 'ai', items: items.slice(0, MAX_FINAL_ITEMS), notice: null, telemetry: { ...telemetryBase, cacheHit: true } }
    } catch {
      // 缓存结构损坏时继续重新生成，不让页面失效。
    }
  }

  const runId = randomUUID()
  const startedAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO analysis_runs (id, run_type, status, started_at, input_message_count, metadata_json)
    VALUES (?, 'daily-ai-brief', 'running', ?, ?, ?)
  `).run(runId, startedAt, evidenceMessageCount, JSON.stringify({
    provider: provider.id,
    model: provider.model,
    candidateSetHash,
    candidateCount: candidates.length,
    evidenceMessageCount
  }))

  try {
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const raw = await provider.generateStructured({
          task: 'daily-intelligence-brief',
          systemPrompt: SYSTEM_PROMPT,
          input
        })
        const parsed = parseAIResponse(raw, date, rawCandidates)
        const items = mergeAIItems(parsed, candidates)
        saveSuccessfulRun(db, runId, date, provider, candidateSetHash, candidates.length, evidenceMessageCount, items)
        return { mode: 'ai', items: items.slice(0, MAX_FINAL_ITEMS), notice: null, telemetry: { ...telemetryBase, cacheHit: false } }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('AI 返回无法使用')
  } catch (error) {
    db.prepare(`
      UPDATE analysis_runs SET status = 'failed', completed_at = ?, metadata_json = ? WHERE id = ?
    `).run(new Date().toISOString(), JSON.stringify({
      provider: provider.id,
      model: provider.model,
      candidateSetHash,
      candidateCount: candidates.length,
      evidenceMessageCount,
      errorType: error instanceof Error ? error.name : 'UnknownError'
    }), runId)
    return {
      mode: 'rule',
      items: candidates.slice(0, MAX_FINAL_ITEMS).map(toRuleItem),
      notice: 'AI增强暂时不可用，当前显示规则结果。',
      telemetry: { ...telemetryBase, cacheHit: false }
    }
  }
}

export function buildAIInput(db: DatabaseSync, date: string, candidates: DailyCandidate[]): DailyAIInput {
  return {
    brief_date: date,
    candidates: candidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      title: candidate.title,
      representative_text: candidate.representativeText,
      importance_score: candidate.importanceScore,
      reason_codes: candidate.reasonCodes,
      conversation_count: candidate.conversationCount,
      message_count: candidate.messageCount,
      first_seen_at: candidate.firstSeenAt,
      last_seen_at: candidate.lastSeenAt,
      evidence: selectEvidence(db, candidate).map((message) => ({
        message_id: message.id,
        conversation_name: message.conversation_name,
        sender_name: ['source_native', 'user_supplied'].includes(message.sender_name_source) ? message.sender_name : '',
        timestamp: message.timestamp,
        content: message.content.slice(0, MAX_EVIDENCE_TEXT_LENGTH)
      }))
    }))
  }
}

export function hashCandidateSet(candidates: DailyCandidate[]): string {
  const stable = candidates.map((candidate) => ({
    id: candidate.candidateId,
    score: candidate.importanceScore,
    title: candidate.title,
    reasons: [...candidate.reasonCodes].sort(),
    sources: [...candidate.sourceMessageIds].sort()
  }))
  return createHash('sha256').update(DAILY_BRIEF_VERSION).update(JSON.stringify(stable)).digest('hex')
}

function hashFinalCandidateSet(candidates: ValuedDailyCandidate[]): string {
  const stable = candidates.map(({ candidate, assessment }) => ({
    id: candidate.candidateId,
    score: candidate.importanceScore,
    title: candidate.title,
    reasons: [...candidate.reasonCodes].sort(),
    sources: [...candidate.sourceMessageIds].sort(),
    dailyValue: assessment.dailyValue,
    dailyPriority: assessment.dailyPriority,
    valueReasons: [...assessment.valueReasonCodes].sort()
  }))
  return createHash('sha256').update(DAILY_BRIEF_VERSION).update(JSON.stringify(stable)).digest('hex')
}

export function parseAIResponse(raw: string, date: string, candidates: DailyCandidate[]): ParsedAIItem[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('AI 返回的 JSON 无法解析')
  }
  if (!isRecord(value) || value.brief_date !== date || !Array.isArray(value.items)) {
    throw new Error('AI 返回结构不符合约定')
  }
  const allowedIds = new Set(candidates.map((candidate) => candidate.candidateId))
  if (value.items.length !== allowedIds.size) throw new Error('AI 返回的候选数量不一致')
  const seen = new Set<string>()
  const parsed = value.items.map((item): ParsedAIItem => {
    if (!isRecord(item)) throw new Error('AI 情报项不是对象')
    const candidateId = requiredString(item.candidate_id, 'candidate_id')
    if (!allowedIds.has(candidateId) || seen.has(candidateId)) throw new Error('AI 返回了不存在或重复的候选')
    seen.add(candidateId)
    const category = requiredString(item.category, 'category')
    const importanceLevel = requiredString(item.importance_level, 'importance_level')
    if (!Array.isArray(item.source_message_ids) || !item.source_message_ids.every((id) => typeof id === 'string')) {
      throw new Error('AI 字段 source_message_ids 无效')
    }
    if (!CATEGORIES.includes(category as DailyCategory)) throw new Error('AI 返回了未知分类')
    if (!LEVELS.includes(importanceLevel as ImportanceLevel)) throw new Error('AI 返回了未知重要级别')
    return {
      candidateId,
      title: requiredString(item.title, 'title'),
      summary: requiredString(item.summary, 'summary'),
      whyItMatters: requiredString(item.why_it_matters, 'why_it_matters'),
      category: category as DailyCategory,
      importanceLevel: importanceLevel as ImportanceLevel
    }
  })
  return parsed
}

function selectEvidence(db: DatabaseSync, candidate: DailyCandidate): EvidenceRow[] {
  if (candidate.sourceMessageIds.length === 0) return []
  const rows = candidate.sourceMessageIds.map((id) => db.prepare(`
    SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
           sender_id, COALESCE(sender_name, '') AS sender_name, sender_name_source,
           COALESCE(timestamp, '') AS timestamp, content
    FROM messages WHERE id = ?
  `).get(id) as EvidenceRow | undefined).filter((row): row is EvidenceRow => Boolean(row))
  const selected: EvidenceRow[] = []
  const usedConversations = new Set<string>()
  const usedSenders = new Set<string>()
  for (const row of rows) {
    if (selected.length >= MAX_EVIDENCE_PER_CANDIDATE) break
    if (!usedConversations.has(row.conversation_id) || !usedSenders.has(row.sender_id)) {
      selected.push(row)
      usedConversations.add(row.conversation_id)
      usedSenders.add(row.sender_id)
    }
  }
  for (const row of rows) {
    if (selected.length >= MAX_EVIDENCE_PER_CANDIDATE) break
    if (!selected.some((item) => item.id === row.id)) selected.push(row)
  }
  return selected
}

function mergeAIItems(parsed: ParsedAIItem[], candidates: ValuedDailyCandidate[]): DailyBriefItem[] {
  const byId = new Map(parsed.map((item) => [item.candidateId, item]))
  return candidates.map(({ candidate, assessment }) => {
    const ai = byId.get(candidate.candidateId)!
    return {
      ...candidate,
      title: ai.title,
      summary: ai.summary,
      whyItMatters: assessment.whyItMatters,
      category: ai.category,
      importanceLevel: assessment.dailyPriority,
      dailyValue: assessment.dailyValue,
      dailyPriority: assessment.dailyPriority,
      valueReasonCodes: assessment.valueReasonCodes,
      sourceMessageIds: [...candidate.sourceMessageIds]
    }
  })
}

function toRuleItem({ candidate, assessment }: ValuedDailyCandidate): DailyBriefItem {
  return {
    ...candidate,
    summary: candidate.representativeText,
    whyItMatters: assessment.whyItMatters,
    category: ruleCategory(candidate),
    importanceLevel: assessment.dailyPriority,
    dailyValue: assessment.dailyValue,
    dailyPriority: assessment.dailyPriority,
    valueReasonCodes: assessment.valueReasonCodes
  }
}

function ruleCategory(candidate: DailyCandidate): DailyCategory {
  const text = `${candidate.title} ${candidate.representativeText}`
  if (/报名|需求|招聘|合作|截止/.test(text)) return '机会 / 需求'
  if (/报告|文档|下载|工具|GitHub|开源/i.test(text)) return '资源 / 工具'
  if (/产品|版本|发布|技术|代码|漏洞|同步|Claude|Ollama/i.test(text)) return '产品 / 技术'
  if (/行业|政策|事件/.test(text)) return '行业 / 事件'
  return '其他'
}

function findCachedBrief(db: DatabaseSync, date: string, provider: AIProvider, hash: string): CacheRow | null {
  return (db.prepare(`
    SELECT result_json, candidate_count, evidence_message_count FROM daily_ai_briefs
    WHERE brief_date = ? AND provider = ? AND model = ? AND candidate_set_hash = ?
  `).get(date, provider.id, provider.model, hash) as CacheRow | undefined) ?? null
}

function parseCachedItems(raw: string, candidates: ValuedDailyCandidate[]): DailyBriefItem[] {
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new Error('缓存结构错误')
  const candidateById = new Map(candidates.map(({ candidate }) => [candidate.candidateId, candidate]))
  if (value.length !== candidates.length) throw new Error('缓存候选数量不一致')
  return candidates.map(({ candidate, assessment }) => {
    const item = value.find((entry) => isRecord(entry) && entry.candidateId === candidate.candidateId)
    if (!isRecord(item)) throw new Error('缓存缺少候选')
    const category = requiredString(item.category, 'category') as DailyCategory
    const level = requiredString(item.importanceLevel, 'importanceLevel') as ImportanceLevel
    if (!CATEGORIES.includes(category) || !LEVELS.includes(level) || !candidateById.has(candidate.candidateId)) {
      throw new Error('缓存枚举值错误')
    }
    return {
      ...candidate,
      title: requiredString(item.title, 'title'),
      summary: requiredString(item.summary, 'summary'),
      whyItMatters: assessment.whyItMatters,
      category,
      importanceLevel: assessment.dailyPriority,
      dailyValue: assessment.dailyValue,
      dailyPriority: assessment.dailyPriority,
      valueReasonCodes: assessment.valueReasonCodes,
      sourceMessageIds: [...candidate.sourceMessageIds]
    }
  })
}

function saveSuccessfulRun(
  db: DatabaseSync,
  runId: string,
  date: string,
  provider: AIProvider,
  hash: string,
  candidateCount: number,
  evidenceMessageCount: number,
  items: DailyBriefItem[]
): void {
  const generatedAt = new Date().toISOString()
  db.exec('BEGIN')
  try {
    db.prepare(`
      UPDATE analysis_runs SET status = 'success', completed_at = ? WHERE id = ?
    `).run(generatedAt, runId)
    db.prepare(`
      INSERT INTO daily_ai_briefs (
        id, analysis_run_id, brief_date, provider, model, candidate_set_hash,
        candidate_count, evidence_message_count, result_json, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(brief_date, provider, model, candidate_set_hash) DO UPDATE SET
        analysis_run_id = excluded.analysis_run_id,
        candidate_count = excluded.candidate_count,
        evidence_message_count = excluded.evidence_message_count,
        result_json = excluded.result_json,
        generated_at = excluded.generated_at
    `).run(randomUUID(), runId, date, provider.id, provider.model, hash, candidateCount, evidenceMessageCount, JSON.stringify(items), generatedAt)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`AI 字段 ${field} 无效`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SYSTEM_PROMPT = `你是 PrivateRadar 的今日情报整理器。只能依据输入中的候选及 evidence 写作，不得使用外部知识或补充事实。
必须返回一个 JSON 对象，包含 brief_date 和 items。items 必须与输入候选一一对应，不得新增、删除、合并或重复 candidate_id。
每项只包含 candidate_id、title、summary、why_it_matters、category、importance_level、source_message_ids。
category 只能是：产品 / 技术、行业 / 事件、资源 / 工具、机会 / 需求、其他。
importance_level 只能是 high、medium、low。证据不足时使用“群内有人提及”或“目前讨论主要集中在”等审慎表达。
不得修改来源数字，不得把推测写成事实。source_message_ids 可原样返回，但程序不会信任该字段。最终优先级与“为什么值得关注”由程序依据规则确定，不依赖模型判断。不要输出 Markdown。`
