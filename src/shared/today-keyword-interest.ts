import type { KeywordHitSource, KeywordOccurrenceView, KeywordRadarResult } from './keyword-radar'

export interface TodayKeywordInterestMatch {
  hitId: string
  groupId: string
  termId: string
  term: string
}
export interface TodayKeywordInterestItem extends KeywordOccurrenceView {
  batchItemId: string
  sourcePosition: number
  chatTimestamp: string
  representativeHitId: string
  matchedTerms: string[]
  matches: TodayKeywordInterestMatch[]
  source: KeywordHitSource & { batchItemId: string; ordinal: number; evidenceKind: 'zip' | 'directory' }
}
export interface TodayKeywordInterest {
  todayDate: string
  items: TodayKeywordInterestItem[]
}
export interface TodayKeywordInterestApi {
  getTodayKeywordInterest: () => Promise<KeywordRadarResult<TodayKeywordInterest>>
}
