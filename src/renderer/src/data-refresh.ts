import type { DashboardSummary, FirstUseStatus, TopicRadarSummary } from '../../shared/models'

export interface RefreshApi {
  getDashboardSummary: (date?: string) => Promise<DashboardSummary>
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

export async function refreshAfterExternalImport(api: RefreshApi, radarIsOpen: boolean, date?: string): Promise<ExternalImportRefresh> {
  const summary = await api.getDashboardSummary(date)
  const radar = radarIsOpen ? await api.getTopicRadarSummary() : null
  return { summary, radar }
}

export function loadDaily(api: Pick<RefreshApi, 'getDashboardSummary'>, date?: string): Promise<DashboardSummary> {
  return api.getDashboardSummary(date)
}

export function senderCountLabel(count: number): number | string {
  return count > 0 ? count : '发送者未知'
}
