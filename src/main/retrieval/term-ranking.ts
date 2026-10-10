export interface SearchTermSource {
  text: string
  kind: 'complete' | 'compound' | 'word'
  primary?: boolean
}

export interface RankedSearchTerm {
  text: string
  sourcePriority: number
  phrasePriority: number
  conditionalLength: number
  firstQueryIndex: number
}

export function compareStableText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function compareSearchTerms(left: RankedSearchTerm, right: RankedSearchTerm): number {
  const priority = right.sourcePriority - left.sourcePriority
    || right.phrasePriority - left.phrasePriority
    || right.conditionalLength - left.conditionalLength
  if (priority) return priority
  if (left.firstQueryIndex !== right.firstQueryIndex) return left.firstQueryIndex < right.firstQueryIndex ? -1 : 1
  return compareStableText(left.text, right.text)
}

export function rankSearchTerms(originalQuery: string, sources: SearchTermSource[]): RankedSearchTerm[] {
  const merged = new Map<string, RankedSearchTerm>()
  for (const source of sources) {
    if (source.text.length < 2) continue
    let candidate = merged.get(source.text)
    if (!candidate) {
      const index = originalQuery.indexOf(source.text)
      candidate = { text: source.text, sourcePriority: 0, phrasePriority: 0, conditionalLength: 0,
        firstQueryIndex: index < 0 ? Infinity : index }
      merged.set(source.text, candidate)
    }
    candidate.sourcePriority = Math.max(candidate.sourcePriority, source.primary ? 1 : 0)
    // 生成来源与原始查询连续匹配共同提供依据，字符串长度不能证明完整性。
    const quality = candidate.firstQueryIndex === Infinity ? 0
      : source.kind === 'complete' ? 2 : source.kind === 'compound' ? 1 : 0
    candidate.phrasePriority = Math.max(candidate.phrasePriority, quality)
    candidate.conditionalLength = candidate.phrasePriority > 0 ? candidate.text.length : 0
  }
  return [...merged.values()].sort(compareSearchTerms)
}
