export interface EmbeddingProvider {
  readonly id: string
  readonly model: string
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}

