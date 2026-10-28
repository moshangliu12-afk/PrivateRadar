import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChatQueryResponse, EvidenceMessage, MessageContext } from '../../shared/models'
import { resolveAIProvider } from '../ai/config'
import type { AIProvider } from '../ai/provider'
import { resolveEmbeddingProvider } from '../embedding/config'
import type { EmbeddingProvider } from '../embedding/provider'
import { runDailyIntelligence } from '../intelligence/daily/repository'
import { runTopicRadar } from '../intelligence/topics/repository'
import { hybridSearch } from './hybrid-search'
import { understandQuery } from './query-understanding'
import { conversationNameProjector } from '../conversation-labels'

const MAX_AI_EVIDENCE = 40
const MAX_AI_TEXT_LENGTH = 360

export interface AskChatOptions {
  aiProvider?: AIProvider | null
  embeddingProvider?: EmbeddingProvider | null
  // 测试可注入固定参考日期；生产请求默认使用当前本地日历日期。
  anchorDate?: string
}

export async function askChat(db: DatabaseSync, question: string, options: AskChatOptions = {}): Promise<ChatQueryResponse> {
  const normalizedQuestion = question.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!normalizedQuestion) throw new Error('请输入问题')
  const anchorDate = options.anchorDate ?? currentLocalDate()
  const topicCount = db.prepare('SELECT COUNT(*) AS count FROM topic_daily_metrics WHERE metric_date = ?').get(anchorDate) as { count: number }
  if (topicCount.count === 0) {
    const d1 = runDailyIntelligence(db, anchorDate)
    runTopicRadar(db, anchorDate, d1.candidates)
  }
  const understanding = understandQuery(db, normalizedQuestion, anchorDate, question)
  const embeddingProvider = options.embeddingProvider === undefined ? resolveEmbeddingProvider() : options.embeddingProvider
  const retrieval = await hybridSearch(db, normalizedQuestion, understanding, embeddingProvider, question)
  const projectName = conversationNameProjector(db)
  retrieval.results = retrieval.results.map(projectName)
  retrieval.unverifiedTimeResults = retrieval.unverifiedTimeResults.map(projectName)
  const allResults = [...retrieval.results, ...retrieval.unverifiedTimeResults]
  const sourceMessageIds = allResults.map((item) => item.messageId)
  const telemetryBase = {
    retrievalMode: retrieval.usedEmbedding ? '全文 + 语义' as const : '全文搜索' as const,
    embeddingCandidateCount: retrieval.embeddingCandidateCount
  }

  if (allResults.length === 0) {
    return {
      queryType: understanding.intent,
      answer: '没有找到足够相关的聊天记录。',
      insufficientEvidence: true,
      understanding,
      results: [],
      unverifiedTimeResults: [],
      sourceMessageIds: [],
      hitMessageCount: 0,
      conversationCount: 0,
      senderCount: 0,
      telemetry: { ...telemetryBase, aiMode: '规则模式', evidenceSentCount: 0 }
    }
  }

  const counts = {
    messages: allResults.length,
    conversations: new Set(allResults.filter((item) => item.conversationName).map((item) => item.conversationId)).size,
    senders: new Set(allResults
      .filter((item) => ['source_native', 'user_supplied'].includes(item.senderNameSource) && item.senderName)
      .map((item) => item.senderId)).size
  }
  if (understanding.intent === 'find') {
    return {
      queryType: 'find',
      answer: understanding.isNaturalLanguage ? buildRuleAnswer(understanding, retrieval.results, retrieval.unverifiedTimeResults) : null,
      insufficientEvidence: false,
      understanding,
      results: retrieval.results,
      unverifiedTimeResults: retrieval.unverifiedTimeResults,
      sourceMessageIds,
      hitMessageCount: counts.messages,
      conversationCount: counts.conversations,
      senderCount: counts.senders,
      telemetry: { ...telemetryBase, aiMode: '规则模式', evidenceSentCount: 0 }
    }
  }

  const evidence = allResults.slice(0, MAX_AI_EVIDENCE)
  const evidenceIds = evidence.map((item) => item.messageId)
  const aiProvider = options.aiProvider === undefined ? resolveAIProvider() : options.aiProvider
  if (!aiProvider) {
    return {
      queryType: 'summarize',
      answer: '当前为规则模式，以下为检索到的相关聊天记录。',
      insufficientEvidence: false,
      understanding,
      results: retrieval.results,
      unverifiedTimeResults: retrieval.unverifiedTimeResults,
      sourceMessageIds: evidenceIds,
      hitMessageCount: counts.messages,
      conversationCount: counts.conversations,
      senderCount: counts.senders,
      telemetry: { ...telemetryBase, aiMode: '规则模式', evidenceSentCount: 0 }
    }
  }

  try {
    const input = {
      question: normalizedQuestion,
      evidence: evidence.map((item) => ({
        message_id: item.messageId,
        conversation_name: item.conversationName,
        sender_name: ['source_native', 'user_supplied'].includes(item.senderNameSource) ? item.senderName : '',
        timestamp: item.timestamp,
        content: item.content.slice(0, MAX_AI_TEXT_LENGTH)
      }))
    }
    let answer = ''
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await aiProvider.generateStructured({ task: 'chat-question-answer', systemPrompt: ANSWER_PROMPT, input })
        answer = parseAnswer(raw)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!answer) throw lastError instanceof Error ? lastError : new Error('AI 回答不可用')
    saveAnswerRun(db, normalizedQuestion, aiProvider, evidenceIds)
    return {
      queryType: 'summarize',
      answer,
      insufficientEvidence: false,
      understanding,
      results: retrieval.results,
      unverifiedTimeResults: retrieval.unverifiedTimeResults,
      sourceMessageIds: evidenceIds,
      hitMessageCount: counts.messages,
      conversationCount: counts.conversations,
      senderCount: counts.senders,
      telemetry: { ...telemetryBase, aiMode: 'AI增强模式', evidenceSentCount: evidence.length }
    }
  } catch {
    return {
      queryType: 'summarize',
      answer: 'AI增强暂时不可用，当前为规则模式，以下为检索到的相关聊天记录。',
      insufficientEvidence: false,
      understanding,
      results: retrieval.results,
      unverifiedTimeResults: retrieval.unverifiedTimeResults,
      sourceMessageIds: evidenceIds,
      hitMessageCount: counts.messages,
      conversationCount: counts.conversations,
      senderCount: counts.senders,
      telemetry: { ...telemetryBase, aiMode: '规则模式', evidenceSentCount: 0 }
    }
  }
}

function buildRuleAnswer(
  understanding: ChatQueryResponse['understanding'],
  verified: ChatQueryResponse['results'],
  unverified: ChatQueryResponse['unverifiedTimeResults']
): string {
  const results = [...verified, ...unverified]
  const topic = displayTopic(understanding)
  const count = results.length
  const base = `找到 ${count} 条与${topic}相关的聊天。`
  const allSendersUnknown = understanding.personIntent === 'who' && results.every((item) => !['source_native', 'user_supplied'].includes(item.senderNameSource))
  const hasNotice = results.some((item) => /通知|公告|温馨提示/.test(item.content))
  const timeNotice = unverified.length > 0
    ? `其中 ${unverified.length} 条原始时间未提供，无法确认是否发生在${understanding.dateRange.label}。`
    : ''
  if (allSendersUnknown) return `${base}原始分享数据未提供发送者，因此暂时无法确认是谁发送的。${timeNotice}`
  if (hasNotice) return `${base}其中包含一份通知或公告。${timeNotice}`
  return `${base}${timeNotice}`
}

function displayTopic(understanding: ChatQueryResponse['understanding']): string {
  const preferred = understanding.coreTopics.find((topic) => !['工具更新', '消防安全', '故障'].includes(topic))
  const topic = preferred ?? understanding.coreTopics[0] ?? understanding.searchTerms[0] ?? '你的问题'
  return `“${topic}”`
}

export function getMessageContext(db: DatabaseSync, messageId: string, radius = 2): MessageContext | null {
  const source = loadMessage(db, messageId)
  if (!source) return null
  const before = db.prepare(`
    SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
           sender_id, COALESCE(sender_name, '') AS sender_name, COALESCE(timestamp, '') AS timestamp, content
    FROM messages WHERE conversation_id = ? AND (timestamp < ? OR (timestamp = ? AND id < ?))
    ORDER BY timestamp DESC, id DESC LIMIT ?
  `).all(source.conversation_id, source.timestamp, source.timestamp, source.id, radius) as unknown as ContextRow[]
  const after = db.prepare(`
    SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
           sender_id, COALESCE(sender_name, '') AS sender_name, COALESCE(timestamp, '') AS timestamp, content
    FROM messages WHERE conversation_id = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))
    ORDER BY timestamp, id LIMIT ?
  `).all(source.conversation_id, source.timestamp, source.timestamp, source.id, radius) as unknown as ContextRow[]
  return { sourceMessageId: messageId, messages: [...before.reverse(), source, ...after].map((row) => contextMessage(row, messageId)).map(conversationNameProjector(db)) }
}

function parseAnswer(raw: string): string {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('AI 回答不是合法 JSON')
  }
  if (!isRecord(value) || typeof value.answer !== 'string' || !value.answer.trim() || !Array.isArray(value.source_message_ids)) {
    throw new Error('AI 回答结构无效')
  }
  return value.answer.trim()
}

function saveAnswerRun(db: DatabaseSync, question: string, provider: AIProvider, sourceIds: string[]): void {
  const queryHash = createHash('sha256').update(question.toLowerCase()).digest('hex')
  db.prepare(`
    INSERT INTO query_answer_runs (
      id, query_hash, answer_mode, provider, model, source_message_ids_json, result_json, generated_at
    ) VALUES (?, ?, 'ai', ?, ?, ?, ?, ?)
  `).run(randomUUID(), queryHash, provider.id, provider.model, JSON.stringify(sourceIds), JSON.stringify({ status: 'generated' }), new Date().toISOString())
}

function currentLocalDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function loadMessage(db: DatabaseSync, id: string): ContextRow | null {
  return (db.prepare(`
    SELECT id, conversation_id, COALESCE(conversation_name, '') AS conversation_name,
           sender_id, COALESCE(sender_name, '') AS sender_name, COALESCE(timestamp, '') AS timestamp, content
    FROM messages WHERE id = ?
  `).get(id) as ContextRow | undefined) ?? null
}

function contextMessage(row: ContextRow, sourceId: string): EvidenceMessage {
  return {
    messageId: row.id,
    conversationId: row.conversation_id,
    conversationName: row.conversation_name,
    senderId: row.sender_id,
    senderName: row.sender_name,
    timestamp: row.timestamp,
    content: row.content,
    isSource: row.id === sourceId
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ContextRow {
  id: string
  conversation_id: string
  conversation_name: string
  sender_id: string
  sender_name: string
  timestamp: string
  content: string
}

const ANSWER_PROMPT = `你是 PrivateRadar 的聊天证据整理器。只能依据输入 evidence 回答用户问题，不得使用外部知识或补充事实。
所有判断必须限定为“本次检索到的聊天”。不得把少数人的意见写成所有人的共识，不得改变消息中的数字或时间。
证据不足时明确说没有足够证据。只返回 JSON：{"answer":"...","source_message_ids":["..."]}。程序不会信任你返回的来源编号。不要输出 Markdown。`
