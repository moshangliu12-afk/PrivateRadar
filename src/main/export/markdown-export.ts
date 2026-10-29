import type { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import * as fs from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { WindowsPathLease, safeAbsolutePath } from '../batch-import/windows-path-lease'
import { listConversations } from '../conversation-labels'
import { EXPORT_LIMITS } from '../../shared/markdown-export'
import type { ExportFormat, ExportSelectionRequest, FormattedExportRequest, MarkdownExportConversation, MarkdownExportOutcome, MarkdownExportResult } from '../../shared/markdown-export'
import { buildCanonicalExportSnapshot, captureExportSelection, ExportSelectionError } from './chat-selection'
import { canonicalJson, sha256 } from './chat-markdown'
import { createExportFiles, storedExportProjection, validateExportFormat } from './chat-formats'
import { createPdfExportFiles, type PdfRenderer } from './chat-pdf'

const fail = (message: string): never => { throw new ExportSelectionError('EXPORT_PATH_UNSAFE', message) }
const inside = (parent: string, target: string) => target.toLowerCase() === parent.toLowerCase() || target.toLowerCase().startsWith(parent.toLowerCase().replace(/[\\/]+$/, '') + sep)

export function safeConversationFilename(value: string, maximum = 60): string {
  const clean = value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '')
  let result = ''
  for (const { segment } of new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(clean || '未知会话')) {
    if (result.length + segment.length > maximum) break
    result += segment
  }
  result = result.replace(/[. ]+$/g, '') || '未知会话'
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(result)) result = '_' + result
  return result
}

// flags=0 的 MoveFileEx 不替换既有目标；不使用普通 rename 的替换语义。
const NATIVE_SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
  $r=[Console]::ReadLine() | ConvertFrom-Json
  if ($r.op -eq 'volume') {
    $d=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($r.source))
    if ($d.DriveType -ne [IO.DriveType]::Fixed -or $d.DriveFormat -ne 'NTFS') { throw '仅支持本地固定 NTFS 磁盘' }
    [Console]::WriteLine('{"ok":true,"code":0}')
  } else {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrivateRadarExportPublish {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool MoveFileExW(string source, string destination, uint flags);
}
'@
    $ok=[PrivateRadarExportPublish]::MoveFileExW($r.source,$r.destination,0)
    $code=if($ok){0}else{[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
    [Console]::WriteLine((@{ok=$ok;code=$code} | ConvertTo-Json -Compress))
  }
} catch { [Console]::WriteLine('{"ok":false,"code":-1}') }
`

async function nativeOperation(op: 'volume' | 'move', source: string, destination?: string): Promise<{ ok: boolean; code: number }> {
  if (process.platform !== 'win32' || !process.env.SystemRoot) throw new ExportSelectionError('EXPORT_UNSUPPORTED', '此版本的安全聊天导出仅支持 Windows 本地 NTFS 目录。')
  return new Promise((accept, reject) => {
    const child = spawn(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(NATIVE_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' })
    let output = '', settled = false
    const finish = (error?: Error, result?: { ok: boolean; code: number }) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error); else accept(result!)
    }
    const timer = setTimeout(() => { child.kill(); finish(new ExportSelectionError('EXPORT_IO_ERROR', '安全文件操作超时，请检查输出目录后重试。')) }, 20000)
    child.stdout.on('data', value => { output += value.toString(); if (output.length > 4096) { child.kill(); finish(new Error('原生操作响应过大')) } })
    child.stderr.resume()
    child.on('error', error => finish(error))
    child.stdin.on('error', error => finish(error))
    child.on('close', code => {
      try {
        const result = JSON.parse(output.trim()) as { ok: boolean; code: number }
        if (code !== 0 || typeof result.ok !== 'boolean' || !Number.isInteger(result.code)) throw new Error('原生操作响应无效')
        finish(undefined, result)
      } catch { finish(new ExportSelectionError('EXPORT_IO_ERROR', '无法完成安全文件操作，未覆盖已有文件。')) }
    })
    child.stdin.end(JSON.stringify({ op, source, destination }) + '\n')
  })
}

export interface ExportWriteOptions {
  signal?: AbortSignal
  /** 主进程传入的总操作截止值，不暴露给 IPC。 */
  deadline?: number
  /** 只供主进程工程测试注入中断，不暴露给 IPC。 */
  beforePublish?: (stage: string, destination: string) => Promise<void>
  writeStagedFile?: (path: string, bytes: Buffer) => Promise<void>
}
interface ExportOptions extends ExportWriteOptions {
  format?: ExportFormat
  renderPdf?: PdfRenderer
}
export interface PublishExportInput {
  identity: string
  title: string
  messageCount: number
  excludedUnknownTimeCount: number
  rendered: {
    content: Buffer
    filename: string
    manifest: Buffer
    selectionDigest: string
    digestProjection: unknown
    format: string
    exportVersion: string
  }
  storedProjection: (saved: Record<string, any>) => unknown
  storedIdentity?: (saved: Record<string, any>) => string | undefined
}
async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export async function writeComplete(path: string, bytes: Buffer): Promise<void> {
  const file = await fs.open(path, 'wx')
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  if (sha256(await fs.readFile(path)) !== sha256(bytes)) throw new ExportSelectionError('EXPORT_IO_ERROR', '临时文件校验未通过，未发布导出。')
}
async function cleanStage(stage: string, root: string, filename?: string): Promise<void> {
  if (!inside(root, stage) || dirname(stage) !== root || !basename(stage).startsWith('.privateradar-export-')) return
  try {
    const stat = await fs.lstat(stage)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    const names = await fs.readdir(stage)
    if (names.some(name => !['聊天.md', '聊天.json', '聊天.txt', 'export.json', ...(filename ? [filename] : [])].includes(name))) return
    for (const name of names) await fs.unlink(join(stage, name))
    await fs.rmdir(stage)
  } catch { /* 失败时保留无法安全清理的临时目录，不触碰用户既有内容。 */ }
}

/** 只读取主进程给出的原数据库路径；文件系统只写用户选择的导出根。 */
export async function exportChat(databasePath: string, outputDirectory: string, request: ExportSelectionRequest, appVersion: string, options: ExportOptions = {}): Promise<MarkdownExportOutcome> {
  const format = validateExportFormat(options.format)
  const started = performance.now()
  const guard = () => {
    if (options.signal?.aborted) throw new ExportSelectionError('EXPORT_CANCELLED', '导出已取消，未覆盖已有文件。')
    if (performance.now() - started > EXPORT_LIMITS.active_export_timeout_ms) throw new ExportSelectionError('EXPORT_IO_ERROR', '导出超时，未覆盖已有文件。')
  }
  guard()
  if (format === 'pdf' && !options.renderPdf) throw new ExportSelectionError('EXPORT_UNSUPPORTED', '当前运行环境未提供 PDF 打印能力。')
  const snapshot = await buildCanonicalExportSnapshot(databasePath, request, { signal: options.signal })
  if (!snapshot.messages.length) return { status: 'empty', directory: null, messageCount: 0, excludedUnknownTimeCount: snapshot.selection.excluded_unknown_time_count }
  const rendered = format === 'pdf'
    ? await createPdfExportFiles(snapshot, appVersion, safeConversationFilename(snapshot.conversation.displayConversationName) + '.pdf', options.renderPdf!, options.signal)
    : createExportFiles(snapshot, appVersion, format)
  guard()
  return publishExportFiles(databasePath, outputDirectory, {
    identity: snapshot.conversation_id,
    title: snapshot.conversation.displayConversationName,
    messageCount: snapshot.messages.length,
    excludedUnknownTimeCount: snapshot.selection.excluded_unknown_time_count,
    rendered,
    storedProjection: saved => storedExportProjection(saved, format)
  }, { ...options, deadline: started + EXPORT_LIMITS.active_export_timeout_ms })
}

/** 聊天与上下文导出共用同一暂存、原子发布及不覆盖管线；不查询或修改数据库。 */
export async function publishExportFiles(databasePath: string, outputDirectory: string, input: PublishExportInput,
  options: ExportWriteOptions = {}): Promise<MarkdownExportOutcome> {
  const { rendered } = input
  const deadline = options.deadline ?? performance.now() + EXPORT_LIMITS.active_export_timeout_ms
  const guard = () => {
    if (options.signal?.aborted) throw new ExportSelectionError('EXPORT_CANCELLED', '导出已取消，未覆盖已有文件。')
    if (performance.now() > deadline) throw new ExportSelectionError('EXPORT_IO_ERROR', '导出超时，未覆盖已有文件。')
  }
  guard()
  if (!rendered.filename || basename(rendered.filename) !== rendered.filename || /[<>:"/\\|?*\u0000-\u001f]/.test(rendered.filename)
    || /[. ]$/.test(rendered.filename) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(rendered.filename)
    || rendered.filename.toLowerCase() === 'export.json') fail('导出文件名不安全，未写入任何文件。')
  const selected = safeAbsolutePath(outputDirectory), dataRoot = resolve(dirname(databasePath))
  if (inside(dataRoot, selected)) fail('不能把原数据目录作为导出目录，请选择其他本地目录。')
  const lease = new WindowsPathLease()
  let root = '', stage = ''
  try {
    await lease.lock(selected, true)
    const volume = await nativeOperation('volume', selected)
    if (!volume.ok) fail('请选择本地固定 NTFS 磁盘上的普通目录。')
    const matches = (await fs.readdir(selected)).filter(name => name.toLowerCase() === 'privateradar')
    if (basename(selected).toLowerCase() === 'privateradar') root = selected
    else {
      if (matches.length > 1) fail('输出目录存在大小写冲突，请选择其他目录。')
      root = join(selected, matches[0] ?? 'PrivateRadar')
      if (inside(dataRoot, root)) fail('目标与原数据目录重合，未写入任何文件。')
      try { await fs.mkdir(root) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      await lease.lock(root, true)
    }
    if (inside(dataRoot, root)) fail('目标与原数据目录重合，未写入任何文件。')
    const identityHash = sha256(input.identity)
    let identityLength = 16
    for (let version = 1; version <= 1000; version++) {
      guard(); lease.assertHealthy()
      const tail = `--${identityHash.slice(0, identityLength)}--${rendered.selectionDigest.slice(0, 16)}${version === 1 ? '' : `--v${version}`}`
      const nameBudget = Math.min(60, 240 - root.length - tail.length - Math.max('/export.json'.length, rendered.filename.length + 1) - 1)
      if (nameBudget < 8) fail('输出目录路径过长，请选择更短的本地目录。')
      const name = safeConversationFilename(input.title, nameBudget)
      const destination = join(root, name + tail)
      if (join(destination, 'export.json').length > 240 || join(destination, rendered.filename).length > 240) fail('导出路径超过安全长度。')
      if (await exists(destination)) {
        const stat = await fs.lstat(destination)
        if (stat.isSymbolicLink()) fail('已有导出位置是目录链接，未跟随或覆盖。')
        if (!stat.isDirectory()) continue
        let matched = false, identityConflict = false
        try {
          await lease.lock(destination, true)
          const manifestPath = join(destination, 'export.json'), contentPath = join(destination, rendered.filename)
          await lease.lock(manifestPath, false); await lease.lock(contentPath, false)
          const bytes = await lease.readFile(manifestPath, EXPORT_LIMITS.max_manifest_bytes)
          const saved = JSON.parse(bytes.toString('utf8'))
          const savedIdentity = input.storedIdentity ? input.storedIdentity(saved) : saved.conversation?.id
          identityConflict = typeof savedIdentity === 'string' && savedIdentity !== input.identity
          const projection = input.storedProjection(saved)
          const output = saved.output ?? (rendered.format === 'markdown' ? saved.markdown : undefined)
          matched = saved.schema_version === 1 && saved.export_version === rendered.exportVersion && (saved.export_format ?? 'markdown') === rendered.format && saved.selection_digest === rendered.selectionDigest
            && canonicalJson(projection) === canonicalJson(rendered.digestProjection) && sha256(canonicalJson(projection)) === saved.selection_digest
            && output?.path === rendered.filename && Number.isSafeInteger(output?.bytes)
            && output.bytes === (await fs.stat(contentPath)).size && /^[a-f0-9]{64}$/.test(output?.sha256)
            && await lease.hashFile(contentPath) === output.sha256
        } catch { /* 缺失、修改或损坏的旧导出均保留，发布到新版本目录。 */ }
        finally { await lease.releaseTree(destination) }
        if (matched) return { status: 'unchanged', directory: destination, messageCount: input.messageCount, excludedUnknownTimeCount: input.excludedUnknownTimeCount }
        if (identityConflict && identityLength < 64) { identityLength += 8; version = 0 }
        continue
      }
      stage = await fs.mkdtemp(join(root, '.privateradar-export-'))
      const write = options.writeStagedFile ?? writeComplete
      await write(join(stage, rendered.filename), rendered.content); guard()
      await write(join(stage, 'export.json'), rendered.manifest); guard()
      await options.beforePublish?.(stage, destination)
      guard(); lease.assertHealthy()
      const stageStat = await fs.lstat(stage)
      if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || (await fs.readdir(stage)).sort().join('|') !== ['export.json', rendered.filename].sort().join('|')) fail('临时导出目录发生变化，未发布。')
      for (const [filename, bytes] of [[rendered.filename, rendered.content], ['export.json', rendered.manifest]] as const) {
        const file = join(stage, filename), stat = await fs.lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length || sha256(await fs.readFile(file)) !== sha256(bytes)) {
          throw new ExportSelectionError('EXPORT_IO_ERROR', '临时导出内容校验失败，未发布或覆盖任何文件。')
        }
      }
      guard()
      const publication = await nativeOperation('move', stage, destination)
      if (!publication.ok) {
        await cleanStage(stage, root, rendered.filename); stage = ''
        if (publication.code === 80 || publication.code === 183 || await exists(destination)) continue
        throw new ExportSelectionError('EXPORT_IO_ERROR', '发布失败，已有文件未被覆盖。请检查目录权限和磁盘空间。')
      }
      stage = ''
      return { status: 'created', directory: destination, messageCount: input.messageCount, excludedUnknownTimeCount: input.excludedUnknownTimeCount }
    }
    throw new ExportSelectionError('EXPORT_IO_ERROR', '导出版本过多，请选择其他输出目录。')
  } finally {
    try { if (stage) await cleanStage(stage, root, rendered.filename) } finally { await lease.close() }
  }
}

/** 保留已验收 Markdown 的旧入口与默认行为。 */
export const exportMarkdown = exportChat

/** 批量只编排现有单会话管线，每次读取并释放一个有界只读快照。 */
export async function exportPdfConversations(databasePath: string, directory: string, request: FormattedExportRequest,
  appVersion: string, options: ExportOptions): Promise<MarkdownExportOutcome> {
  const ids = request?.conversation_ids ?? [request?.conversation_id]
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids[0] !== request?.conversation_id
    || ids.some(id => typeof id !== 'string' || !id.trim() || Buffer.byteLength(id, 'utf8') > EXPORT_LIMITS.max_metadata_string_bytes)
    || new Set(ids).size !== ids.length) throw new ExportSelectionError('INVALID_SELECTION', '请选择有效会话，PDF 每批最多 50 个且不能重复。')
  const selection = captureExportSelection({ conversation_id: ids[0], range: request.range })
  const summary: NonNullable<MarkdownExportOutcome['pdf']> = { requested: ids.length, succeeded: 0, created: 0,
    unchanged: 0, empty: 0, failed: 0, remaining: ids.length, errors: [] }
  let output: string | null = null, messageCount = 0, excluded = 0, cancelled = false
  for (const id of ids) {
    if (options.signal?.aborted) { cancelled = true; break }
    try {
      if (new Intl.DateTimeFormat().resolvedOptions().timeZone !== selection.timezone) throw new ExportSelectionError('TIMEZONE_CHANGED', '系统时区已改变，请重新导出。')
      const result = await exportChat(databasePath, directory, { conversation_id: id, range: request.range }, appVersion, { ...options, format: 'pdf' })
      messageCount += result.messageCount; excluded += result.excludedUnknownTimeCount
      if (result.status === 'empty') summary.empty++
      else {
        summary.succeeded++
        if (result.status === 'unchanged') summary.unchanged++; else summary.created++
        output ??= result.directory ? dirname(result.directory) : null
      }
    } catch (error) {
      if (error instanceof ExportSelectionError && error.code === 'EXPORT_CANCELLED') { cancelled = true; break }
      summary.failed++
      summary.errors.push({ conversationId: id, code: error instanceof ExportSelectionError ? error.code : 'EXPORT_IO_ERROR',
        message: error instanceof ExportSelectionError ? error.message.replace(/^[A-Z_]+: /, '') : '生成或保存 PDF 失败，已有文件已保留。' })
      if (error instanceof ExportSelectionError && error.code === 'TIMEZONE_CHANGED') break
    }
  }
  summary.remaining = summary.requested - summary.succeeded - summary.empty - summary.failed
  return { status: cancelled ? 'cancelled' : summary.failed ? (summary.succeeded ? 'partial' : 'failed')
    : summary.created ? 'created' : summary.unchanged ? 'unchanged' : 'empty',
    directory: output, messageCount, excludedUnknownTimeCount: excluded, pdf: summary }
}

interface ExportIpc { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => unknown }
export function registerMarkdownExportIpc(ipc: ExportIpc, db: DatabaseSync, databasePath: string, appVersion: string, desktop: {
  chooseDirectory: () => Promise<string | null>; openDirectory: (directory: string) => Promise<string>
  renderPdf?: PdfRenderer
}): void {
  let directory: string | null = null, output: string | null = null, current: AbortController | null = null
  async function safe<T>(action: () => T | Promise<T>): Promise<MarkdownExportResult<T>> {
    try { return { ok: true, value: await action() } } catch (error) {
      if (error instanceof ExportSelectionError) return { ok: false, error: { code: error.code, message: error.message.replace(/^[A-Z_]+: /, '') } }
      return { ok: false, error: { code: 'EXPORT_IO_ERROR', message: '导出未完成，原数据和已有文件未被覆盖。请检查所选目录权限、路径和磁盘空间后重试。' } }
    }
  }
  ipc.handle('markdown-export:conversations', () => safe((): MarkdownExportConversation[] => {
    const counts = new Map((db.prepare('SELECT conversation_id,COUNT(*) AS count FROM messages GROUP BY conversation_id').all() as unknown as { conversation_id: string; count: number }[]).map(row => [row.conversation_id, row.count]))
    return listConversations(db).map(row => ({ ...row, messageCount: counts.get(row.conversationId) ?? 0 })).filter(row => row.messageCount > 0)
  }))
  ipc.handle('markdown-export:choose-directory', () => safe(async () => {
    if (current) throw new ExportSelectionError('EXPORT_BUSY', '请等待当前导出结束。')
    const selected = await desktop.chooseDirectory()
    if (selected) directory = safeAbsolutePath(selected)
    return selected
  }))
  ipc.handle('markdown-export:start', (_event, request: FormattedExportRequest) => safe(async () => {
    if (current) throw new ExportSelectionError('EXPORT_BUSY', '已有导出正在进行。')
    if (!directory) throw new ExportSelectionError('INVALID_SELECTION', '请先选择输出目录。')
    const controller = current = new AbortController()
    try {
      const result = request?.format === 'pdf'
        ? await exportPdfConversations(databasePath, directory, request, appVersion, { signal: controller.signal, renderPdf: desktop.renderPdf })
        : await exportChat(databasePath, directory, request, appVersion, { signal: controller.signal, format: request?.format })
      output = result.directory
      return result
    } catch (error) {
      if (error instanceof ExportSelectionError && error.code === 'EXPORT_CANCELLED') return { status: 'cancelled', directory: null, messageCount: 0, excludedUnknownTimeCount: 0 } as MarkdownExportOutcome
      throw error
    } finally { if (current === controller) current = null }
  }))
  ipc.handle('markdown-export:cancel', () => safe(() => { current?.abort(); return null }))
  ipc.handle('markdown-export:open-output', () => safe(async () => {
    if (!output || current) throw new ExportSelectionError('INVALID_SELECTION', '尚无可打开的导出目录。')
    const lease = new WindowsPathLease()
    try {
      await lease.lock(output, true)
      const error = await desktop.openDirectory(output)
      if (error) throw new ExportSelectionError('EXPORT_IO_ERROR', '无法打开导出目录，请使用显示的路径查看。')
      return null
    } finally { await lease.close() }
  }))
}
