import { createHash } from 'node:crypto'
import { canonicalUrls, cleanMessageText, extractFeatures, isNoiseMessage } from '../daily/clean'
import { DEFAULT_DAILY_CONFIG } from '../daily/config'
import { extractEntityKeys, textSimilarity } from '../daily/similarity'
import type { DailyMessage } from '../daily/types'
import type { TopicCluster, TopicRadarConfig } from './types'

const ISSUE_PATTERN = /崩溃|闪退|报错|错误|故障|无法启动|不能运行|失败|兼容(?:性)?问题|\bbug\b/i

export function recognizeTopicClusters(messages: DailyMessage[], config: TopicRadarConfig): TopicCluster[] {
  const clusters: TopicCluster[] = []
  const identityIndex = new Map<string, TopicCluster>()
  const ordered = [...messages].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))

  for (const message of ordered) {
    if (isNoiseMessage(message, DEFAULT_DAILY_CONFIG)) continue
    const descriptor = describeTopic(message)
    if (!descriptor) continue
    let cluster = identityIndex.get(descriptor.identity)
    if (!cluster && descriptor.identity.startsWith('text:')) {
      cluster = clusters.slice(-32).reverse().find((candidate) =>
        candidate.identity.startsWith('text:') &&
        textSimilarity(candidate.representative.content, message.content) >= config.similarityThreshold
      )
    }
    if (!cluster) {
      cluster = {
        identity: descriptor.identity,
        canonicalName: descriptor.canonicalName,
        aliases: new Set(descriptor.aliases),
        messages: [],
        representative: message
      }
      clusters.push(cluster)
      identityIndex.set(descriptor.identity, cluster)
    }
    if (!cluster.messages.some((item) => item.id === message.id)) cluster.messages.push(message)
    for (const alias of descriptor.aliases) cluster.aliases.add(alias)
    if (message.content.length > cluster.representative.content.length && message.content.length <= 240) cluster.representative = message
  }
  return clusters
}

function describeTopic(message: DailyMessage): { identity: string; canonicalName: string; aliases: string[] } | null {
  const text = cleanMessageText(message.content)
  const entityKeys = [...extractEntityKeys(text, DEFAULT_DAILY_CONFIG)]
  const primary = choosePrimaryEntity(entityKeys)
  const issueFacet = ISSUE_PATTERN.test(text) ? ':issue' : ':general'
  if (primary) {
    const canonicalName = entityName(primary, text) + (issueFacet === ':issue' ? '问题' : '')
    return {
      identity: `entity:${primary}${issueFacet}`,
      canonicalName,
      aliases: detectedAliases(primary, text, canonicalName)
    }
  }

  const urls = canonicalUrls(message)
  if (urls.length > 0) {
    const identityUrl = urls[0]
    return { identity: `url:${identityUrl}${issueFacet}`, canonicalName: urlName(identityUrl), aliases: [urlName(identityUrl)] }
  }

  const features = extractFeatures(message, DEFAULT_DAILY_CONFIG)
  if (!features.hasEventOrRelease && !features.hasFileOrResource && !features.hasProductOrVersion) return null
  const normalized = text.replace(/https?:\/\/\S+/g, '').trim()
  const name = normalized.split(/[。！？!?\n]/)[0].slice(0, 32) || '未命名话题'
  const identity = createHash('sha256').update(normalized.toLowerCase()).digest('hex').slice(0, 20)
  return { identity: `text:${identity}`, canonicalName: name, aliases: [name] }
}

function choosePrimaryEntity(keys: string[]): string | null {
  return keys.find((key) => key.startsWith('github:'))
    ?? keys.find((key) => !key.startsWith('product:'))
    ?? keys.find((key) => key.startsWith('product:'))
    ?? null
}

function entityName(key: string, text: string): string {
  if (key.startsWith('github:')) return key.slice('github:'.length)
  const configured = DEFAULT_DAILY_CONFIG.entityAliases.find((entity) => entity.key === key)
  if (configured) return configured.label
  const product = key.slice('product:'.length)
  const matched = text.match(new RegExp(`\\b${escapeRegExp(product)}\\b`, 'i'))?.[0]
  return matched ?? product
}

function detectedAliases(key: string, text: string, canonicalName: string): string[] {
  const aliases = new Set<string>([canonicalName])
  const configured = DEFAULT_DAILY_CONFIG.entityAliases.find((entity) => entity.key === key)
  if (configured) {
    for (const pattern of configured.patterns) {
      const match = text.match(pattern)?.[0]
      if (match) aliases.add(match)
    }
  }
  return [...aliases]
}

function urlName(value: string): string {
  try {
    const url = new URL(value)
    return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 56)
  } catch {
    return value.slice(0, 56)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

