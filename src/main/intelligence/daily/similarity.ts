import type { DailyIntelligenceConfig } from './config'
import { canonicalUrls, cleanMessageText } from './clean'
import type { CandidateCluster, DailyMessage } from './types'

export function extractEntityKeys(text: string, config: DailyIntelligenceConfig): Set<string> {
  const keys = new Set<string>()
  for (const entity of config.entityAliases) {
    if (entity.patterns.some((pattern) => pattern.test(text))) keys.add(entity.key)
  }
  for (const url of text.match(/https?:\/\/[^\s，。；;!?！？]+/gi) ?? []) {
    try {
      const parsed = new URL(url)
      if (parsed.hostname.toLowerCase().replace(/^www\./, '') === 'github.com') {
        const parts = parsed.pathname.split('/').filter(Boolean).slice(0, 2)
        if (parts.length === 2) keys.add(`github:${parts.join('/').toLowerCase()}`)
      }
    } catch {
      // 无效链接不会成为实体依据。
    }
  }
  const genericProducts = text.match(/\b[A-Z][A-Za-z0-9.-]{2,}\b/g) ?? []
  const ignored = new Set(['GITHUB', 'MARKDOWN', 'HTTP', 'HTTPS', 'PDF', 'CSV', 'JSON', 'API'])
  for (const product of genericProducts) {
    if (!ignored.has(product.toUpperCase())) keys.add(`product:${product.toLowerCase()}`)
  }
  return keys
}

export function shouldMerge(cluster: CandidateCluster, message: DailyMessage, config: DailyIntelligenceConfig): boolean {
  const urls = new Set(canonicalUrls(message))
  if (urls.size > 0 && intersects(cluster.canonicalUrls, urls)) return true

  const entities = extractEntityKeys(message.content, config)
  if (entities.size > 0 && intersects(cluster.entityKeys, entities)) return true

  if (cluster.canonicalUrls.size > 0 && urls.size > 0) return false
  return textSimilarity(cluster.representative.content, message.content) >= config.similarityThreshold
}

export function textSimilarity(left: string, right: string): number {
  return tokenSetSimilarity(similarityTokens(left), similarityTokens(right))
}

export function tokenSetSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

export function similarityTokens(value: string): Set<string> {
  const normalized = cleanMessageText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
  const result = new Set<string>()
  if (normalized.length < 2) return result
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2))
  return result
}

function intersects<T>(left: Set<T>, right: Set<T>): boolean {
  for (const value of left) if (right.has(value)) return true
  return false
}
