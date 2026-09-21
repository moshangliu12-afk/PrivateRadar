import { contextBridge, ipcRenderer } from 'electron'
import type { CandidateEvidence, ChatQueryResponse, ConnectorSetupResult, DailyBriefItem, DashboardSummary, FeedbackExportResult, FeedbackState, FirstUseStatus, ImportResult, MessageContext, TopicEvidence, TopicRadarSummary } from '../shared/models'

contextBridge.exposeInMainWorld('privateRadar', {
  getDashboardSummary: (date?: string): Promise<DashboardSummary> => ipcRenderer.invoke('dashboard:get-summary', date),
  refreshDashboard: (date?: string): Promise<DashboardSummary> => ipcRenderer.invoke('dashboard:refresh', date),
  regenerateDashboard: (date?: string): Promise<DashboardSummary> => ipcRenderer.invoke('dashboard:regenerate', date),
  getCandidateEvidence: (candidateId: string): Promise<CandidateEvidence | null> => ipcRenderer.invoke('candidate:get-evidence', candidateId),
  getTopicRadarSummary: (): Promise<TopicRadarSummary> => ipcRenderer.invoke('radar:get-summary'),
  getTopicEvidence: (topicId: string, date: string): Promise<TopicEvidence | null> => ipcRenderer.invoke('topic:get-evidence', topicId, date),
  askChat: (question: string): Promise<ChatQueryResponse> => ipcRenderer.invoke('chat:ask', question),
  getMessageContext: (messageId: string): Promise<MessageContext | null> => ipcRenderer.invoke('chat:get-context', messageId),
  getDailyFeedbackStates: (candidateIds: string[]): Promise<Record<string, FeedbackState>> => ipcRenderer.invoke('feedback:daily:states', candidateIds),
  saveDailyFeedback: (input: { item: DailyBriefItem; vote: 'USEFUL' | 'SHOULD_NOT_SHOW'; reasonCode?: string | null; note?: string | null }): Promise<FeedbackState> => ipcRenderer.invoke('feedback:daily:save', input),
  saveMissingImportantFeedback: (input: { dateKey: string; note?: string | null }): Promise<FeedbackState> => ipcRenderer.invoke('feedback:daily:missing', input),
  getSearchFeedbackState: (question: string, sourceMessageIds: string[]): Promise<FeedbackState | null> => ipcRenderer.invoke('feedback:search:state', question, sourceMessageIds),
  saveSearchFeedback: (input: { question: string; response: ChatQueryResponse; vote: 'CORRECT' | 'INCORRECT'; reasonCode?: string | null; note?: string | null }): Promise<FeedbackState> => ipcRenderer.invoke('feedback:search:save', input),
  exportFeedback: (): Promise<FeedbackExportResult> => ipcRenderer.invoke('feedback:export'),
  chooseAndImportFile: (): Promise<ImportResult | null> => ipcRenderer.invoke('import:choose-file'),
  getFirstUseStatus: (): Promise<FirstUseStatus> => ipcRenderer.invoke('experience:get-status'),
  activateDemo: (): Promise<DashboardSummary> => ipcRenderer.invoke('experience:activate-demo'),
  openWorkBuddyConfig: (): Promise<ConnectorSetupResult> => ipcRenderer.invoke('experience:open-workbuddy-config'),
  checkWorkBuddyConnection: (): Promise<FirstUseStatus> => ipcRenderer.invoke('experience:check-workbuddy'),
  openDataDirectory: (): Promise<string | null> => ipcRenderer.invoke('settings:open-data-directory'),
  openLogDirectory: (): Promise<string | null> => ipcRenderer.invoke('settings:open-log-directory')
})
