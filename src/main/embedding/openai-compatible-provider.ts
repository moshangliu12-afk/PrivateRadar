import type { EmbeddingProvider } from './provider'

interface OpenAIEmbeddingOptions {
  baseUrl: string
  apiKey: string
  model: string
  dimensions?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai-compatible-embedding'
  readonly model: string
  readonly dimensions: number
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAIEmbeddingOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.model = options.model
    this.dimensions = options.dimensions ?? 1536
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`Embedding 服务返回状态 ${response.status}`)
      const payload = await response.json() as { data?: Array<{ index?: number; embedding?: unknown }> }
      if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error('Embedding 返回数量不一致')
      const ordered = [...payload.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      const vectors = ordered.map((item) => {
        if (!Array.isArray(item.embedding) || !item.embedding.every((value) => typeof value === 'number')) {
          throw new Error('Embedding 向量格式无效')
        }
        return item.embedding as number[]
      })
      if (vectors.some((vector) => vector.length !== vectors[0].length)) throw new Error('Embedding 向量维度不一致')
      return vectors
    } finally {
      clearTimeout(timer)
    }
  }
}

