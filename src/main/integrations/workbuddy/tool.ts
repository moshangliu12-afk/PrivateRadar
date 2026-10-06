import { McpServer } from '@modelcontextprotocol/server'
import type { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { ingestWorkBuddyMessages } from './ingest'
import { workBuddyIngestSchema, workBuddyResultSchema } from './validation'
import { registerWorkBuddyBatchTool, type WorkBuddyBatchToolOptions } from './batch-tool'

export function createWorkBuddyMcpServer(
  db: DatabaseSync,
  log?: (event: string, detail?: string) => void,
  batchOptions?: WorkBuddyBatchToolOptions
): McpServer {
  const server = new McpServer({ name: 'privateradar-workbuddy-adapter', version: '0.2.0-alpha.16.1' })
  server.registerTool(
    'privateradar_ingest_messages',
    {
      title: '写入 PrivateRadar 聊天消息',
      description: '微信聊天导入专用。调用前先检查源材料是否包含可逐条对应的原始时间；有则传 timestamp，无可靠时间才省略，不得猜测。用户要求导入时即可调用，群名缺失则省略，不要扫描代码或寻找脚本替代方案。成功后只需简短确认统计。',
      inputSchema: workBuddyIngestSchema,
      outputSchema: workBuddyResultSchema
    },
    async (input) => {
      const validationStarted = performance.now()
      const validated = workBuddyIngestSchema.parse(input)
      const validationMs = performance.now() - validationStarted
      const result = ingestWorkBuddyMessages(db, validated, validationMs)
      const output = {
        job_id: result.jobId,
        status: result.status,
        recognized_count: result.recognizedCount,
        imported_count: result.importedCount,
        duplicate_count: result.duplicateCount,
        updated_count: result.updatedCount,
        invalid_count: result.invalidCount,
        source_batch_id: result.sourceBatchId,
        import_mode: result.importMode,
        completeness_level: result.completenessLevel,
        content_status: result.contentStatus,
        conversation_status: result.conversationStatus,
        sender_status: result.senderStatus,
        timestamp_status: result.timestampStatus,
        timestamp_present_count: result.timestampPresentCount,
        timestamp_missing_count: result.timestampMissingCount,
        timestamp_invalid_count: result.timestampInvalidCount,
        capability_notice: result.capabilityNotice,
        timing_ms: {
          validation: result.timingMs.validationMs,
          adapter_prepare: result.timingMs.adapterPrepareMs,
          parse: result.timingMs.parseMs,
          normalize: result.timingMs.normalizeMs,
          dedupe: result.timingMs.dedupeMs,
          sqlite_insert_and_fts: result.timingMs.sqliteWriteAndFtsMs,
          fts_verification: result.timingMs.ftsVerificationMs,
          batch_and_import_job: result.timingMs.batchAndImportJobMs,
          rpc_handler: result.timingMs.rpcHandlerMs
        },
        errors: result.errors
      }
      log?.('INGEST_TIMING', JSON.stringify(output.timing_ms))
      return {
        content: [{ type: 'text', text: resultText(result) }],
        structuredContent: output
      }
    }
  )
  if (batchOptions) registerWorkBuddyBatchTool(server, db, batchOptions, log)
  return server
}

function resultText(result: ReturnType<typeof ingestWorkBuddyMessages>): string {
  const timestampParts = [`${result.timestampPresentCount} 条已识别`, `${result.timestampMissingCount} 条缺失`]
  if (result.timestampInvalidCount > 0) timestampParts.push(`${result.timestampInvalidCount} 条格式异常`)
  const timestampSummary = `时间：${timestampParts.join(' · ')}`
  if (result.status === 'failed') return `导入失败：${result.errors[0] ?? '消息未写入'}\n${timestampSummary}`
  const summary = `导入完成：新增 ${result.importedCount}，重复 ${result.duplicateCount}，更新 ${result.updatedCount}，无效 ${result.invalidCount}。`
  const metadataIncomplete = result.senderStatus !== 'confirmed' || result.timestampStatus !== 'confirmed'
  return metadataIncomplete ? `${summary}\n${timestampSummary}\n${result.capabilityNotice}` : `${summary}\n${timestampSummary}`
}
