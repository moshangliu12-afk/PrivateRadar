import type { KeywordRadarResult } from './keyword-radar'

export interface HistoricalRescanState {
  id: string; groupId: string; status: 'running' | 'complete' | 'failed' | 'cancelled'
  scannedMessages: number; totalMessages: number; matchedHits: number; newHits: number; existingHits: number; removedHits: number
  startedAt: string; finishedAt: string | null; error: string | null
}
export interface HistoricalRescanApi {
  start: (groupId: string) => Promise<KeywordRadarResult<HistoricalRescanState>>
  status: (groupId: string) => Promise<KeywordRadarResult<HistoricalRescanState | null>>
  cancel: (runId: string) => Promise<KeywordRadarResult<null>>
}
