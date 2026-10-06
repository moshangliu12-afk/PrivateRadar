import type { RulesSnapshot, MatchedTermsSnapshot } from './contracts'
import { normalizeKeywordMatchTextV1 } from './normalization'

export interface KeywordSnapshotMatch {
  group_id: string
  group_name: string
  matched_terms: MatchedTermsSnapshot
}
/** 调用方验证冻结快照；这里只做确定性包含匹配，保留快照中的组和词顺序。 */
export function matchKeywordSnapshot(body: string, rules: RulesSnapshot): KeywordSnapshotMatch[] {
  const normalized = normalizeKeywordMatchTextV1(body)
  const matches: KeywordSnapshotMatch[] = []
  for (const group of rules.groups) {
    const terms = group.terms.filter(term => normalized.includes(term.normalized_term))
    if (terms.length > 0) matches.push({
      group_id: group.group_id, group_name: group.group_name,
      matched_terms: { snapshot_version: 1, terms }
    })
  }
  return matches
}
