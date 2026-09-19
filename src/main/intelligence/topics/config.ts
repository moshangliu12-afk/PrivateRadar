import type { TopicRadarConfig } from './types'

export const DEFAULT_TOPIC_RADAR_CONFIG: TopicRadarConfig = {
  historyDays: 7,
  topLimit: 20,
  minimumSignalScore: 8,
  similarityThreshold: 0.64
}

