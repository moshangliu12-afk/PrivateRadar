export interface StandardMessage {
  messageId: string
  platform: string
  conversationId: string
  conversationName: string
  senderId: string
  senderName: string
  timestamp: string
  content: string
  messageType: string
  links: string[]
  attachments: unknown[]
  replyTo: string | null
  source: string
  rawMetadata: Record<string, unknown>
  conversationNameSource: MetadataProvenance
  senderNameSource: MetadataProvenance
  timestampSource: MetadataProvenance
  contentSource: MetadataProvenance
  stableIdentity: string
  sourceBatchId: string
  sourcePosition: number
}

export type MetadataProvenance = 'source_native' | 'user_supplied' | 'inferred' | 'unknown'

export interface ImportResult {
  jobId: string
  fileName: string
  fileType: 'JSON' | 'CSV' | 'TXT'
  recognizedCount: number
  importedCount: number
  duplicateCount: number
  updatedCount: number
  invalidCount: number
  status: 'success' | 'partial' | 'failed' | 'cancelled'
  errors: string[]
}

export type DailyReasonCode =
  | 'MULTI_CONVERSATION'
  | 'MULTI_SENDER'
  | 'HAS_LINK'
  | 'TRUSTED_LINK'
  | 'GITHUB_REFERENCE'
  | 'HIGH_DISCUSSION'
  | 'INFORMATION_DENSE'
  | 'PRODUCT_OR_VERSION'
  | 'SPECIFIC_NUMBER_OR_DATE'
  | 'EVENT_OR_RELEASE'
  | 'FILE_OR_RESOURCE'
  | 'NEW_TOPIC'

export interface DailyCandidate {
  candidateId: string
  date: string
  title: string
  representativeText: string
  importanceScore: number
  sourceMessageIds: string[]
  sourceConversationIds: string[]
  sourceSenderIds: string[]
  messageCount: number
  conversationCount: number
  firstSeenAt: string
  lastSeenAt: string
  reasonCodes: DailyReasonCode[]
}

/** D1 之后的今日价值判断：信息存在不代表需要在今天打扰用户。 */
export type DailyValue = 'must_show' | 'may_show' | 'drop'

export type DailyValueReasonCode =
  | 'VERIFIABLE_UPDATE'
  | 'TIMELY_MULTI_EVENT'
  | 'RISK_OR_LIMITATION'
  | 'ACTION_REQUIRED'
  | 'BROAD_IMPACT'
  | 'OPPORTUNITY_SIGNAL'
  | 'RELEVANT_RESOURCE'
  | 'UNVERIFIED_SINGLE_REPORT'
  | 'CONTEXTLESS'
  | 'QUESTION_ONLY'
  | 'CHATTER'
  | 'MEDIA_PLACEHOLDER'
  | 'OPAQUE_TOKEN_ONLY'
  | 'BARE_LINK'

export interface DailyValueAssessment {
  dailyValue: DailyValue
  dailyPriority: ImportanceLevel
  valueReasonCodes: DailyValueReasonCode[]
  whyItMatters: string
}

export interface EvidenceMessage {
  messageId: string
  conversationId: string
  conversationName: string
  senderId: string
  senderName: string
  timestamp: string
  content: string
  isSource: boolean
}

export interface CandidateEvidence {
  candidateId: string
  judgment: {
    dailyValue: DailyValue
    dailyPriority: ImportanceLevel
    valueReasonCodes: DailyValueReasonCode[]
    whyItMatters: string
    informationSignalScore: number
    informationSignals: DailyReasonCode[]
  }
  groups: Array<{
    sourceMessageId: string
    messages: EvidenceMessage[]
  }>
}

export type DailyCategory = '产品 / 技术' | '行业 / 事件' | '资源 / 工具' | '机会 / 需求' | '其他'
export type ImportanceLevel = 'high' | 'medium' | 'low'

export interface DailyBriefItem extends DailyCandidate {
  summary: string
  whyItMatters: string
  category: DailyCategory
  importanceLevel: ImportanceLevel
  dailyValue: DailyValue
  dailyPriority: ImportanceLevel
  valueReasonCodes: DailyValueReasonCode[]
}

export interface DailyBriefTelemetry {
  provider: string
  model: string
  candidateCount: number
  evidenceMessageCount: number
  cacheHit: boolean
}

export interface DashboardSummary {
  demoMode: boolean
  date: string
  conversationCount: number
  messageCount: number
  candidateCount: number
  finalIntelligenceCount: number
  mode: 'rule' | 'ai'
  modeNotice: string | null
  telemetry: DailyBriefTelemetry | null
  totalMessageCount: number
  databasePath: string
  items: DailyBriefItem[]
}

export type TopicReasonCode =
  | 'RAPID_MESSAGE_GROWTH'
  | 'RAPID_CONVERSATION_GROWTH'
  | 'MULTI_CONVERSATION'
  | 'MULTI_SENDER'
  | 'NEW_TOPIC'
  | 'CROSS_GROUP_SPREAD'
  | 'HIGH_D1_IMPORTANCE'
  | 'SUSTAINED_GROWTH'

export interface TopicTrendPoint {
  date: string
  messageCount: number
  conversationCount: number
  senderCount: number
}

export interface TopicRadarItem {
  topicId: string
  canonicalName: string
  aliases: string[]
  date: string
  messageCount: number
  conversationCount: number
  senderCount: number
  firstSeenAt: string
  lastSeenAt: string
  historicalAvgMessageCount: number
  historicalAvgConversationCount: number
  historicalAvgSenderCount: number
  growthRate: number
  noveltyScore: number
  signalScore: number
  sourceMessageIds: string[]
  reasonCodes: TopicReasonCode[]
  trend: TopicTrendPoint[]
}

export interface TopicRadarSummary {
  date: string
  historyDays: number
  topics: TopicRadarItem[]
  dataQualityNotice?: string | null
}

export interface LatestGuidedImport {
  jobId: string
  sourceBatchId: string
  status: ImportResult['status']
  recognizedCount: number
  importedCount: number
  duplicateCount: number
  updatedCount: number
  invalidCount: number
  completenessLevel: 'content_only' | 'conversation_known' | 'approximate_time_known' | 'sender_known' | 'complete'
  conversationStatus: 'confirmed' | 'missing'
  senderStatus: 'confirmed' | 'missing'
  timestampStatus: 'confirmed' | 'approximate' | 'missing'
  contentStatus: 'complete' | 'partial'
  capabilityNotice: string
  completedAt: string
}

export interface FirstUseStatus {
  firstLaunch: boolean
  demoMode: boolean
  appVersion: string
  workBuddyConnected: boolean
  workBuddyConnectionMessage: string
  workBuddyInstalled: boolean
  connectorPrepared: boolean
  connectorRequiresRetrust: boolean
  databaseHealthy: boolean
  totalMessageCount: number
  importBatchCount: number
  databasePath: string
  dataDirectory: string
  logDirectory: string
  latestImport: LatestGuidedImport | null
}

export interface ConnectorSetupResult {
  connectorPath: string
  prepared: boolean
  registered: boolean
  registrationPath: string
  registrationChanged: boolean
  requiresTrust: boolean
  trustReason: 'first_install' | 'configuration_changed' | 'none'
  openError: string | null
}

export interface TopicEvidence {
  topicId: string
  messages: EvidenceMessage[]
}

export interface QueryDateRange {
  label: string
  start: string | null
  end: string | null
}

export interface QueryUnderstanding {
  intent: 'find' | 'summarize'
  sort: 'relevance' | 'oldest'
  dateRange: QueryDateRange
  timeIntent: 'none' | 'recent' | 'strict'
  personIntent: 'none' | 'who'
  isNaturalLanguage: boolean
  conversationIds: string[]
  conversationNames: string[]
  senderIds: string[]
  senderNames: string[]
  entityKeys: string[]
  coreTopics: string[]
  eventTerms: string[]
  expandedTerms: string[]
  searchTerms: string[]
}

export interface ChatSearchResult {
  messageId: string
  conversationId: string
  conversationName: string
  senderId: string
  senderName: string
  senderNameSource: MetadataProvenance
  timestamp: string
  timeVerification: 'verified' | 'unknown'
  content: string
  links: string[]
  relevanceScore: number
  matchReasons: string[]
}

export interface ChatAnswerTelemetry {
  retrievalMode: '全文搜索' | '全文 + 语义'
  aiMode: '规则模式' | 'AI增强模式'
  evidenceSentCount: number
  embeddingCandidateCount: number
}

export interface ChatQueryResponse {
  queryType: 'find' | 'summarize'
  answer: string | null
  insufficientEvidence: boolean
  understanding: QueryUnderstanding
  results: ChatSearchResult[]
  unverifiedTimeResults: ChatSearchResult[]
  sourceMessageIds: string[]
  hitMessageCount: number
  conversationCount: number
  senderCount: number
  telemetry: ChatAnswerTelemetry
}

export interface MessageContext {
  sourceMessageId: string
  messages: EvidenceMessage[]
}

/** 用户反馈只用于后续人工审计；不会在当前版本自动改变任何算法。 */
export type FeedbackSurface = 'daily' | 'search'
export type FeedbackType = 'daily_item' | 'missing_important' | 'search_answer'
export type FeedbackVote = 'USEFUL' | 'SHOULD_NOT_SHOW' | 'MISSING_IMPORTANT' | 'CORRECT' | 'INCORRECT'

export interface FeedbackState {
  feedbackId: string
  vote: FeedbackVote
  reasonCode: string | null
  note: string | null
  updatedAt: string
}

export interface FeedbackExportResult {
  cancelled: boolean
  path: string | null
  count: number
}
