import type { DashboardSummary, FirstUseStatus, TopicRadarSummary } from '../../shared/models'

export interface RefreshApi {
  getDashboardSummary: () => Promise<DashboardSummary>
  getTopicRadarSummary: () => Promise<TopicRadarSummary>
  askChat?: (question: string) => Promise<unknown>
}

export async function refreshSubmittedSearch<T>(api: { askChat: (question: string) => Promise<T> }, question: string): Promise<T | null> {
  const normalized = question.trim()
  return normalized ? api.askChat(normalized) : null
}

export interface ExternalImportRefresh {
  summary: DashboardSummary
  radar: TopicRadarSummary | null
}

export function isCompletedDataImport(status: FirstUseStatus): boolean {
  return status.latestImport?.status === 'success' || status.latestImport?.status === 'partial'
}

export async function refreshAfterExternalImport(api: RefreshApi, radarIsOpen: boolean): Promise<ExternalImportRefresh> {
  const summary = await api.getDashboardSummary()
  const radar = radarIsOpen ? await api.getTopicRadarSummary() : null
  return { summary, radar }
}

export function loadLatestDaily(api: Pick<RefreshApi, 'getDashboardSummary'>): Promise<DashboardSummary> {
  return api.getDashboardSummary()
}

export function senderCountLabel(count: number): number | string {
  return count > 0 ? count : '发送者未知'
}
