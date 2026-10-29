import { performance } from 'node:perf_hooks'
import { EXPORT_LIMITS } from '../../shared/markdown-export'
import type { ObsidianExportOutcome, ObsidianExportRequest } from '../../shared/obsidian-export'
import { buildCanonicalExportSnapshot, captureExportSelection, ExportSelectionError } from './chat-selection'
import { sha256 } from './chat-markdown'
import { safeConversationFilename } from './markdown-export'
import { groupObsidianDays, obsidianSourceDigest, renderObsidianMarkdown, VAULT_EXPORT_VERSION } from './obsidian-markdown'
import { VaultWriter, vaultStamp, type VaultWriteOptions } from './obsidian-vault-writer'

export const VAULT_MANIFEST = '.privateradar/export-manifest.json'
interface VaultConversation { conversation_id: string; directory: string }
interface VaultFile {
  conversation_id: string; date: string | null; relative_path: string
  source_digest: string; file_hash: string; message_count: number
  last_message_id: string | null; exported_at: string; preserved_paths: string[]
}
export interface VaultManifest {
  version: 1; vault_export_version: typeof VAULT_EXPORT_VERSION
  conversations: VaultConversation[]; files: VaultFile[]
}
const freshManifest = (): VaultManifest => ({ version: 1, vault_export_version: VAULT_EXPORT_VERSION, conversations: [], files: [] })
const fail = (message: string): never => { throw new ExportSelectionError('EXPORT_DATA_INVALID', message) }
const dateValid = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !value.startsWith('0000') && Number.isFinite(Date.parse(value + 'T00:00:00.000Z'))
  && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value
const fileKey = (file: Pick<VaultFile, 'conversation_id' | 'date'>) => JSON.stringify([file.conversation_id, file.date])
function basePath(folder: string, date: string | null): string {
  return date === null ? folder + '/unknown-time.md' : folder + '/' + date.slice(0, 4) + '/' + date.slice(5, 7) + '/' + date + '.md'
}

/** 损坏或不可信的映射整体进入安全恢复，不使用其中的任何路径访问文件。 */
export function validateVaultManifest(value: unknown, writer: Pick<VaultWriter, 'target'>): VaultManifest {
  const m = value as VaultManifest
  if (!m || m.version !== 1 || m.vault_export_version !== VAULT_EXPORT_VERSION || !Array.isArray(m.conversations) || !Array.isArray(m.files)
    || m.conversations.length > 10000 || m.files.length > 200000) return fail('Vault 清单结构无效。')
  const ids = new Set<string>(), directories = new Set<string>()
  const conversations = new Map<string, VaultConversation>()
  for (const conversation of m.conversations) {
    if (!conversation || typeof conversation.conversation_id !== 'string' || !conversation.conversation_id
      || typeof conversation.directory !== 'string' || conversation.directory.includes('/') || conversation.directory.includes('\\')
      || !conversation.directory.endsWith('--' + sha256(conversation.conversation_id).slice(0, 16))
      || ids.has(conversation.conversation_id) || directories.has(conversation.directory.toLowerCase())) return fail('Vault 会话映射无效。')
    writer.target(conversation.directory)
    ids.add(conversation.conversation_id); directories.add(conversation.directory.toLowerCase())
    conversations.set(conversation.conversation_id, conversation)
  }
  const keys = new Set<string>(), paths = new Set<string>()
  for (const file of m.files) {
    const conversation = conversations.get(file?.conversation_id)
    if (!file || !conversation || (file.date !== null && !dateValid(file.date)) || typeof file.relative_path !== 'string'
      || !/^[a-f0-9]{64}$/.test(file.source_digest) || !/^[a-f0-9]{64}$/.test(file.file_hash)
      || !Number.isSafeInteger(file.message_count) || file.message_count < 0
      || (file.last_message_id !== null && typeof file.last_message_id !== 'string')
      || typeof file.exported_at !== 'string' || !Number.isFinite(Date.parse(file.exported_at))
      || !Array.isArray(file.preserved_paths) || file.preserved_paths.some(item => typeof item !== 'string')
      || keys.has(fileKey(file)) || paths.has(file.relative_path.toLowerCase())) return fail('Vault 文件登记无效。')
    const base = basePath(conversation.directory, file.date).slice(0, -3)
    const versionPattern = new RegExp('^' + base.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '--privateradar-update-[0-9TZ]+-[a-f0-9]{8}\\.md$')
    for (const relative of [file.relative_path, ...file.preserved_paths]) {
      if (relative !== base + '.md' && !versionPattern.test(relative)) return fail('Vault 文件关系无效。')
      writer.target(relative)
    }
    keys.add(fileKey(file)); paths.add(file.relative_path.toLowerCase())
  }
  return m
}

export async function exportObsidianVault(databasePath: string, vault: string, request: ObsidianExportRequest,
  options: VaultWriteOptions & { signal?: AbortSignal } = {}): Promise<ObsidianExportOutcome> {
  if (!request || !Array.isArray(request.conversation_ids) || !request.conversation_ids.length || request.conversation_ids.length > 50
    || request.conversation_ids.some(id => typeof id !== 'string' || !id || Buffer.byteLength(id, 'utf8') > EXPORT_LIMITS.max_metadata_string_bytes)
    || new Set(request.conversation_ids).size !== request.conversation_ids.length) {
    throw new ExportSelectionError('INVALID_SELECTION', '请选择有效会话，每批最多 50 个且不能重复。')
  }
  const selection = captureExportSelection({ conversation_id: request.conversation_ids[0], range: request.range })
  const started = performance.now()
  const guard = () => {
    if (options.signal?.aborted) throw new ExportSelectionError('EXPORT_CANCELLED', 'Obsidian 导出已取消，已完成的文件会保留。')
    if (performance.now() - started > EXPORT_LIMITS.active_export_timeout_ms) throw new ExportSelectionError('EXPORT_IO_ERROR', 'Obsidian 导出超时，已完成的文件会保留，请缩小范围。')
    if (new Intl.DateTimeFormat().resolvedOptions().timeZone !== selection.timezone) throw new ExportSelectionError('TIMEZONE_CHANGED', '系统时区已变化，请重试导出。')
  }
  guard()
  const writer = await VaultWriter.open(vault, databasePath, options)
  const result: ObsidianExportOutcome = { status: 'completed', directory: writer.root, conversationCount: 0,
    created: 0, updated: 0, skipped: 0, preserved: 0, failed: 0, manifestRecovered: false, userModifiedFilePreserved: false }
  let manifest = freshManifest(), manifestHash: string | null = null, dirty = false, corrupt = false
  async function saveManifest(): Promise<void> {
    if (!dirty) return
    manifest.conversations.sort((a, b) => a.conversation_id.localeCompare(b.conversation_id, 'en'))
    manifest.files.sort((a, b) => fileKey(a).localeCompare(fileKey(b), 'en'))
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    if (bytes.length > EXPORT_LIMITS.max_manifest_bytes) throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', 'Vault 清单超过安全容量；完整文件已保留。')
    const backup = corrupt ? '.privateradar/export-manifest.corrupt-' + vaultStamp() + '.json' : undefined
    // 即使用户取消，仍登记已经完整发布的文件；不留下错误的成功映射。
    if (!await writer.publish(VAULT_MANIFEST, bytes, manifestHash, () => undefined, backup)) {
      throw new ExportSelectionError('EXPORT_IO_ERROR', 'Vault 清单在导出期间被修改，未覆盖；已完成的文件保留，后续将安全恢复。')
    }
    manifestHash = sha256(bytes); dirty = false; corrupt = false
  }
  try {
    const raw = await writer.read(VAULT_MANIFEST, EXPORT_LIMITS.max_manifest_bytes)
    if (raw) {
      manifestHash = sha256(raw)
      try { manifest = validateVaultManifest(JSON.parse(raw.toString('utf8')), writer) }
      catch { manifest = freshManifest(); corrupt = true; dirty = true; result.manifestRecovered = true }
    } else { dirty = true; result.manifestRecovered = true }
    const conversations = new Map(manifest.conversations.map(item => [item.conversation_id, item]))
    const files = new Map(manifest.files.map(item => [fileKey(item), item]))
    for (const conversationId of request.conversation_ids) {
      guard()
      // 每次只构建一个所选会话的有界只读快照，沿用现有分页、日期和排序语义。
      const snapshot = await buildCanonicalExportSnapshot(databasePath, { conversation_id: conversationId, range: request.range }, { signal: options.signal })
      guard()
      result.conversationCount++
      let conversation = conversations.get(conversationId)
      if (!conversation) {
        const budget = Math.min(60, 240 - writer.root.length - 110)
        if (budget < 8) throw new ExportSelectionError('EXPORT_PATH_UNSAFE', 'Vault 路径过长，请选择更短的本地目录。')
        const folder = safeConversationFilename(snapshot.conversation.displayConversationName, budget) + '--' + sha256(conversationId).slice(0, 16)
        if (manifest.conversations.some(item => item.directory.toLowerCase() === folder.toLowerCase())) fail('会话目录身份冲突，未覆盖任何文件。')
        writer.target(folder)
        conversation = { conversation_id: conversationId, directory: folder }
        manifest.conversations.push(conversation); dirty = true
        conversations.set(conversationId, conversation)
      }
      const days = groupObsidianDays(snapshot)
      const dates = new Set(days.map(day => day.date))
      const attachments = new Map<string, number>()
      for (const attachment of snapshot.attachments) attachments.set(attachment.message_id, (attachments.get(attachment.message_id) ?? 0) + 1)
      // 已登记的日期如已没有消息，写入零条记录，避免旧内容被误当成当前源数据。
      for (const old of manifest.files.filter(item => item.conversation_id === conversationId)) {
        if (!dates.has(old.date) && (request.range.type === 'conversation'
          || (old.date !== null && old.date >= request.range.start_date && old.date <= request.range.end_date))) days.push({ date: old.date, messages: [] })
      }
      for (const day of days) {
        guard()
        const key = JSON.stringify([conversationId, day.date])
        const entry = files.get(key)
        const sourceDigest = obsidianSourceDigest(snapshot, day)
        const base = basePath(conversation.directory, day.date)
        let relative = entry?.relative_path ?? base
        try {
          let actual = await writer.fileHash(relative)
          if (entry && entry.source_digest === sourceDigest && actual === entry.file_hash) { result.skipped++; continue }
          const bytes = renderObsidianMarkdown(snapshot, day, attachments)
          const preserved = new Set(entry?.preserved_paths ?? [])
          let preserve = actual !== null && (!entry || actual !== entry.file_hash)
          let published = false
          for (let attempt = 0; attempt < 10; attempt++) {
            guard()
            if (preserve) {
              preserved.add(relative)
              relative = base.slice(0, -3) + '--privateradar-update-' + vaultStamp() + '.md'
              actual = null
            }
            if (await writer.publish(relative, bytes, actual, guard)) { published = true; break }
            // 校验之后有人修改或新建了目标：保留占用，改用禁止替换的版本文件。
            preserve = true
          }
          if (!published) throw new ExportSelectionError('EXPORT_IO_ERROR', '文件持续被修改，未覆盖用户内容。')
          const updated: VaultFile = {
            conversation_id: conversationId, date: day.date, relative_path: relative,
            source_digest: sourceDigest, file_hash: sha256(bytes), message_count: day.messages.length,
            last_message_id: day.messages.at(-1)?.id ?? null, exported_at: snapshot.selection.captured_at,
            preserved_paths: [...preserved]
          }
          if (entry) Object.assign(entry, updated)
          else { manifest.files.push(updated); files.set(key, updated) }
          dirty = true
          if (preserve) { result.preserved++; result.userModifiedFilePreserved = true }
          if (entry && actual !== null && !preserve) result.updated++; else result.created++
        } catch (error) {
          guard()
          if (error instanceof ExportSelectionError && error.code === 'EXPORT_CANCELLED') throw error
          result.failed++
        }
      }
      await saveManifest()
    }
  } catch (error) {
    if (error instanceof ExportSelectionError && error.code === 'EXPORT_CANCELLED') result.status = 'cancelled'
    else throw error
  } finally {
    try { await saveManifest() } finally { await writer.close() }
  }
  return result
}
