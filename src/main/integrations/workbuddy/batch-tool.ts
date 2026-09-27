import { lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { McpServer } from '@modelcontextprotocol/server'
import { createBatchImportItem, createBatchImportSession, listBatchImportItems } from '../../batch-import/repository'
import { saveOriginalZip, saveStructuredSnapshot } from '../../batch-import/evidence'
import { executeBatchImportSession } from '../../batch-import/session'
import { workBuddyBatchIngestSchema, workBuddyBatchResultSchema,
  type WorkBuddyBatchIngestInput, type WorkBuddyBatchResult } from './validation'

export interface WorkBuddyBatchToolOptions {
  databasePath: string
  chatHistoryRoot?: string
}

export function registerWorkBuddyBatchTool(
  server: McpServer,
  db: DatabaseSync,
  options: WorkBuddyBatchToolOptions,
  log?: (event: string, detail?: string) => void
): void {
  server.registerTool(
    'privateradar_ingest_batch',
    {
      title: '批量写入 PrivateRadar 两个微信聊天附件',
      description: '仅接收当前同一次输入明确提供的两个真实聊天 ZIP 绝对路径及各自的消息数组；路径必须存在，不得扫描目录寻找文件。每个附件最多 500 条。群名与逐条时间缺失时省略，不得猜测。',
      inputSchema: workBuddyBatchIngestSchema,
      outputSchema: workBuddyBatchResultSchema
    },
    async (input) => {
      const output = await ingestWorkBuddyBatch(db, options, input)
      log?.('BATCH_INGEST_RESULT', JSON.stringify({ sessionId: output.batch_session_id, status: output.status }))
      return {
        content: [{ type: 'text', text: batchResultText(output) }],
        structuredContent: output
      }
    }
  )
}

export async function ingestWorkBuddyBatch(
  db: DatabaseSync,
  options: WorkBuddyBatchToolOptions,
  rawInput: unknown
): Promise<WorkBuddyBatchResult> {
  const input: WorkBuddyBatchIngestInput = workBuddyBatchIngestSchema.parse(rawInput)
  for (const attachment of input.attachments) {
    for (const [index, message] of attachment.messages.entries()) {
      if (message.source_position !== undefined && message.source_position !== index) {
        throw new Error(`附件消息第 ${index + 1} 条的原始位置与数组顺序不一致`)
      }
    }
  }
  const root = options.chatHistoryRoot ?? join(homedir(), '.workbuddy', 'app', 'tmp', 'chat-history')
  const sourcePaths = await Promise.all(input.attachments.map((attachment) =>
    validateWorkBuddyZipPath(attachment.source_zip_path, root)
  ))

  // 会话与两个附件项短事务登记；证据持久化及导入各自独立进行。
  db.exec('BEGIN IMMEDIATE')
  let sessionId: string
  try {
    const session = createBatchImportSession(db, 'workbuddy')
    sessionId = session.id
    for (const [index, attachment] of input.attachments.entries()) {
      createBatchImportItem(db, session.id, index,
        attachment.display_name ?? basename(sourcePaths[index]), null, attachment.source_hint ?? null)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const items = listBatchImportItems(db, sessionId)
  for (const [index, attachment] of input.attachments.entries()) {
    const item = items[index]
    try {
      await saveOriginalZip(db, options.databasePath, item.id, sourcePaths[index])
      await saveStructuredSnapshot(db, options.databasePath, item.id, {
        import_mode: attachment.import_mode,
        batch_metadata: attachment.batch_metadata,
        messages: attachment.messages
      })
    } catch (error) {
      // 已登记的附件项必须留在会话中，另一附件的证据和导入继续执行。
      const current = db.prepare('SELECT status FROM batch_import_items WHERE id = ?').get(item.id) as { status: string }
      if (current.status !== 'failed') {
        db.prepare(`
          UPDATE batch_import_items SET status = 'failed', evidence_status = 'error',
            error_summary = ?, updated_at = ?, completed_at = ? WHERE id = ?
        `).run(`证据保存失败：${errorMessage(error)}`, new Date().toISOString(), new Date().toISOString(), item.id)
      } else {
        db.prepare(`
          UPDATE batch_import_items SET completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?
        `).run(new Date().toISOString(), new Date().toISOString(), item.id)
      }
    }
  }

  const summary = await executeBatchImportSession(db, options.databasePath, sessionId)
  const finalItems = listBatchImportItems(db, sessionId)
  const output: WorkBuddyBatchResult = {
    batch_session_id: sessionId,
    status: summary.status,
    summary: {
      attachments_total: summary.attachments_total,
      attachments_completed: summary.attachments_completed,
      input_messages_total: summary.input_messages_total,
      imported_total: summary.imported_total,
      duplicate_total: summary.duplicate_total,
      updated_total: summary.updated_total,
      invalid_total: summary.invalid_total,
      failed_attachments: summary.failed_attachments,
      attention_required_attachments: summary.attention_required_attachments
    },
    items: summary.items.map((result, index) => {
      const item = finalItems[index]
      const job = item.effective_job_id ? db.prepare(`
        SELECT status, error_details_json FROM import_jobs WHERE id = ? AND batch_item_id = ?
      `).get(item.effective_job_id, item.id) as { status: string; error_details_json: string } | undefined : undefined
      return {
        item_id: item.id, ordinal: item.ordinal, status: item.status, outcome: result.outcome,
        attachment_identity: item.attachment_identity,
        evidence_relative_path: item.evidence_relative_path,
        snapshot_relative_path: item.snapshot_relative_path,
        source_batch_id: item.source_batch_id,
        effective_job_id: item.effective_job_id,
        job_status: job?.status ?? null,
        imported: result.imported, duplicate: result.duplicate,
        updated: result.updated, invalid: result.invalid,
        error_summary: item.error_summary,
        errors: job ? jobErrors(job.error_details_json) : []
      }
    })
  }
  return workBuddyBatchResultSchema.parse(output)
}

async function validateWorkBuddyZipPath(sourcePath: string, rootPath: string): Promise<string> {
  if (!isAbsolute(sourcePath) || sourcePath.split(/[\\/]+/).includes('..')) {
    throw new Error('原始 ZIP 必须是允许临时目录内、不含目录穿越的绝对路径')
  }
  if (!sourcePath.toLowerCase().endsWith('.zip')) throw new Error('原始聊天附件必须是 ZIP 文件')
  const root = resolve(rootPath)
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new Error('WorkBuddy 聊天临时根路径不是目录')
  const candidate = resolve(sourcePath)
  assertInside(root, candidate)
  const canonicalRoot = await realpath(root)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('当前附件真实路径不可用：原始 ZIP 不存在')
    }
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('原始 ZIP 路径不是普通文件')
  assertInside(canonicalRoot, await realpath(candidate))
  return candidate
}

function assertInside(root: string, target: string, allowRoot = false): void {
  const part = relative(root, target)
  if ((!part && !allowRoot) || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error('原始 ZIP 路径不在允许的 WorkBuddy 聊天临时根目录内')
  }
}

function jobErrors(serialized: string): string[] {
  try {
    const value: unknown = JSON.parse(serialized)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function batchResultText(result: WorkBuddyBatchResult): string {
  const summary = result.summary
  return `批量导入${result.status === 'success' ? '完成' : '结束'}：附件 ${summary.attachments_completed}/${summary.attachments_total}，新增 ${summary.imported_total}，重复 ${summary.duplicate_total}，更新 ${summary.updated_total}，无效 ${summary.invalid_total}，零写入失败 ${summary.failed_attachments}，需关注 ${summary.attention_required_attachments}。`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知证据保存错误'
}
