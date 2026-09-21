import type { CandidateEvidence, ChatQueryResponse, ConnectorSetupResult, DailyBriefItem, DashboardSummary, FeedbackExportResult, FeedbackState, FirstUseStatus, ImportResult, MessageContext, TopicEvidence, TopicRadarSummary } from '../../shared/models'

declare global {
  interface Window {
    privateRadar: {
      getDashboardSummary: (date?: string) => Promise<DashboardSummary>
      refreshDashboard: (date?: string) => Promise<DashboardSummary>
      regenerateDashboard: (date?: string) => Promise<DashboardSummary>
      getCandidateEvidence: (candidateId: string) => Promise<CandidateEvidence | null>
      getTopicRadarSummary: () => Promise<TopicRadarSummary>
      getTopicEvidence: (topicId: string, date: string) => Promise<TopicEvidence | null>
      askChat: (question: string) => Promise<ChatQueryResponse>
      getMessageContext: (messageId: string) => Promise<MessageContext | null>
      getDailyFeedbackStates: (candidateIds: string[]) => Promise<Record<string, FeedbackState>>
      saveDailyFeedback: (input: { item: DailyBriefItem; vote: 'USEFUL' | 'SHOULD_NOT_SHOW'; reasonCode?: string | null; note?: string | null }) => Promise<FeedbackState>
      saveMissingImportantFeedback: (input: { dateKey: string; note?: string | null }) => Promise<FeedbackState>
      getSearchFeedbackState: (question: string, sourceMessageIds: string[]) => Promise<FeedbackState | null>
      saveSearchFeedback: (input: { question: string; response: ChatQueryResponse; vote: 'CORRECT' | 'INCORRECT'; reasonCode?: string | null; note?: string | null }) => Promise<FeedbackState>
      exportFeedback: () => Promise<FeedbackExportResult>
      chooseAndImportFile: () => Promise<ImportResult | null>
      getFirstUseStatus: () => Promise<FirstUseStatus>
      activateDemo: () => Promise<DashboardSummary>
      openWorkBuddyConfig: () => Promise<ConnectorSetupResult>
      checkWorkBuddyConnection: () => Promise<FirstUseStatus>
      openDataDirectory: () => Promise<string | null>
      openLogDirectory: () => Promise<string | null>
    }
  }
}

export {}
