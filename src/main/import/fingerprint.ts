import { createHash } from 'node:crypto'
import type { StandardMessage } from '../../shared/models'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function normalizeFingerprintText(value: string): string {
  return value.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

export function createMessageFingerprint(message: StandardMessage): string {
  return hash([
    'private-radar-fingerprint-v1',
    message.platform.trim().toLowerCase(),
    normalizeFingerprintText(message.conversationName).toLowerCase(),
    normalizeFingerprintText(message.senderName).toLowerCase(),
    message.timestamp,
    normalizeFingerprintText(message.content)
  ].join('\u001f'))
}

export function createStableMessageIdentity(input: {
  platform: string
  sourceMessageId: string | null
  sourceBatchId: string
  sourcePosition: number
  content: string
}): string {
  const parts = input.sourceMessageId
    ? ['private-radar-identity-v1', input.platform.trim().toLowerCase(), 'source-message-id', normalizeFingerprintText(input.sourceMessageId)]
    : [
        'private-radar-identity-v1',
        input.platform.trim().toLowerCase(),
        'batch-position-content',
        normalizeFingerprintText(input.sourceBatchId),
        String(input.sourcePosition),
        normalizeFingerprintText(input.content)
      ]
  return `identity:${hash(parts.join('\u001f'))}`
}

export function createIdentityFingerprint(stableIdentity: string): string {
  return hash(['private-radar-workbuddy-fingerprint-v1', stableIdentity].join('\u001f'))
}

export function createScopedId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${hash(parts.map(normalizeFingerprintText).join('\u001f')).slice(0, 32)}`
}
