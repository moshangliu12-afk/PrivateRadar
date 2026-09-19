import { MockEmbeddingProvider } from './mock-provider'
import { OpenAICompatibleEmbeddingProvider } from './openai-compatible-provider'
import type { EmbeddingProvider } from './provider'

type Environment = Record<string, string | undefined>

export function resolveEmbeddingProvider(environment: Environment = process.env): EmbeddingProvider | null {
  if (environment.PRIVATE_RADAR_EMBEDDING_PROVIDER === 'mock') return new MockEmbeddingProvider()
  const baseUrl = environment.PRIVATE_RADAR_EMBEDDING_BASE_URL?.trim()
  const apiKey = environment.PRIVATE_RADAR_EMBEDDING_API_KEY?.trim()
  const model = environment.PRIVATE_RADAR_EMBEDDING_MODEL?.trim()
  if (!baseUrl || !apiKey || !model) return null
  const dimensions = Number(environment.PRIVATE_RADAR_EMBEDDING_DIMENSIONS) || undefined
  return new OpenAICompatibleEmbeddingProvider({ baseUrl, apiKey, model, dimensions })
}

