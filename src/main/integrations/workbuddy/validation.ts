import { z } from 'zod'
import { collectionIdSchema } from '../../collections/repository'

export const provenanceSchema = z.enum(['source_native', 'user_supplied', 'inferred', 'unknown'])

export const workBuddyMessageSchema = z.object({
  platform: z.string().trim().min(1).optional().describe('来源平台，例如 wechat'),
  conversation_name: z.string().trim().min(1).optional().describe('群名或会话名称；缺失时不要补造'),
  conversation_name_source: provenanceSchema.optional().describe('群名来源；未声明时，有值按 user_supplied，缺失按 unknown'),
  sender_name: z.string().trim().min(1).optional().describe('发送人显示名；缺失时不要补造'),
  sender_name_source: provenanceSchema.optional().describe('发送人来源；未声明时，有值按 user_supplied，缺失按 unknown'),
  timestamp: z.string().trim().min(1).optional().describe('原始消息时间；缺失时不要使用当前时间代替'),
  timestamp_source: provenanceSchema.optional().describe('时间来源；源材料直接提供用 source_native，用户明确提供用 user_supplied，缺失按 unknown'),
  content: z.string().trim().min(1).optional().describe('原始消息正文，不得总结或改写；缺失时该条记为无效，不影响同批其他消息'),
  content_source: provenanceSchema.optional().describe('正文来源；默认 source_native'),
  source_message_id: z.string().trim().min(1).optional().describe('来源系统可靠消息 ID'),
  sender_marker: z.string().trim().min(1).optional().describe('来源中可区分发送人的原始标记，用于一次性 sender_mapping'),
  source_position: z.number().int().nonnegative().optional().describe('消息在原始分享中的零基顺序')
}).passthrough()

export const workBuddyBatchMetadataSchema = z.object({
  conversation_name: z.string().trim().min(1).optional().describe('本批消息统一群名或会话名'),
  conversation_name_source: provenanceSchema.optional().describe('群名来源；用户确认时填写 user_supplied'),
  approximate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('用户确认的大致日期，仅作批次元数据，不写入消息 timestamp'),
  approximate_date_source: provenanceSchema.optional().describe('大致日期来源；用户确认时填写 user_supplied'),
  sender_mapping: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional().describe('发送人原始标记到确认名称的一次性映射')
})

export const workBuddyIngestSchema = z.object({
  collection_id: z.never({ error: 'COLLECTION_NOT_SUPPORTED_FOR_SINGLE_IMPORT: 单卡导入暂不支持归集' }).optional()
    .describe('单卡不支持 Collection；提供此字段必须拒绝，不得忽略'),
  import_mode: z.enum(['quick', 'complete']).optional().describe('快速导入或完整导入；默认快速导入'),
  source_batch_id: z.string().trim().min(1).optional().describe('同一来源批次的稳定 ID；重复导入和补全时保持不变'),
  source_attachment_identity: z.string().trim().min(1).optional().describe('来源附件的稳定身份，例如附件哈希或原始分享 ID'),
  batch_metadata: workBuddyBatchMetadataSchema.optional().describe('一次确认后应用于整批消息的元数据'),
  messages: z.array(workBuddyMessageSchema).min(1).max(500).describe('按原始顺序排列的聊天消息，最多 500 条')
})

export const workBuddyBatchAttachmentSchema = z.object({
  source_zip_path: z.string().min(1).describe('本次输入明确提供的原始聊天 ZIP 绝对路径'),
  display_name: z.string().trim().min(1).max(255).optional(),
  source_hint: z.string().trim().min(1).max(500).optional(),
  import_mode: z.enum(['quick', 'complete']).optional(),
  batch_metadata: workBuddyBatchMetadataSchema.optional(),
  messages: z.array(workBuddyMessageSchema).min(1).max(500).describe('此附件自己的聊天消息，保持原始顺序')
})

export const workBuddyBatchIngestSchema = z.object({
  attachments: z.array(workBuddyBatchAttachmentSchema).length(2).describe('同一次输入的两个独立聊天附件')
})

// 限制原始序列化的资源占用；独立附件数量由 Current Input Gate 判断。
export const WORKBUDDY_CURRENT_CONTEXT_LIMITS = Object.freeze({
  maxRawContexts: 16,
  maxTranscriptCharacters: 256 * 1024,
  maxTotalTranscriptBytes: 4 * 1024 * 1024
})

export const workBuddyCurrentContextSchema = z.strictObject({
  file: z.string().min(1).max(255).describe('当前卡片原始显示文件名，仅作展示，不用于推导路径'),
  extracted_dir_path: z.string().min(1).max(4096).describe('当前卡片明确提供的解压目录绝对路径'),
  message_count: z.number().int().min(1).max(500),
  transcript: z.string().min(1).max(WORKBUDDY_CURRENT_CONTEXT_LIMITS.maxTranscriptCharacters)
    .describe('当前卡片完整 inline transcript，按传输协议解码一次，保留发送人、正文、换行与顺序'),
  first_sender: z.string().min(1).max(4096).optional(),
  first_message_at: z.string().min(1).max(128).optional(),
  truncated: z.boolean().optional().describe('明确截断时必须为 true；缺失沿用当前 Gate 契约')
})

export const workBuddyCurrentContextBatchSchema = z.strictObject({
  mode: z.literal('current_context'),
  collection_id: collectionIdSchema.optional().describe('仅双卡支持归集；只转交本次用户明确提供的完整 Collection UUID，单卡提供此字段必须拒绝'),
  contexts: z.array(workBuddyCurrentContextSchema).min(1).max(WORKBUDDY_CURRENT_CONTEXT_LIMITS.maxRawContexts)
    .describe('同一次当前输入的原始上下文，不由 Agent 去重；归组后必须是一个或两个逻辑附件，总正文最多 4 MiB UTF-8')
}).refine((input) => input.contexts.reduce((total, block) => total + Buffer.byteLength(block.transcript, 'utf8'), 0)
  <= WORKBUDDY_CURRENT_CONTEXT_LIMITS.maxTotalTranscriptBytes, '当前输入正文总字节数超限')

export const workBuddyBatchResultSchema = z.object({
  batch_session_id: z.string(),
  session_id: z.string(),
  collection_id: collectionIdSchema.nullable(),
  status: z.enum(['pending', 'preparing', 'in_progress', 'success', 'partial_success', 'failed']),
  summary: z.object({
    attachments_total: z.number().int(),
    attachments_completed: z.number().int(),
    input_messages_total: z.number().int().nullable(),
    imported_total: z.number().int(),
    duplicate_total: z.number().int(),
    updated_total: z.number().int(),
    invalid_total: z.number().int(),
    failed_attachments: z.number().int(),
    attention_required_attachments: z.number().int()
  }),
  items: z.array(z.object({
    item_id: z.string(),
    ordinal: z.number().int(),
    status: z.enum(['pending', 'preparing', 'in_progress', 'success', 'partial_success', 'failed']),
    outcome: z.enum(['success', 'failed_zero_write', 'needs_attention', 'pending', 'processing']),
    attachment_identity: z.string().nullable(),
    evidence_relative_path: z.string().nullable(),
    snapshot_relative_path: z.string().nullable(),
    source_batch_id: z.string().nullable(),
    effective_job_id: z.string().nullable(),
    job_status: z.string().nullable(),
    imported: z.number().int(),
    duplicate: z.number().int(),
    updated: z.number().int(),
    invalid: z.number().int(),
    error_summary: z.string().nullable(),
    errors: z.array(z.string())
  })).min(1).max(2)
})

export const workBuddyResultSchema = z.object({
  job_id: z.string(),
  status: z.enum(['success', 'partial', 'failed', 'cancelled']),
  recognized_count: z.number().int().nonnegative(),
  imported_count: z.number().int().nonnegative(),
  duplicate_count: z.number().int().nonnegative(),
  updated_count: z.number().int().nonnegative(),
  invalid_count: z.number().int().nonnegative(),
  source_batch_id: z.string(),
  import_mode: z.enum(['quick', 'complete']),
  completeness_level: z.enum(['content_only', 'conversation_known', 'approximate_time_known', 'sender_known', 'complete']),
  content_status: z.enum(['complete', 'partial']),
  conversation_status: z.enum(['confirmed', 'missing']),
  sender_status: z.enum(['confirmed', 'missing']),
  timestamp_status: z.enum(['confirmed', 'approximate', 'missing']),
  timestamp_present_count: z.number().int().nonnegative(),
  timestamp_missing_count: z.number().int().nonnegative(),
  timestamp_invalid_count: z.number().int().nonnegative(),
  capability_notice: z.string(),
  timing_ms: z.object({
    validation: z.number().nonnegative(),
    adapter_prepare: z.number().nonnegative(),
    parse: z.number().nonnegative(),
    normalize: z.number().nonnegative(),
    dedupe: z.number().nonnegative(),
    sqlite_insert_and_fts: z.number().nonnegative(),
    fts_verification: z.number().nonnegative(),
    batch_and_import_job: z.number().nonnegative(),
    rpc_handler: z.number().nonnegative()
  }),
  errors: z.array(z.string())
})

export type WorkBuddyMessageInput = z.infer<typeof workBuddyMessageSchema>
export type WorkBuddyIngestInput = z.infer<typeof workBuddyIngestSchema>
export type WorkBuddyBatchIngestInput = z.infer<typeof workBuddyBatchIngestSchema>
export type WorkBuddyBatchResult = z.infer<typeof workBuddyBatchResultSchema>
export type WorkBuddyBatchMetadataInput = z.infer<typeof workBuddyBatchMetadataSchema>
export type WorkBuddyCompletenessLevel = z.infer<typeof workBuddyResultSchema>['completeness_level']
