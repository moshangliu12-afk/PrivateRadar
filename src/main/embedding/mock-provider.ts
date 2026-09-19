import { createHash } from 'node:crypto'
import type { EmbeddingProvider } from './provider'

const DIMENSIONS = 64

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'mock-embedding'
  readonly model = 'private-radar-semantic-demo'
  readonly dimensions = DIMENSIONS
  callCount = 0

  async embed(texts: string[]): Promise<number[][]> {
    this.callCount += 1
    return texts.map(mockVector)
  }
}

export function mockVector(text: string): number[] {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g, ' ')
  const tokens = new Map<string, number>()
  for (const word of normalized.match(/[a-z][a-z0-9.-]{1,}|[\p{Script=Han}]{2,}/gu) ?? []) {
    tokens.set(word, (tokens.get(word) ?? 0) + 1)
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      for (let index = 0; index < word.length - 1; index += 1) {
        const pair = word.slice(index, index + 2)
        tokens.set(pair, (tokens.get(pair) ?? 0) + 0.35)
      }
    }
  }
  for (const concept of semanticConcepts(normalized)) tokens.set(`概念:${concept}`, 6)
  const vector = Array.from({ length: DIMENSIONS }, () => 0)
  for (const [token, weight] of tokens) {
    const hash = createHash('sha256').update(token).digest()
    const index = hash.readUInt32BE(0) % DIMENSIONS
    const sign = hash[4] % 2 === 0 ? 1 : -1
    vector[index] += sign * weight
  }
  return normalize(vector)
}

function semanticConcepts(text: string): string[] {
  const concepts: string[] = []
  if (/公众号.{0,10}(排版|美化|编辑)|文章.{0,8}美化|markdown.{0,12}公众号|排公众号/.test(text)) concepts.push('wechat-layout')
  if (/微信小程序|小程序.{0,8}(项目|源码|github|开源)/.test(text)) concepts.push('wechat-miniprogram')
  if (/claude\s*code|claude.{0,5}编程|anthropic.{0,8}(coding|编程)|编程代理.{0,12}长任务|长任务.{0,12}编程/.test(text)) concepts.push('claude-code')
  if (/datanest|不用重新扫描|增量同步/.test(text)) concepts.push('datanest')
  if (/ollama|本地.{0,12}敏感资料|敏感资料.{0,12}本地/.test(text)) concepts.push('local-private-tool')
  if (/privateindex|private-index|本地.{0,8}聊天索引|聊天索引.{0,8}本地/.test(text)) concepts.push('private-index')
  if (/\b(?:claude|ollama|datanest|locallens|gpt)[\s\w.-]*|ai.{0,6}工具|编程工具/.test(text)) concepts.push('ai-tool')
  return concepts
}

function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / length)
}
