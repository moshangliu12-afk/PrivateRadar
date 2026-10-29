import type { DatabaseSync } from 'node:sqlite'
import type { MarkdownExportResult } from '../../shared/markdown-export'
import type { ObsidianExportRequest, ObsidianVaultSettings } from '../../shared/obsidian-export'
import { WindowsPathLease } from '../batch-import/windows-path-lease'
import { ExportSelectionError } from './chat-selection'
import { exportObsidianConversations } from './obsidian-batch'
import { validateObsidianVault } from './obsidian-vault-writer'

export const OBSIDIAN_VAULT_SETTING = 'obsidian_vault_path'
export function readObsidianVaultPath(db: DatabaseSync): string | null {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(OBSIDIAN_VAULT_SETTING) as { value_json: string } | undefined
  try {
    const value: unknown = row ? JSON.parse(row.value_json) : null
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch { return null }
}
interface ExportIpc { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => unknown }
export function registerObsidianExportIpc(ipc: ExportIpc, db: DatabaseSync, databasePath: string, desktop: {
  chooseDirectory: () => Promise<string | null>; openDirectory: (directory: string) => Promise<string>
}): void {
  let current: AbortController | null = null, choosing = false, output: string | null = null
  const supported = process.platform === 'win32'
  const requireWindows = () => {
    if (!supported) throw new ExportSelectionError('EXPORT_UNSUPPORTED', 'Obsidian Vault 导出仅支持 Windows 本地目录。')
  }
  async function safe<T>(action: () => T | Promise<T>): Promise<MarkdownExportResult<T>> {
    try { return { ok: true, value: await action() } } catch (error) {
      if (error instanceof ExportSelectionError) return { ok: false, error: { code: error.code, message: error.message.replace(/^[A-Z_]+: /, '') } }
      return { ok: false, error: { code: 'EXPORT_IO_ERROR', message: 'Obsidian 导出未完成，请检查 Vault 权限和磁盘空间；已完成的完整文件会保留。' } }
    }
  }
  ipc.handle('obsidian-export:settings', () => safe((): ObsidianVaultSettings => ({ path: readObsidianVaultPath(db), supported })))
  ipc.handle('obsidian-export:choose-vault', () => safe(async () => {
    requireWindows()
    if (current || choosing) throw new ExportSelectionError('EXPORT_BUSY', '请等待当前导出或目录选择结束。')
    choosing = true
    try {
      const selected = await desktop.chooseDirectory()
      if (!selected) return null
      const path = await validateObsidianVault(selected, databasePath)
      db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at')
        .run(OBSIDIAN_VAULT_SETTING, JSON.stringify(path), new Date().toISOString())
      return path
    } finally { choosing = false }
  }))
  ipc.handle('obsidian-export:start', (_event, request: ObsidianExportRequest) => safe(async () => {
    requireWindows()
    if (current || choosing) throw new ExportSelectionError('EXPORT_BUSY', '已有导出或目录选择正在进行。')
    const vault = readObsidianVaultPath(db)
    if (!vault) throw new ExportSelectionError('INVALID_SELECTION', '请先选择 Obsidian Vault。')
    const controller = current = new AbortController()
    try {
      const result = await exportObsidianConversations(databasePath, vault, request, { signal: controller.signal })
      output = result.directory
      return result
    } finally { if (current === controller) current = null }
  }))
  ipc.handle('obsidian-export:cancel', () => safe(() => { current?.abort(); return null }))
  ipc.handle('obsidian-export:open-output', () => safe(async () => {
    requireWindows()
    if (!output || current) throw new ExportSelectionError('INVALID_SELECTION', '尚无可打开的 Obsidian 导出目录。')
    const lease = new WindowsPathLease()
    try {
      await lease.lock(output, true)
      if (await desktop.openDirectory(output)) throw new ExportSelectionError('EXPORT_IO_ERROR', '无法打开 Vault，请使用显示的路径查看。')
      return null
    } finally { await lease.close() }
  }))
}
