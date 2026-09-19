import { MockAIProvider } from './mock-provider'
import { OpenAICompatibleProvider } from './openai-compatible-provider'
import type { AIProvider } from './provider'

type Environment = Record<string, string | undefined>

export function resolveAIProvider(environment: Environment = process.env): AIProvider | null {
  if (environment.PRIVATE_RADAR_AI_PROVIDER === 'mock') return new MockAIProvider()
  const baseUrl = environment.PRIVATE_RADAR_AI_BASE_URL?.trim()
  const apiKey = environment.PRIVATE_RADAR_AI_API_KEY?.trim()
  const model = environment.PRIVATE_RADAR_AI_MODEL?.trim()
  if (!baseUrl || !apiKey || !model) return null
  return new OpenAICompatibleProvider({ baseUrl, apiKey, model })
}

