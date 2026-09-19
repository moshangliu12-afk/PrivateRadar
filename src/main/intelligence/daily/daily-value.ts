import type {
  DailyCandidate,
  DailyValueAssessment,
  DailyValueReasonCode,
  ImportanceLevel
} from '../../../shared/models'

/** Daily Value 规则版本会进入 Daily Brief 缓存键。 */
export const DAILY_VALUE_VERSION = 'daily-value-v1'

export interface ValuedDailyCandidate {
  candidate: DailyCandidate
  assessment: DailyValueAssessment
}

/**
 * 只根据 D1 已产生的候选及其代表文本做确定性价值判断。
 * 不改变 D1 分数、候选生成、原始消息或 Topic 输入。
 */
export function assessDailyValue(candidate: DailyCandidate): DailyValueAssessment {
  const text = normalize(candidate.representativeText)
  const analysis = analyzeText(text)

  if (analysis.mediaPlaceholder) return drop(['MEDIA_PLACEHOLDER'], '这是一条没有独立正文的媒体占位信息。')
  if (analysis.bareLink) return drop(['BARE_LINK', 'CONTEXTLESS'], '只有链接，缺少资源用途、变化说明或行动上下文。')

  if (analysis.formalRiskNotice && analysis.actionRequired && analysis.broadImpact) {
    return mustShow(
      'high',
      ['RISK_OR_LIMITATION', 'ACTION_REQUIRED', 'BROAD_IMPACT'],
      '涉及明确风险，并包含面向相关人群的行动要求。'
    )
  }

  if (analysis.timelyMultiEvent) {
    return mustShow(
      'high',
      ['TIMELY_MULTI_EVENT', 'BROAD_IMPACT', 'VERIFIABLE_UPDATE'],
      '包含多个具有时效性的明确事件与产品变化。'
    )
  }

  if (analysis.verifiableUpdate) {
    return mustShow('medium', ['VERIFIABLE_UPDATE'], '产品或项目出现了明确、可核对的更新。')
  }

  if (analysis.opportunity) {
    const priority: ImportanceLevel = analysis.structuredOpportunity ? 'medium' : 'low'
    return mayShow(priority, ['OPPORTUNITY_SIGNAL'], '包含明确的采购、供给、合作或工作机会线索。')
  }

  if (analysis.relevantResource) {
    return mayShow('medium', ['RELEVANT_RESOURCE'], '提供了具体资源或工具，并说明了用途或适用场景。')
  }

  if (analysis.riskOrLimitation) {
    const priority: ImportanceLevel = analysis.broadImpact ? 'medium' : 'low'
    const reasons: DailyValueReasonCode[] = ['RISK_OR_LIMITATION']
    if (analysis.unverifiedSingleReport) reasons.push('UNVERIFIED_SINGLE_REPORT')
    return mayShow(priority, reasons, analysis.unverifiedSingleReport
      ? '反映了可能影响使用的故障或限制，但目前只有单条、未验证的观察。'
      : '反映了可能影响使用、决策或安全的限制信息。')
  }

  if (analysis.questionOnly) return drop(['QUESTION_ONLY', 'CONTEXTLESS'], '只有提问，没有足够的事实、变化或可执行结论。')
  if (analysis.opaqueTokenOnly) return drop(['OPAQUE_TOKEN_ONLY', 'CONTEXTLESS'], '只有产品或版本碎片，未说明发生了什么变化。')
  if (analysis.chatter) return drop(['CHATTER', 'CONTEXTLESS'], '属于普通闲聊、猜测或缺少独立上下文的短句。')
  return drop(['CONTEXTLESS'], '缺少明确事件、风险、行动要求或可复用的资源上下文。')
}

/** Final Daily 的确定性排序；D1 分数只在同层级时作为第三排序键。 */
export function rankFinalDailyCandidates(candidates: DailyCandidate[]): ValuedDailyCandidate[] {
  return candidates
    .map((candidate) => ({ candidate, assessment: assessDailyValue(candidate) }))
    .filter((item) => item.assessment.dailyValue !== 'drop')
    .sort((left, right) =>
      valueRank(right.assessment.dailyValue) - valueRank(left.assessment.dailyValue) ||
      priorityRank(right.assessment.dailyPriority) - priorityRank(left.assessment.dailyPriority) ||
      right.candidate.importanceScore - left.candidate.importanceScore ||
      left.candidate.firstSeenAt.localeCompare(right.candidate.firstSeenAt) ||
      left.candidate.candidateId.localeCompare(right.candidate.candidateId)
    )
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function analyzeText(text: string): {
  mediaPlaceholder: boolean
  bareLink: boolean
  formalRiskNotice: boolean
  actionRequired: boolean
  broadImpact: boolean
  timelyMultiEvent: boolean
  verifiableUpdate: boolean
  opportunity: boolean
  structuredOpportunity: boolean
  relevantResource: boolean
  riskOrLimitation: boolean
  unverifiedSingleReport: boolean
  questionOnly: boolean
  opaqueTokenOnly: boolean
  chatter: boolean
} {
  const withoutLinks = text.replace(/https?:\/\/[^\s，。；;!?！？]+/gi, ' ').trim()
  const mediaPlaceholder = /^[［【\[](?:图片|文件|语音|视频)[］】\]](?:\s|\S)*$/u.test(text) && !hasSentenceAfterMarker(text)
  const bareLink = /^https?:\/\/[^\s]+$/i.test(text)
  const hasNamedSubject = /[A-Za-z][A-Za-z0-9 ._-]{1,}|[\u4e00-\u9fff]{2,}(?:产品|项目|系统|服务|物业|平台|模型|工具|课程|中心)/.test(withoutLinks)
  const changeEvent = /(?:正式|已|已经|今日|今天|刚刚|将于)?\s*(?:发布|更新|上线|推出|开放|新增|完成|融资|灰度测试|修复|公告)/.test(withoutLinks)
  const actionRequired = /(?:请|需|需要|应当|务必|及时|切勿|自觉|报名|申报|联系|对接|清理|处理|避免)\s*[\u4e00-\u9fff]{1,8}/.test(withoutLinks)
  const riskOrLimitation = /(?:风险|隐患|故障|异常|无法|不能|连不上|中断|安全|漏洞|限制|不一定能看到|不稳定|扣费)/.test(withoutLinks)
  const formalNotice = /(?:通知|公告|温馨提示|服务中心|管理规定|各位(?:业主|住户|用户|客户)|尊敬的)/.test(withoutLinks)
  const broadScope = /(?:全体|各位|业主|住户|用户|客户|团队|公共|小区|行业|多项|多个|大家)/.test(withoutLinks)
  const hasDateOrTimeliness = /(?:今天|今日|本周|\d{4}[年\/-]\d{1,2}|\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})/.test(withoutLinks)
  const eventCount = (withoutLinks.match(/发布|更新|上线|推出|完成|融资|测试|修复|呼吁|警示/g) ?? []).length
  const numberedEvents = (withoutLinks.match(/(?:^|\s)\d+[.、]/g) ?? []).length
  const timelyMultiEvent = hasDateOrTimeliness && (eventCount >= 2 || numberedEvents >= 2) && hasNamedSubject
  const verifiableUpdate = changeEvent && hasNamedSubject && withoutLinks.length >= 10 && !isQuestion(text)
  const opportunity = /(?:求购|采购|货源|渠道|供给|出售|出(?:[一二三四五六七八九十\d]+)?(?:张|个|份|家)?|合作|招聘|申报|服务商|销售|联系人|对接|需要.*(?:品牌|服务商|资料|联系人))/.test(withoutLinks)
  const structuredOpportunity = opportunity && /(?:申报|招聘|合作|服务商|品牌年度|明确截止)/.test(withoutLinks) && withoutLinks.length >= 14
  const resourceSignal = /(?:项目|工具|仓库|教程|课程|文档|资料|知识库|资源|下载)/.test(withoutLinks)
  const purposeSignal = /(?:可以|能够|用于|适合|帮助|维护|推荐|试一下|看看|用来)/.test(withoutLinks)
  const relevantResource = resourceSignal && purposeSignal && withoutLinks.length >= 14
  const unverifiedSingleReport = /(?:好像|感觉|我看|我用|我在|我刚|又|可能|不一定)/.test(withoutLinks) || (!broadScope && /(?:我|你)/.test(withoutLinks))
  const questionOnly = isQuestion(text) && !changeEvent && !riskOrLimitation && !opportunity && !relevantResource
  const opaqueTokenOnly = withoutLinks.length <= 26 && !hasSentenceVerb(withoutLinks) && /[A-Za-z]/.test(withoutLinks) && /\d|\b[A-Za-z]{2,}\b/.test(withoutLinks)
  const chatter = withoutLinks.length <= 18 && !changeEvent && !riskOrLimitation && !opportunity && !relevantResource && !hasNamedSubject
  return {
    mediaPlaceholder,
    bareLink,
    formalRiskNotice: formalNotice && riskOrLimitation,
    actionRequired,
    broadImpact: broadScope,
    timelyMultiEvent,
    verifiableUpdate,
    opportunity,
    structuredOpportunity,
    relevantResource,
    riskOrLimitation,
    unverifiedSingleReport,
    questionOnly,
    opaqueTokenOnly,
    chatter
  }
}

function hasSentenceAfterMarker(text: string): boolean {
  const remainder = text.replace(/^[［【\[](?:图片|文件|语音|视频)[］】\]]/u, '').trim()
  return remainder.length > 0 && !/^[^\s]+\.(?:jpg|jpeg|png|gif|webp|mp4|mp3|pdf|zip|rar|docx?|xlsx?|pptx?)$/i.test(remainder)
}

function hasSentenceVerb(value: string): boolean {
  return /(?:是|有|在|了|可|能|会|做|用|给|出|推|发|更|上|下|成|对|帮)/.test(value)
}

function isQuestion(value: string): boolean {
  return /[？?]|(?:吗|么|是否|有没有|能否|怎么|哪里|是不是|好不好)$/.test(value)
}

function mustShow(priority: ImportanceLevel, reasons: DailyValueReasonCode[], whyItMatters: string): DailyValueAssessment {
  return { dailyValue: 'must_show', dailyPriority: priority, valueReasonCodes: reasons, whyItMatters }
}

function mayShow(priority: ImportanceLevel, reasons: DailyValueReasonCode[], whyItMatters: string): DailyValueAssessment {
  return { dailyValue: 'may_show', dailyPriority: priority, valueReasonCodes: reasons, whyItMatters }
}

function drop(reasons: DailyValueReasonCode[], whyItMatters: string): DailyValueAssessment {
  return { dailyValue: 'drop', dailyPriority: 'low', valueReasonCodes: reasons, whyItMatters }
}

function valueRank(value: DailyValueAssessment['dailyValue']): number {
  return value === 'must_show' ? 2 : value === 'may_show' ? 1 : 0
}

function priorityRank(priority: ImportanceLevel): number {
  return priority === 'high' ? 3 : priority === 'medium' ? 2 : 1
}
