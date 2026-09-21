import type { DailyCandidate, DailyReasonCode } from '../../../shared/models'

export interface DailyMessage {
  id: string
  conversationId: string
  conversationName: string
  conversationKnown?: boolean
  senderId: string
  senderName: string
  senderKnown?: boolean
  timestamp: string
  timestampKnown?: boolean
  content: string
  messageType: string
  links: string[]
  replyTo: string | null
}

export interface MessageFeatures {
  hasLink: boolean
  hasTrustedLink: boolean
  hasGithub: boolean
  hasProductOrVersion: boolean
  hasNumberOrDate: boolean
  hasEventOrRelease: boolean
  hasFileOrResource: boolean
  hasExplicitObject: boolean
  actionRequired: boolean
  deadlineOrTimeSensitive: boolean
  consequence: boolean
  verifiableChange: boolean
  failureOrLoss: boolean
  riskOrLimitation: boolean
  alternativeCost: boolean
  informationDense: boolean
  meaningfulLength: number
}

export interface CandidateCluster {
  messages: DailyMessage[]
  representative: DailyMessage
  features: MessageFeatures
  canonicalUrls: Set<string>
  entityKeys: Set<string>
}

export interface ImportanceInput {
  features: MessageFeatures
  messageCount: number
  conversationCount: number
  senderCount: number
  hasHighDiscussion: boolean
  isNewTopic: boolean
}

export interface DailyPipelineResult {
  date: string
  totalMessages: number
  filteredNoise: number
  candidates: DailyCandidate[]
}

export interface CandidateDraft extends DailyCandidate {
  reasonCodes: DailyReasonCode[]
}
