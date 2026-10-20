import { McpServer } from '@modelcontextprotocol/server'
import type { DatabaseSync } from 'node:sqlite'
import { workBuddyIngestSchema, workBuddyResultSchema } from './validation'
import { registerWorkBuddyBatchTool, type WorkBuddyBatchToolOptions } from './batch-tool'

export function createWorkBuddyMcpServer(
  db: DatabaseSync,
  log?: (event: string, detail?: string) => void,
  batchOptions?: WorkBuddyBatchToolOptions
): McpServer {
  const server = new McpServer({ name: 'privateradar-workbuddy-adapter', version: '0.2.0-alpha.22' })
  server.registerTool(
    'privateradar_ingest_messages',
    {
      title: '旧消息入口：需要原始来源',
      description: '此旧入口只接收结构化消息，缺少真实原始来源，所有调用均在写入前拒绝。请使用 privateradar_ingest_current_context_batch，原样传递本次平台提供的 raw/current contexts 和明确原始目录；不得扫描、猜测路径或降级为消息数组。',
      inputSchema: workBuddyIngestSchema,
      outputSchema: workBuddyResultSchema
    },
    // 保留公开工具名称用于稳定拒绝；真实快照导入仍复用内部适配器，不经过此入口。
    async () => ({
      isError: true,
      content: [{
        type: 'text',
        text: 'RAW_CURRENT_CONTEXT_REQUIRED: 该入口缺少真实原始来源，请使用 privateradar_ingest_current_context_batch 原样提交本次 raw/current contexts 和真实原始目录。'
      }]
    })
  )
  if (batchOptions) registerWorkBuddyBatchTool(server, db, batchOptions, log)
  return server
}
