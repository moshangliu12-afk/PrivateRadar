import { contextBridge, ipcRenderer } from 'electron'
import type { ConversationLabelApi } from '../shared/conversation-labels'
import type { MarkdownExportApi } from '../shared/markdown-export'
import type { ObsidianExportApi } from '../shared/obsidian-export'
import type { CollectionDesktopApi } from '../shared/collections'
import type { KeywordRadarDesktopApi } from '../shared/keyword-radar'
import type { TodayKeywordInterestApi } from '../shared/today-keyword-interest'
import type { CommitmentDesktopApi } from '../shared/commitment'
import type { CandidateEvidence, ChatQueryResponse, ConnectorSetupResult, DailyBriefItem, DashboardSummary, FeedbackExportResult, FeedbackState, FirstUseStatus, ImportResult, MessageContext, TopicEvidence, TopicRadarSummary } from '../shared/models'

contextBridge.exposeInMainWorld('privateRadar', {
  obsidianExport: {
    settings: () => ipcRenderer.invoke('obsidian-export:settings'),
    chooseVault: () => ipcRenderer.invoke('obsidian-export:choose-vault'),
    start: request => ipcRenderer.invoke('obsidian-export:start', request),
    cancel: () => ipcRenderer.invoke('obsidian-export:cancel'),
    openOutput: () => ipcRenderer.invoke('obsidian-export:open-output')
  } satisfies ObsidianExportApi,
  markdownExport: {
    listConversations: () => ipcRenderer.invoke('markdown-export:conversations'),
    chooseDirectory: () => ipcRenderer.invoke('markdown-export:choose-directory'),
    start: request => ipcRenderer.invoke('markdown-export:start', request),
    cancel: () => ipcRenderer.invoke('markdown-export:cancel'),
    openOutput: () => ipcRenderer.invoke('markdown-export:open-output')
  } satisfies MarkdownExportApi,
  conversationLabels: {
    listConversations: () => ipcRenderer.invoke('conversation-labels:list'),
    setConversationLabel: (id: string, label: string | null) => ipcRenderer.invoke('conversation-labels:set', id, label)
  } satisfies ConversationLabelApi,
  ...({
    getTodayKeywordInterest: () => ipcRenderer.invoke('dashboard:keyword-interest')
  } satisfies TodayKeywordInterestApi),
  commitmentCandidates: {
    listCommitmentCandidates: () => ipcRenderer.invoke('commitment-candidates:list'),
    confirmCommitmentCandidate: (id: string) => ipcRenderer.invoke('commitment-candidates:confirm', id),
    ignoreCommitmentCandidate: (id: string) => ipcRenderer.invoke('commitment-candidates:ignore', id),
    getCommitmentCandidateContext: (id: string) => ipcRenderer.invoke('commitment-candidates:context', id),
    openCommitmentCandidateEvidence: (id: string) => ipcRenderer.invoke('commitment-candidates:open-evidence', id)
  } satisfies CommitmentDesktopApi,
  keywordRadar: {
    historicalRescan: {
      start: groupId => ipcRenderer.invoke('keyword-radar:rescan-start', groupId),
      status: groupId => ipcRenderer.invoke('keyword-radar:rescan-status', groupId),
      cancel: runId => ipcRenderer.invoke('keyword-radar:rescan-cancel', runId)
    },
    listGroups: () => ipcRenderer.invoke('keyword-radar:groups'),
    createGroup: (name: string) => ipcRenderer.invoke('keyword-radar:create-group', name),
    renameGroup: (id: string, name: string) => ipcRenderer.invoke('keyword-radar:rename-group', id, name),
    setGroupEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('keyword-radar:group-enabled', id, enabled),
    archiveGroup: (id: string) => ipcRenderer.invoke('keyword-radar:archive-group', id),
    addTerm: (id: string, term: string) => ipcRenderer.invoke('keyword-radar:add-term', id, term),
    setTermEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('keyword-radar:term-enabled', id, enabled),
    listRecentHits: (limit?: number) => ipcRenderer.invoke('keyword-radar:hits', limit),
    getStatusCounts: () => ipcRenderer.invoke('keyword-radar:status'),
    retryFailedRuns: () => ipcRenderer.invoke('keyword-radar:retry-failed'),
    getHitContext: (id: string) => ipcRenderer.invoke('keyword-radar:context', id),
    getHitSource: (id: string) => ipcRenderer.invoke('keyword-radar:source', id),
    openHitEvidence: (id: string) => ipcRenderer.invoke('keyword-radar:open-evidence', id)
  } satisfies KeywordRadarDesktopApi,
  ...({
    createCollection: (name: string) => ipcRenderer.invoke('collections:create', name),
    listCollections: () => ipcRenderer.invoke('collections:list'),
    getCollection: (id: string) => ipcRenderer.invoke('collections:get', id),
    listCollectionSessions: (id: string) => ipcRenderer.invoke('collections:sessions', id),
    completeCollection: (id: string) => ipcRenderer.invoke('collections:complete', id)
  } satisfies CollectionDesktopApi),
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
