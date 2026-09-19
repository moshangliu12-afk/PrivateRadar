import { createHash } from 'node:crypto'
import type { DailyCandidate } from '../../../shared/models'
import { canonicalUrls, cleanMessageText, extractFeatures, isNoiseMessage } from './clean'
import { DEFAULT_DAILY_CONFIG, type DailyIntelligenceConfig } from './config'
import { importanceScore, messageInformationScore } from './importance-score'
import { extractEntityKeys, shouldMerge, similarityTokens, tokenSetSimilarity } from './similarity'
import type { CandidateCluster, DailyMessage, DailyPipelineResult, MessageFeatures } from './types'

// v1.2：D1 特征不变；最终 Daily 由独立的 Daily Value 层决定展示与排序。
export const DAILY_ALGORITHM_VERSION = 'daily-candidate-v1.2-daily-value'

export function buildDailyCandidates(
  messages: DailyMessage[],
  date: string,
  historicalMessages: DailyMessage[] = [],
  config: DailyIntelligenceConfig = DEFAULT_DAILY_CONFIG
): DailyPipelineResult {
  const ordered = [...messages].sort(compareMessages)
  const useful = ordered.filter((message) => !isNoiseMessage(message, config))
  const clusters: CandidateCluster[] = []
  const urlIndex = new Map<string, CandidateCluster>()
  const entityIndex = new Map<string, CandidateCluster>()

  for (const message of useful) {
    const urls = canonicalUrls(message)
    const entities = [...extractEntityKeys(message.content, config)]
    const indexed = urls.map((url) => urlIndex.get(url)).find(Boolean) ?? entities.map((key) => entityIndex.get(key)).find(Boolean)
    const recent = clusters.slice(-24).reverse()
    const existing = indexed ?? recent.find((cluster) => shouldMerge(cluster, message, config))
    if (existing) {
      addToCluster(existing, message, config)
      for (const url of existing.canonicalUrls) urlIndex.set(url, existing)
      for (const key of existing.entityKeys) entityIndex.set(key, existing)
    } else {
      const cluster = createCluster(message, config)
      clusters.push(cluster)
      for (const url of cluster.canonicalUrls) urlIndex.set(url, cluster)
      for (const key of cluster.entityKeys) entityIndex.set(key, cluster)
    }
  }

  attachExplicitReplies(clusters, ordered, config)
  const historicalLookup = buildHistoricalLookup(historicalMessages, config)

  const candidates = clusters
    .map((cluster) => candidateFromCluster(cluster, date, historicalLookup, config))
    .filter((candidate) => candidate.importanceScore >= config.minimumScore)
    .sort((left, right) =>
      right.importanceScore - left.importanceScore ||
      left.firstSeenAt.localeCompare(right.firstSeenAt) ||
      left.candidateId.localeCompare(right.candidateId)
    )
    .slice(0, config.topLimit)

  return { date, totalMessages: ordered.length, filteredNoise: ordered.length - useful.length, candidates }
}

function createCluster(message: DailyMessage, config: DailyIntelligenceConfig): CandidateCluster {
  return {
    messages: [message],
    representative: message,
    features: extractFeatures(message, config),
    canonicalUrls: new Set(canonicalUrls(message)),
    entityKeys: extractEntityKeys(message.content, config)
  }
}

function addToCluster(cluster: CandidateCluster, message: DailyMessage, config: DailyIntelligenceConfig): void {
  if (cluster.messages.some((item) => item.id === message.id)) return
  cluster.messages.push(message)
  const features = extractFeatures(message, config)
  cluster.features = mergeFeatures(cluster.features, features)
  for (const url of canonicalUrls(message)) cluster.canonicalUrls.add(url)
  for (const key of extractEntityKeys(message.content, config)) cluster.entityKeys.add(key)
  const currentScore = messageInformationScore(extractFeatures(cluster.representative, config))
  const nextScore = messageInformationScore(features)
  if (nextScore > currentScore || (nextScore === currentScore && compareMessages(message, cluster.representative) < 0)) {
    cluster.representative = message
  }
}

function attachExplicitReplies(clusters: CandidateCluster[], allMessages: DailyMessage[], config: DailyIntelligenceConfig): void {
  const sourceToCluster = new Map<string, CandidateCluster>()
  for (const cluster of clusters) for (const message of cluster.messages) sourceToCluster.set(message.id, cluster)
  for (const message of allMessages) {
    if (!message.replyTo) continue
    const cluster = sourceToCluster.get(message.replyTo)
    if (cluster) addToCluster(cluster, message, config)
  }
}

function candidateFromCluster(
  cluster: CandidateCluster,
  date: string,
  history: HistoricalLookup,
  config: DailyIntelligenceConfig
): DailyCandidate {
  cluster.messages.sort(compareMessages)
  const conversationIds = unique(cluster.messages.filter((message) => message.conversationKnown !== false).map((message) => message.conversationId))
  const senderIds = unique(cluster.messages.filter((message) => message.senderKnown !== false).map((message) => message.senderId))
  const hasHighDiscussion = cluster.messages.length >= 3 && senderIds.length >= 3
  const isNewTopic = !hasHistoricalMatch(cluster, history, config)
  const scored = importanceScore({
    features: cluster.features,
    messageCount: cluster.messages.length,
    conversationCount: conversationIds.length,
    senderCount: senderIds.length,
    hasHighDiscussion,
    isNewTopic
  })
  const sourceMessageIds = cluster.messages.map((message) => message.id)
  const candidateId = deterministicId(date, sourceMessageIds)
  return {
    candidateId,
    date,
    title: ruleTitle(cluster, config),
    representativeText: cleanMessageText(cluster.representative.content).slice(0, 240),
    importanceScore: scored.score,
    sourceMessageIds,
    sourceConversationIds: conversationIds,
    sourceSenderIds: senderIds,
    messageCount: sourceMessageIds.length,
    conversationCount: conversationIds.length,
    firstSeenAt: cluster.messages[0].timestamp,
    lastSeenAt: cluster.messages.at(-1)!.timestamp,
    reasonCodes: scored.reasonCodes
  }
}

interface HistoricalDescriptor {
  message: DailyMessage
  urls: Set<string>
  entities: Set<string>
  tokens: Set<string>
}

interface HistoricalLookup {
  urls: Map<string, HistoricalDescriptor[]>
  entities: Map<string, HistoricalDescriptor[]>
  tokens: Map<string, Set<HistoricalDescriptor>>
}

function buildHistoricalLookup(messages: DailyMessage[], config: DailyIntelligenceConfig): HistoricalLookup {
  const lookup: HistoricalLookup = { urls: new Map(), entities: new Map(), tokens: new Map() }
  for (const message of messages) {
    const descriptor: HistoricalDescriptor = {
      message,
      urls: new Set(canonicalUrls(message)),
      entities: extractEntityKeys(message.content, config),
      tokens: similarityTokens(message.content)
    }
    for (const url of descriptor.urls) appendMapArray(lookup.urls, url, descriptor)
    for (const entity of descriptor.entities) appendMapArray(lookup.entities, entity, descriptor)
    for (const token of descriptor.tokens) {
      const values = lookup.tokens.get(token) ?? new Set<HistoricalDescriptor>()
      values.add(descriptor)
      lookup.tokens.set(token, values)
    }
  }
  return lookup
}

function hasHistoricalMatch(cluster: CandidateCluster, lookup: HistoricalLookup, config: DailyIntelligenceConfig): boolean {
  for (const url of cluster.canonicalUrls) if ((lookup.urls.get(url)?.length ?? 0) > 0) return true
  for (const entity of cluster.entityKeys) if ((lookup.entities.get(entity)?.length ?? 0) > 0) return true

  const representativeTokens = similarityTokens(cluster.representative.content)
  const possible = new Set<HistoricalDescriptor>()
  for (const token of representativeTokens) {
    for (const descriptor of lookup.tokens.get(token) ?? []) possible.add(descriptor)
  }
  for (const descriptor of possible) {
    if (cluster.canonicalUrls.size > 0 && descriptor.urls.size > 0) continue
    if (tokenSetSimilarity(representativeTokens, descriptor.tokens) >= config.similarityThreshold) return true
  }
  return false
}

function appendMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? []
  values.push(value)
  map.set(key, values)
}

function ruleTitle(cluster: CandidateCluster, config: DailyIntelligenceConfig): string {
  const github = [...cluster.entityKeys].find((key) => key.startsWith('github:'))
  if (github) return `GitHub 项目：${github.slice('github:'.length)}`
  for (const alias of config.entityAliases) {
    if (cluster.entityKeys.has(alias.key)) return `${alias.label}相关信息`
  }
  const content = cleanMessageText(cluster.representative.content).replace(/https?:\/\/\S+/g, '').trim()
  const firstSentence = content.split(/[。！？!?\n]/).find((part) => part.trim().length >= 4) ?? content
  return firstSentence.slice(0, 34) || '链接与资料'
}

function mergeFeatures(left: MessageFeatures, right: MessageFeatures): MessageFeatures {
  return {
    hasLink: left.hasLink || right.hasLink,
    hasTrustedLink: left.hasTrustedLink || right.hasTrustedLink,
    hasGithub: left.hasGithub || right.hasGithub,
    hasProductOrVersion: left.hasProductOrVersion || right.hasProductOrVersion,
    hasNumberOrDate: left.hasNumberOrDate || right.hasNumberOrDate,
    hasEventOrRelease: left.hasEventOrRelease || right.hasEventOrRelease,
    hasFileOrResource: left.hasFileOrResource || right.hasFileOrResource,
    informationDense: left.informationDense || right.informationDense,
    meaningfulLength: Math.max(left.meaningfulLength, right.meaningfulLength)
  }
}

function deterministicId(date: string, sourceIds: string[]): string {
  const digest = createHash('sha256')
    .update([DAILY_ALGORITHM_VERSION, date, ...[...sourceIds].sort()].join('\u001f'))
    .digest('hex')
    .slice(0, 32)
  return `daily:${date}:${digest}`
}

function compareMessages(left: DailyMessage, right: DailyMessage): number {
  return left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
