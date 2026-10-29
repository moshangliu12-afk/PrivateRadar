import { join } from 'node:path'
import type { ObsidianExportOutcome, ObsidianExportRequest } from '../../shared/obsidian-export'
import { safeAbsolutePath } from '../batch-import/windows-path-lease'
import { ExportSelectionError } from './chat-selection'
import { assertConversationBatchTimezone, captureConversationBatch } from './export-batch-selection'
import { exportObsidianVault } from './obsidian-export'

/** 逐会话进入原 Vault 出口，每次完成后即释放正文、保存清单；不扩大单会话资源边界。 */
export async function exportObsidianConversations(databasePath: string, vault: string, request: ObsidianExportRequest,
  options: Parameters<typeof exportObsidianVault>[3] = {}, exportOne = exportObsidianVault): Promise<ObsidianExportOutcome> {
  const { ids, selection } = captureConversationBatch(request?.conversation_ids, request?.range)
  const result: ObsidianExportOutcome = { status: 'completed', directory: join(safeAbsolutePath(vault), 'PrivateRadar'),
    conversationCount: 0, created: 0, updated: 0, skipped: 0, preserved: 0, failed: 0,
    manifestRecovered: false, userModifiedFilePreserved: false,
    batch: { requested: ids.length, processed: 0, remaining: ids.length, errors: [] } }
  const batch = result.batch!
  for (const id of ids) {
    if (options.signal?.aborted) { result.status = 'cancelled'; break }
    try {
      assertConversationBatchTimezone(selection.timezone)
      const one = await exportOne(databasePath, vault, { conversation_ids: [id], range: selection.range }, options)
      result.directory = one.directory
      for (const key of ['conversationCount', 'created', 'updated', 'skipped', 'preserved', 'failed'] as const) result[key] += one[key]
      result.manifestRecovered ||= one.manifestRecovered
      result.userModifiedFilePreserved ||= one.userModifiedFilePreserved
      if (one.status === 'cancelled') { result.status = 'cancelled'; break }
      batch.processed++
    } catch (error) {
      if (error instanceof ExportSelectionError && error.code === 'EXPORT_CANCELLED') { result.status = 'cancelled'; break }
      // 尚未处理会话时，目录失效沿用原桌面错误反馈；部分完成后则保留批量结果。
      if (batch.processed === 0 && error instanceof ExportSelectionError && error.code === 'EXPORT_PATH_UNSAFE') throw error
      result.failed++; batch.processed++
      batch.errors.push({ conversationId: id, code: error instanceof ExportSelectionError ? error.code : 'EXPORT_IO_ERROR',
        message: error instanceof ExportSelectionError ? error.message.replace(/^[A-Z_]+: /, '') : '该会话归档未完成，已发布文件与用户原笔记已保留。' })
      // 来源个别缺失可继续；容量、时区与文件系统错误停止，剩余会话不会算作成功。
      if (!(error instanceof ExportSelectionError) || error.code !== 'CONVERSATION_NOT_FOUND') break
    }
  }
  batch.remaining = batch.requested - batch.processed
  return result
}
