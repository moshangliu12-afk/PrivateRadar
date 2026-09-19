import type { DailyCategory, ImportanceLevel } from '../../shared/models'
import type { AIProvider, StructuredAIRequest } from './provider'

export type MockResponder = (request: StructuredAIRequest) => string | Promise<string>

export class MockAIProvider implements AIProvider {
  readonly id = 'mock'
  readonly model = 'private-radar-demo'
  callCount = 0

  constructor(private readonly responder: MockResponder = defaultResponse) {}

  async generateStructured(request: StructuredAIRequest): Promise<string> {
    this.callCount += 1
    return this.responder(request)
  }
}

interface MockCandidate {
  candidate_id: string
  title: string
  representative_text: string
  importance_score: number
  reason_codes: string[]
  conversation_count: number
  message_count: number
}

interface MockInput {
  brief_date: string
  candidates: MockCandidate[]
}

function defaultResponse(request: StructuredAIRequest): string {
  if (request.task === 'chat-question-answer') return defaultChatAnswer(request)
  const input = request.input as MockInput
  return JSON.stringify({
    brief_date: input.brief_date,
    items: input.candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      title: improveTitle(candidate.title),
      summary: `${candidate.conversation_count} 个群共有 ${candidate.message_count} 条候选依据提及该信息。群内代表性说法是：“${clip(candidate.representative_text, 82).replace(/[。！？.!?]+$/, '')}”。`,
      why_it_matters: whyItMatters(candidate),
      category: categoryFor(candidate),
      importance_level: levelFor(candidate.importance_score),
      source_message_ids: ['模型返回的编号不会被采用']
    }))
  })
}

function defaultChatAnswer(request: StructuredAIRequest): string {
  const input = request.input as {
    question: string
    evidence: Array<{ message_id: string; conversation_name: string; sender_name: string; timestamp: string; content: string }>
  }
  const groups = new Set(input.evidence.map((item) => item.conversation_name).filter(Boolean)).size
  const senders = new Set(input.evidence.map((item) => item.sender_name).filter(Boolean)).size
  const ordered = [...input.evidence].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  const first = ordered[0]
  const latest = ordered.at(-1)
  const issueCount = input.evidence.filter((item) => /崩溃|报错|错误|故障|失败/.test(item.content)).length
  const detail = issueCount > 0
    ? `其中 ${issueCount} 条涉及崩溃、报错或故障，其余讨论主要是功能与使用体验。`
    : `较早记录提到“${clip(first?.content ?? '', 70)}”，近期记录提到“${clip(latest?.content ?? '', 70)}”。`
  return JSON.stringify({
    answer: `在本次检索到的 ${input.evidence.length} 条聊天中，相关讨论来自 ${groups} 个群、${senders > 0 ? `${senders} 人` : '发送者未知'}。${detail}这些结论仅针对当前检索结果。`,
    source_message_ids: ['模型返回的编号不会被采用']
  })
}

function improveTitle(title: string): string {
  const known: Array<[RegExp, string]> = [
    [/private-index/i, 'PrivateIndex 在三个群被集中推荐'],
    [/DataNest/i, 'DataNest 1.4 增量同步引发跨群讨论'],
    [/Claude Code/i, 'Claude Code 在多个开发群持续升温'],
    [/miniprogram-starter/i, '微信小程序开源项目被多次分享'],
    [/LocalLens/i, 'LocalLens 2.0 发布离线文档检索能力'],
    [/2026\s*年内容工具调研报告/, '2026 年内容工具调研报告开放下载'],
    [/内测报名截止/, '产品内测报名将在明天 10 点截止'],
    [/安全公告|4\.2\.1/, '依赖解析漏洞已修复，建议升级到 4.2.1'],
    [/公众号排版工具/, '公众号排版工具在群内被反复推荐'],
    [/Ollama/i, 'Ollama 本地运行与隐私优势受到关注']
  ]
  return known.find(([pattern]) => pattern.test(title))?.[1] ?? title
}

function whyItMatters(candidate: MockCandidate): string {
  if (candidate.conversation_count > 1) return '信息在多个群被重复提及，跨群信号高于单群孤立消息。'
  if (candidate.reason_codes.includes('HAS_LINK') && candidate.message_count === 1) {
    return '虽然目前只有一条来源，但包含明确事件和可核对链接，值得快速查看。'
  }
  if (candidate.message_count >= 3) return '同一群内出现了多条相关依据，讨论密度明显高于普通消息。'
  return '内容包含明确产品、版本、日期或资源线索，具备直接行动价值。'
}

function categoryFor(candidate: MockCandidate): DailyCategory {
  const text = `${candidate.title} ${candidate.representative_text}`
  if (/报名|需求|招聘|合作|截止/.test(text)) return '机会 / 需求'
  if (/Claude|Ollama|DataNest|LocalLens|版本|漏洞|同步/i.test(text)) return '产品 / 技术'
  if (/报告|文档|下载|工具|GitHub|开源/i.test(text)) return '资源 / 工具'
  if (/发布|产品|技术|代码/i.test(text)) return '产品 / 技术'
  if (/行业|政策|事件/.test(text)) return '行业 / 事件'
  return '其他'
}

function levelFor(score: number): ImportanceLevel {
  return score >= 10 ? 'high' : score >= 6 ? 'medium' : 'low'
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
