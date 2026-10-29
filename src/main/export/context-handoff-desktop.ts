import type { ContextSelection } from '../../shared/context-handoff'
import type { MarkdownExportOutcome, MarkdownExportResult } from '../../shared/markdown-export'
import { EXPORT_LIMITS } from '../../shared/markdown-export'
import { WindowsPathLease, safeAbsolutePath } from '../batch-import/windows-path-lease'
import { canonicalJson, sha256 } from './chat-markdown'
import { ExportSelectionError } from './chat-selection'
import { buildContextSnapshot, renderContextJson, renderContextMarkdown } from './context-handoff'
import { publishExportFiles, safeConversationFilename } from './markdown-export'

interface ContextIpc { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => unknown }
interface ContextDesktop {
  chooseDirectory: () => Promise<string | null>
  openDirectory: (directory: string) => Promise<string>
  writeClipboard: (text: string) => void
}

/** 界面只提供消息编号和格式；正文、数据库路径及目标路径由主进程确定。 */
export function registerContextHandoffIpc(ipc: ContextIpc, databasePath: string, appVersion: string, desktop: ContextDesktop): void {
  let directory: string | null = null, output: string | null = null, current: AbortController | null = null
  async function safe<T>(action: () => Promise<T> | T): Promise<MarkdownExportResult<T>> {
    try { return { ok: true, value: await action() } }
    catch (error) {
      if (error instanceof ExportSelectionError) return { ok: false, error: { code: error.code, message: error.message.replace(/^[A-Z_]+: /, '') } }
      return { ok: false, error: { code: 'EXPORT_IO_ERROR', message: 'AI 上下文操作未完成，请重试。原数据和已有文件未被修改。' } }
    }
  }
  async function run<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (current) throw new ExportSelectionError('EXPORT_BUSY', '请等待当前 AI 上下文操作结束。')
    const controller = current = new AbortController()
    try { return await action(controller.signal) } finally { if (current === controller) current = null }
  }
  const guard = (signal: AbortSignal) => {
    if (signal.aborted) throw new ExportSelectionError('EXPORT_CANCELLED', 'AI 上下文操作已取消，已有文件未被覆盖。')
  }
  ipc.handle('context-handoff:preview', (_event, selection: ContextSelection) => safe(() => run(async signal => {
    const snapshot = await buildContextSnapshot(databasePath, selection, { signal })
    guard(signal)
    return { snapshot, markdown: renderContextMarkdown(snapshot) }
  })))
  ipc.handle('context-handoff:copy-markdown', (_event, selection: ContextSelection) => safe(() => run(async signal => {
    const snapshot = await buildContextSnapshot(databasePath, selection, { signal })
    const markdown = renderContextMarkdown(snapshot)
    guard(signal)
    desktop.writeClipboard(markdown)
    return null
  })))
  ipc.handle('context-handoff:choose-directory', () => safe(() => run(async signal => {
    const selected = await desktop.chooseDirectory()
    guard(signal)
    if (selected) {
      try { directory = safeAbsolutePath(selected) }
      catch { throw new ExportSelectionError('EXPORT_PATH_UNSAFE', '请选择本地普通目录，不支持路径穿越或特殊路径。') }
    }
    return selected
  })))
  ipc.handle('context-handoff:export', (_event, selection: ContextSelection, format: unknown) => safe(() => run(async signal => {
    if (format !== 'markdown' && format !== 'json') throw new ExportSelectionError('INVALID_SELECTION', '请选择 Markdown 或 JSON 上下文格式。')
    if (!directory) throw new ExportSelectionError('INVALID_SELECTION', '请先选择上下文输出目录。')
    try {
      const snapshot = await buildContextSnapshot(databasePath, selection, { signal })
      guard(signal)
      const { generated_at, ...facts } = snapshot
      const projection = { ...facts, items: facts.items.map(({ content, ...item }) => ({ ...item,
        content_sha256: sha256(content), content_bytes: Buffer.byteLength(content, 'utf8') })),
        export_format: format, renderer_version: 'context-v1' }
      const selectionDigest = sha256(canonicalJson(projection))
      const identity = sha256(canonicalJson(snapshot.items.map(item => item.id).sort()))
      const filename = safeConversationFilename(`PrivateRadar-AI-Context-${selectionDigest.slice(0, 12)}`) + (format === 'markdown' ? '.md' : '.json')
      const content = Buffer.from(format === 'markdown' ? renderContextMarkdown(snapshot) : renderContextJson(snapshot), 'utf8')
      const exportFormat = 'context-' + format
      const metadata = { schema_version: 1, export_version: 'context-v1', export_format: exportFormat,
        exportedAt: generated_at, privateRadarVersion: appVersion, selection_digest: selectionDigest,
        context_identity: identity, context_projection: projection, output_files: [filename, 'export.json'],
        output: { path: filename, bytes: content.length, sha256: sha256(content) } }
      const manifest = Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8')
      if (content.length > EXPORT_LIMITS.max_markdown_bytes || manifest.length > EXPORT_LIMITS.max_manifest_bytes
        || content.length + manifest.length > EXPORT_LIMITS.max_export_bytes) {
        throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', '上下文输出超过安全容量，请减少已选消息；内容未被截断。')
      }
      const result = await publishExportFiles(databasePath, directory, { identity, title: 'AI 上下文', messageCount: snapshot.items.length,
        excludedUnknownTimeCount: 0, rendered: { content, filename, manifest, selectionDigest, digestProjection: projection, format: exportFormat, exportVersion: 'context-v1' },
        storedProjection: saved => saved.context_projection, storedIdentity: saved => saved.context_identity }, { signal })
      output = result.directory
      return result
    } catch (error) {
      if (error instanceof ExportSelectionError && error.code === 'EXPORT_CANCELLED') return { status: 'cancelled', directory: null, messageCount: 0, excludedUnknownTimeCount: 0 } satisfies MarkdownExportOutcome
      throw error
    }
  })))
  ipc.handle('context-handoff:cancel', () => safe(() => { current?.abort(); return null }))
  ipc.handle('context-handoff:open-output', () => safe(() => run(async () => {
    if (!output) throw new ExportSelectionError('INVALID_SELECTION', '尚无可打开的上下文输出目录。')
    const lease = new WindowsPathLease()
    try {
      await lease.lock(output, true)
      if (await desktop.openDirectory(output)) throw new ExportSelectionError('EXPORT_IO_ERROR', '无法打开输出目录，请使用显示的路径查看。')
      return null
    } finally { await lease.close() }
  })))
}
