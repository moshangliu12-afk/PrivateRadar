import type { DailyIntelligenceConfig } from './config'
import { analyzeDailyValueSignals } from './signals'
import type { DailyMessage, MessageFeatures } from './types'

const URL_PATTERN = /https?:\/\/[^\s，。；;!?！？]+/gi
const FILE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'mp4', 'mov', 'avi', 'mkv',
  'mp3', 'wav', 'm4a', 'aac', 'pdf', 'zip', 'rar', '7z', 'tar', 'gz',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'json'
])
const MEDIA_MARKERS = '(?:图片|文件|语音|视频)'
const PRODUCT_NAMES = /\b(?:GPT(?:-\d+(?:\.\d+)*)?|Claude(?:\s+Code)?|Ollama|Gemini|OpenAI|GitHub|DataNest|LocalLens)\b/i
const PASCAL_OR_ACRONYM_PRODUCT = /\b(?:[A-Z][a-z0-9-]*(?:[A-Z][A-Za-z0-9-]*|\d[A-Za-z0-9-]*)|[A-Z]{2,}[A-Z0-9-]*)\b/g
const VERSION_PATTERN = /\bv?\d+(?:\.\d+){1,3}\b/i

export function cleanMessageText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function isNoiseMessage(message: DailyMessage, config: DailyIntelligenceConfig): boolean {
  const text = cleanMessageText(message.content)
  const compact = text.replace(/[，,。.!！?？\s]/g, '')
  if (!text) return true
  if (isMediaPlaceholderOnly(text)) return true
  if (/^https?:\/\/[^\s]+$/i.test(text)) return true
  if (message.messageType.toLowerCase() === 'emoji') return true
  if (isOnlyEmojiOrPunctuation(text)) return true
  if (config.exactNoise.has(compact.toLowerCase())) return true
  if (config.noisePatterns.some((pattern) => pattern.test(text))) return true
  if (/^(早上好|上午好|下午好|晚上好|大家好)[,，！!。\s]/.test(text) && !config.highSignalPatterns.some((pattern) => pattern.test(text))) return true
  if (text.length <= config.shortMessageLength && !config.highSignalPatterns.some((pattern) => pattern.test(text))) return true
  return false
}

export function extractFeatures(message: DailyMessage, config: DailyIntelligenceConfig): MessageFeatures {
  const text = cleanMessageText(message.content)
  const links = Array.from(new Set([...message.links, ...(text.match(URL_PATTERN) ?? [])]))
  const domains = links.map(domainOf).filter(Boolean)
  const semanticText = removeFileNamesAndUrls(text)
  const valueSignals = analyzeDailyValueSignals(text)
  const hasLink = links.length > 0
  const hasGithub = domains.some((domain) => domain === 'github.com') || /\bgithub\b/i.test(text)
  const hasTrustedLink = domains.some((domain) => config.trustedDomains.has(domain))
  const rawProductOrVersion = hasProductOrVersionSignal(semanticText)
  const hasProductOrVersion = rawProductOrVersion && !valueSignals.opaqueTokenOnly && (valueSignals.verifiableChange || /发布|更新|上线|开源|公告|报名|截止|漏洞|修复|会议|报告|教程|文档|项目|工具/i.test(semanticText))
  const hasNumberOrDate = !valueSignals.opaqueTokenOnly && hasSemanticNumberOrDate(semanticText)
  const hasEventOrRelease = /发布|更新|上线|开源|公告|报名|截止|漏洞|修复|会议|发布会|报告/i.test(text)
  const hasFileOrResource = /文件|文档|教程|报告|资料|项目|仓库|代码|下载|PDF|CSV|JSON/i.test(text)
  // 这里只计入已经通过语义校验的信号，文件名中的扩展名、编号和随机串不能叠加为“信息密集”。
  const meaningfulSignals = [hasLink, hasGithub, hasProductOrVersion, hasNumberOrDate, hasEventOrRelease, hasFileOrResource].filter(Boolean).length
  const informationDense = meaningfulSignals >= 2 || (meaningfulSignals >= 1 && semanticText.length >= 28)
  return {
    hasLink,
    hasTrustedLink,
    hasGithub,
    hasProductOrVersion,
    hasNumberOrDate,
    hasEventOrRelease,
    hasFileOrResource,
    hasExplicitObject: valueSignals.hasExplicitObject,
    actionRequired: valueSignals.actionRequired,
    deadlineOrTimeSensitive: valueSignals.deadlineOrTimeSensitive,
    consequence: valueSignals.consequence,
    verifiableChange: valueSignals.verifiableChange,
    failureOrLoss: valueSignals.failureOrLoss,
    riskOrLimitation: valueSignals.riskOrLimitation,
    alternativeCost: valueSignals.alternativeCost,
    informationDense,
    meaningfulLength: text.length
  }
}

/** 仅有媒体标记及文件名时，没有可供 D1 判断的正文语义。 */
function isMediaPlaceholderOnly(text: string): boolean {
  const marker = new RegExp(`^[［【\\[]${MEDIA_MARKERS}[］】\\]]`, 'u')
  if (!marker.test(text)) return false
  const remainder = text.replace(marker, '').trim()
  if (!remainder || /^(?:…|\.\.\.)$/.test(remainder)) return true
  return isFileName(remainder.replace(/[，。；;!?！？]+$/u, ''))
}

function hasProductOrVersionSignal(text: string): boolean {
  if (PRODUCT_NAMES.test(text) || VERSION_PATTERN.test(text)) return true
  const tokens = text.match(PASCAL_OR_ACRONYM_PRODUCT) ?? []
  return tokens.some((token) => !isFileExtension(token) && !isDomainFragment(token, text))
}

function hasSemanticNumberOrDate(text: string): boolean {
  if (/今天|明天|今晚|本周|下周/.test(text)) return true
  if (/\b\d{4}[年\/-]\d{1,2}(?:[月\/-]\d{1,2}(?:日)?)?\b|\b\d{1,2}月\d{1,2}日?\b/.test(text)) return true
  if (/\bv?\d+(?:\.\d+){1,3}\b/i.test(text)) return true
  if (/[¥￥$]\s*\d+|\d+(?:\.\d+)?\s*(?:元|万|亿|%|人|条|个|天|小时|分钟|次|MB|GB|TB|公里|米)/i.test(text)) return true
  if (/(?:涨到|降到|达到|超过|约|共|已有)\s*\d{2,}/.test(text)) return true
  return /(?<![A-Za-z])\d{3,}(?![A-Za-z])/.test(text)
}

function removeFileNamesAndUrls(text: string): string {
  const withoutUrls = text.replace(URL_PATTERN, ' ')
  return withoutUrls.replace(/(?:^|\s)[^\s]+\.(?:[A-Za-z0-9]{1,5})(?=$|\s|[，。；;!?！？])/g, (value) => {
    const fileName = value.trim()
    return isFileName(fileName) ? ' ' : value
  })
}

function isFileName(value: string): boolean {
  const match = value.match(/\.([A-Za-z0-9]{1,5})$/)
  return Boolean(match && FILE_EXTENSIONS.has(match[1].toLowerCase()))
}

function isFileExtension(value: string): boolean {
  return FILE_EXTENSIONS.has(value.toLowerCase())
}

function isDomainFragment(token: string, text: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`https?:\\/\\/[^\\s/]*${escaped}`, 'i').test(text)
}

export function canonicalUrls(message: DailyMessage): string[] {
  const urls = Array.from(new Set([...message.links, ...(message.content.match(URL_PATTERN) ?? [])]))
  return urls.map((value) => {
    try {
      const url = new URL(value)
      url.hash = ''
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) url.searchParams.delete(key)
      return url.toString()
    } catch {
      return value
    }
  })
}

function domainOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function isOnlyEmojiOrPunctuation(value: string): boolean {
  return !/[\p{L}\p{N}]/u.test(value)
}
