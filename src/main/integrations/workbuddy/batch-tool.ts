import { lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { McpServer } from '@modelcontextprotocol/server'
import { createBatchImportItem, createBatchImportSession, listBatchImportItems } from '../../batch-import/repository'
import { saveOriginalZip, saveStructuredSnapshot, verifyBatchEvidence } from '../../batch-import/evidence'
import { saveDirectoryEvidence } from '../../batch-import/directory-evidence'
import { safeAbsolutePath, WindowsPathLease } from '../../batch-import/windows-path-lease'
import { executeBatchImportSession } from '../../batch-import/session'
import { gateWorkBuddyBatchCurrentInput, WorkBuddyCurrentInputError } from '../../import/workbuddy-current-input'
import { workBuddyBatchIngestSchema, workBuddyBatchResultSchema, workBuddyCurrentContextBatchSchema,
  workBuddyIngestSchema, type WorkBuddyIngestInput, type WorkBuddyBatchIngestInput, type WorkBuddyBatchResult } from './validation'

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
    'privateradar_ingest_current_context_batch',
    {
      title: '从当前卡片上下文批量写入 PrivateRadar',
      description: '接收当前同一次输入的原始卡片 contexts，不由 Agent 去重或生成 messages。使用明确 extracted_dir_path 保存目录证据，inline transcript 由确定性 Parser 解析。归组后必须恰好两个附件，每附件 1–500 条；路径缺失、截断或解析失败立即停止。不得扫描目录、猜测路径或补造时间。',
      inputSchema: workBuddyCurrentContextBatchSchema,
      outputSchema: workBuddyBatchResultSchema
    },
    async (input) => {
      const output = await ingestWorkBuddyCurrentContextBatch(db, options, input)
      log?.('CURRENT_CONTEXT_BATCH_RESULT', JSON.stringify({ sessionId: output.batch_session_id, status: output.status }))
      return { content: [{ type: 'text', text: batchResultText(output) }], structuredContent: output }
    }
  )
}

/**
 * legacy ZIP 批量入口只供内部兼容性测试和既有代码调用，不加入正式 MCP tools/list。
 */
export function registerWorkBuddyLegacyBatchTool(
  server: McpServer,
  db: DatabaseSync,
  options: WorkBuddyBatchToolOptions,
  log?: (event: string, detail?: string) => void
): void {
  server.registerTool(
    'privateradar_ingest_batch',
    {
      title: '批量写入 PrivateRadar 两个微信聊天附件',
      description: '兼容旧版 ZIP 批量输入，仅供内部调用。',
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
  const root = chatHistoryRoot(options)
  const sourcePaths = await Promise.all(input.attachments.map((attachment) =>
    validateWorkBuddyAttachmentPath(attachment.source_zip_path, root, 'zip')
  ))

  const sessionId = await prepareBatchAttachments(db, options, input.attachments.map((attachment, index) => ({
    sourceKind: 'zip', sourcePath: sourcePaths[index],
    displayName: attachment.display_name ?? basename(sourcePaths[index]), sourceHint: attachment.source_hint ?? null,
    input: { import_mode: attachment.import_mode, batch_metadata: attachment.batch_metadata, messages: attachment.messages }
  })))
  return executeAndReportBatch(db, options, sessionId)
}

/** 输入预检及证据准备阶段；恢复阶段直接使用既有会话 API 和持久快照。 */
export async function prepareWorkBuddyCurrentContextBatch(
  db: DatabaseSync, options: WorkBuddyBatchToolOptions, rawInput: unknown
): Promise<string> {
  const input = workBuddyCurrentContextBatchSchema.parse(rawInput)
  // 既有 Gate 在归组时完成 Parser；不再解析第二遍，也不改写其消息结果。
  const normalized = gateWorkBuddyBatchCurrentInput(input.contexts)
  for (const [index, block] of input.contexts.entries()) {
    // 仅识别明确的独立截断标记；普通省略号可能是正文，不据此猜测截断。
    if (/^\s*(?:\[truncated\]|\[内容已截断\]|\[聊天记录已截断\]|<truncated\s*\/>)\s*$/mi.test(block.transcript)) {
      throw new WorkBuddyCurrentInputError('TRUNCATED_CURRENT_CONTEXT', index, '正文包含明确截断标记')
    }
  }
  const prepared: PreparedBatchAttachment[] = []
  for (const attachment of normalized.logical_attachments) {
    const sourcePath = await validateWorkBuddyAttachmentPath(attachment.extracted_dir_path, chatHistoryRoot(options), 'directory')
    const snapshot = {
      messages: attachment.messages,
      parser: { grammar_version: attachment.grammar_version, timezone_interpretation: attachment.timezone_interpretation },
      current_context: {
        file: attachment.file, extracted_dir_path: attachment.extracted_dir_path,
        message_count: attachment.message_count, transcript: attachment.transcript,
        first_sender: attachment.first_sender, first_message_at: attachment.first_message_at,
        truncated: attachment.truncated, context_indexes: attachment.context_indexes,
        raw_context_count: normalized.raw_context_count
      }
    }
    // 只验证，不使用会 trim 的返回值替换 Parser 原始结果。
    workBuddyIngestSchema.parse(snapshot)
    prepared.push({ sourceKind: 'directory', sourcePath, displayName: attachment.file,
      sourceHint: attachment.extracted_dir_path, input: snapshot })
  }
  return prepareBatchAttachments(db, options, prepared)
}

export async function ingestWorkBuddyCurrentContextBatch(
  db: DatabaseSync, options: WorkBuddyBatchToolOptions, rawInput: unknown
): Promise<WorkBuddyBatchResult> {
  const sessionId = await prepareWorkBuddyCurrentContextBatch(db, options, rawInput)
  return executeAndReportBatch(db, options, sessionId)
}

interface PreparedBatchAttachment {
  sourceKind: 'zip' | 'directory'
  sourcePath: string
  displayName: string
  sourceHint: string | null
  input: WorkBuddyIngestInput
}

async function prepareBatchAttachments(
  db: DatabaseSync, options: WorkBuddyBatchToolOptions, attachments: PreparedBatchAttachment[]
): Promise<string> {

  // 会话与两个附件项短事务登记；证据持久化及导入各自独立进行。
  db.exec('BEGIN IMMEDIATE')
  let sessionId: string
  try {
    const session = createBatchImportSession(db, 'workbuddy')
    sessionId = session.id
    for (const [index, attachment] of attachments.entries()) {
      const item = createBatchImportItem(db, session.id, index, attachment.displayName, null, attachment.sourceHint)
      if (attachment.sourceKind === 'directory') {
        db.prepare("UPDATE batch_import_items SET evidence_source_kind = 'directory' WHERE id = ?").run(item.id)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const items = listBatchImportItems(db, sessionId)
  for (const [index, attachment] of attachments.entries()) {
    const item = items[index]
    try {
      if (attachment.sourceKind === 'directory') {
        await saveDirectoryEvidence(db, options.databasePath, item.id, attachment.sourcePath)
      } else {
        await saveOriginalZip(db, options.databasePath, item.id, attachment.sourcePath)
      }
      await saveStructuredSnapshot(db, options.databasePath, item.id, attachment.input)
      if (attachment.sourceKind === 'directory' &&
          (await verifyBatchEvidence(db, options.databasePath, item.id)).status !== 'available') {
        throw new Error('持久目录证据与消息快照未通过整体校验')
      }
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
  return sessionId
}

async function executeAndReportBatch(
  db: DatabaseSync, options: WorkBuddyBatchToolOptions, sessionId: string
): Promise<WorkBuddyBatchResult> {
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

function chatHistoryRoot(options: WorkBuddyBatchToolOptions): string {
  return options.chatHistoryRoot ?? join(homedir(), '.workbuddy', 'app', 'tmp', 'chat-history')
}

async function validateWorkBuddyAttachmentPath(sourcePath: string, rootPath: string, kind: 'zip' | 'directory'): Promise<string> {
  if (!isAbsolute(sourcePath) || sourcePath.split(/[\\/]+/).includes('..')) {
    throw new Error('原始附件必须是允许临时目录内、不含目录穿越的绝对路径')
  }
  if (kind === 'zip' && !sourcePath.toLowerCase().endsWith('.zip')) throw new Error('原始聊天附件必须是 ZIP 文件')
  if (kind === 'directory') { safeAbsolutePath(sourcePath); safeAbsolutePath(rootPath) }
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
      throw new Error('当前附件真实路径不可用：原始附件不存在')
    }
    throw error
  }
  if (info.isSymbolicLink() || (kind === 'zip' ? !info.isFile() : !info.isDirectory())) {
    throw new Error(kind === 'zip' ? '原始 ZIP 路径不是普通文件' : '原始附件路径不是普通目录')
  }
  assertInside(canonicalRoot, await realpath(candidate))
  if (kind === 'directory') {
    const lease = new WindowsPathLease()
    try { await lease.lock(candidate, true) } finally { await lease.close() }
  }
  return candidate
}

function assertInside(root: string, target: string, allowRoot = false): void {
  const part = relative(root, target)
  if ((!part && !allowRoot) || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error('原始附件路径不在允许的 WorkBuddy 聊天临时根目录内')
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
