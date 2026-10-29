import type { CanonicalExportSnapshot } from '../../shared/markdown-export'

/** 只投影公共快照，不查询数据库，也不导出内部表、原始 metadata 或机器证据路径。 */
export function renderChatJson(snapshot: CanonicalExportSnapshot, appVersion: string): Buffer {
  const attachments = new Map<string, typeof snapshot.attachments[number][]>()
  for (const item of snapshot.attachments) {
    const values = attachments.get(item.message_id) ?? []
    values.push(item); attachments.set(item.message_id, values)
  }
  return Buffer.from(JSON.stringify({
    exportVersion: 'json-v1', exportedAt: snapshot.selection.captured_at, appVersion,
    conversation: {
      id: snapshot.conversation.id, platform: snapshot.conversation.platform,
      sourceConversationName: snapshot.conversation.sourceConversationName,
      userConversationLabel: snapshot.conversation.userConversationLabel,
      displayConversationName: snapshot.conversation.displayConversationName
    },
    messageCount: snapshot.messages.length, range: snapshot.selection.range,
    timezone: snapshot.selection.timezone, excludedUnknownTimeCount: snapshot.selection.excluded_unknown_time_count,
    messages: snapshot.messages.map(message => ({
      id: message.id, conversationId: snapshot.conversation_id, platform: message.platform,
      sourceConversationName: ['source_native', 'user_supplied'].includes(message.conversation_name_source) && message.conversation_name?.trim() ? message.conversation_name : null,
      conversationNameSource: message.conversation_name_source,
      sender: { id: message.sender_id || null, name: message.sender_name, nameSource: message.sender_name_source },
      timestamp: message.canonical_timestamp, storedTimestamp: message.timestamp, timestampSource: message.timestamp_source,
      localDate: message.local_date, localTime: message.local_time,
      messageType: message.message_type, content: message.content, contentSource: message.content_source,
      replyTo: message.reply_to || null,
      source: { messageId: message.source_message_id || null, batchId: message.canonical_origin.source_batch_id || null, position: message.canonical_origin.source_position },
      evidenceStatus: message.evidence_status,
      attachments: (attachments.get(message.id) ?? []).map(item => ({ ordinal: item.ordinal, kind: item.kind, copied: item.copied, fileState: item.file_state }))
    })),
    sources: snapshot.sources.map(source => ({ id: source.id, batchId: source.source_batch_id,
      evidenceStatus: source.evidence_status, registeredStatus: source.registered_status,
      snapshotSha256: source.snapshot_sha256, evidenceSourceKind: source.evidence_source_kind })),
    evidence: { verification: snapshot.evidence.verification, isEvidenceBackup: snapshot.evidence.is_evidence_backup,
      occurrences: snapshot.evidence.occurrences.map(item => ({ messageId: item.message_id, sourceItemId: item.source_item_id, position: item.source_position,
        senderName: ['source_native', 'user_supplied'].includes(item.sender_name_source ?? '') && item.sender_name?.trim() ? item.sender_name : null, senderNameSource: item.sender_name_source,
        storedTimestamp: item.timestamp || null, timestampSource: item.timestamp_source,
        sourceConversationName: ['source_native', 'user_supplied'].includes(item.conversation_name_source ?? '') && item.conversation_name?.trim() ? item.conversation_name : null, conversationNameSource: item.conversation_name_source })) }
  }, null, 2) + '\n', 'utf8')
}
