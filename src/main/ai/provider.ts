export interface StructuredAIRequest<T = unknown> {
  task: string
  systemPrompt: string
  input: T
}

export interface AIProvider {
  readonly id: string
  readonly model: string
  generateStructured(request: StructuredAIRequest): Promise<string>
}

