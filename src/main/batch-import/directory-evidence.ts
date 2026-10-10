import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { BatchImportItem } from './repository'
import type { EvidencePartResult, StoredEvidenceFile } from './evidence'
import { safeAbsolutePath, WindowsPathLease } from './windows-path-lease'

interface Limits {
  maxDepth: number
  maxFileCount: number
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
  maxManifestBytes: number
}
export const DIRECTORY_EVIDENCE_LIMITS: Readonly<Limits> = Object.freeze({
  maxDepth: 16,
  maxFileCount: 4096,
  maxEntries: 8192,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxManifestBytes: 8 * 1024 * 1024
})
export interface DirectoryManifest {
  manifest_version: 1
  source_kind: 'directory'
  directories: string[]
  files: Array<{ path: string; size: number; sha256: string }>
  total_file_count: number
  total_bytes: number
  directory_content_identity: string
}
interface Inventory {
  manifest: DirectoryManifest
  metadata: string
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
class DirectoryEvidenceConflict extends Error {}

function paths(databasePath: string, id: string) {
  if (!UUID.test(id)) throw new Error('附件项编号无效')
  const data = safeAbsolutePath(dirname(databasePath))
  const root = join(data, 'evidence')
  const item = join(root, id)
  return { data, root, item, source: join(item, 'source'), manifest: join(item, 'manifest.json'),
    relative: `evidence/${id}/manifest.json` }
}

function loadItem(db: DatabaseSync, id: string): BatchImportItem {
  if (!UUID.test(id)) throw new Error('附件项编号无效')
  const item = db.prepare('SELECT * FROM batch_import_items WHERE id = ?').get(id) as unknown as BatchImportItem | undefined
  if (!item) throw new Error('附件项不存在')
  return item
}

// 参数只能降低集中上限，不能借调用参数绕过容量限制。
function limits(overrides: Partial<Limits>): Limits {
  const result = { ...DIRECTORY_EVIDENCE_LIMITS }
  for (const key of Object.keys(overrides) as Array<keyof Limits>) {
    const value = overrides[key]
    if (!Number.isSafeInteger(value) || value! < 0 || value! > result[key]) throw new Error('目录证据限制参数无效')
    result[key] = value!
  }
  return result
}

function relativePath(value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || /[\x00-\x1f]/.test(value)) throw new Error('证据相对路径无效')
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('证据相对路径越界或文件名不安全')
  }
  return value
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function statIdentity(stat: Awaited<ReturnType<typeof fs.lstat>> | import('node:fs').BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs,
    'mtimeNs' in stat ? stat.mtimeNs : '', 'ctimeNs' in stat ? stat.ctimeNs : ''].join(':')
}
function manifestFor(directories: string[], files: DirectoryManifest['files']): DirectoryManifest {
  const payload = { manifest_version: 1 as const, source_kind: 'directory' as const,
    directories: [...directories].sort(compare), files: [...files].sort((a, b) => compare(a.path, b.path)),
    total_file_count: files.length, total_bytes: files.reduce((sum, file) => sum + file.size, 0) }
  return { ...payload, directory_content_identity: hash(JSON.stringify(payload)) }
}

async function inventory(root: string, lease: WindowsPathLease, bound: Limits): Promise<Inventory> {
  const directories: string[] = []
  const files: DirectoryManifest['files'] = []
  const metadata: Array<[string, string]> = []
  const names = new Set<string>()
  let count = 0
  let bytes = 0
  async function visit(relative: string): Promise<void> {
    if (relative && relative.split('/').length > bound.maxDepth) throw new Error('目录深度超限')
    const path = relative ? join(root, ...relativePath(relative).split('/')) : root
    const preliminary = await fs.lstat(path, { bigint: true })
    if (preliminary.isSymbolicLink() || (!preliminary.isFile() && !preliminary.isDirectory())) throw new Error('拒绝链接或特殊文件系统项')
    await lease.lock(path, preliminary.isDirectory())
    const stat = await fs.lstat(path, { bigint: true })
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('目录项类型发生变化')
    if ((await fs.realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error('目录项实际路径不匹配')
    const identity = statIdentity(stat)
    metadata.push([relative, identity])
    if (stat.isDirectory()) {
      if (relative) directories.push(relative)
      const handle = await fs.opendir(path)
      for await (const entry of handle) {
        if (++count > bound.maxEntries) throw new Error('目录项总数超限')
        const name = relativePath(relative ? `${relative}/${entry.name}` : entry.name)
        if (names.has(name.toLowerCase())) throw new Error('目录项路径大小写冲突')
        names.add(name.toLowerCase())
        await visit(name)
      }
    } else {
      if (files.length >= bound.maxFileCount) throw new Error('文件数量超限')
      if (stat.size > BigInt(bound.maxFileBytes)) throw new Error('单文件大小超限')
      bytes += Number(stat.size)
      if (bytes > bound.maxTotalBytes) throw new Error('目录总字节数超限')
      files.push({ path: relative, size: Number(stat.size), sha256: await lease.hashFile(path) })
    }
    if (statIdentity(await fs.lstat(path, { bigint: true })) !== identity) throw new Error('读取期间目录项发生变化')
    lease.assertHealthy()
  }
  await visit('')
  return { manifest: manifestFor(directories, files), metadata: JSON.stringify(metadata.sort((a, b) => compare(a[0], b[0]))) }
}

function parseManifest(text: string): DirectoryManifest {
  const value = JSON.parse(text) as DirectoryManifest
  if (!value || value.manifest_version !== 1 || value.source_kind !== 'directory'
    || !Array.isArray(value.directories) || !Array.isArray(value.files) || !HASH.test(value.directory_content_identity)) {
    throw new Error('目录证据清单格式无效')
  }
  const directories = value.directories.map((path) => relativePath(path))
  const files = value.files.map((file) => {
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || !HASH.test(file.sha256)) throw new Error('目录证据文件清单无效')
    return { path: relativePath(file.path), size: file.size, sha256: file.sha256 }
  })
  const canonical = manifestFor(directories, files)
  if (text !== `${JSON.stringify(canonical)}\n`) throw new Error('目录证据清单非规范化或身份不匹配')
  return canonical
}

async function verifyTree(itemPath: string, expected: string, lease: WindowsPathLease): Promise<DirectoryManifest> {
  await lease.lock(itemPath, true)
  const manifestPath = join(itemPath, 'manifest.json')
  await lease.lock(manifestPath, false)
  const stat = await fs.lstat(manifestPath)
  if (stat.size > DIRECTORY_EVIDENCE_LIMITS.maxManifestBytes) throw new Error('目录证据清单大小超限')
  const manifest = parseManifest((await lease.readFile(manifestPath, DIRECTORY_EVIDENCE_LIMITS.maxManifestBytes)).toString('utf8'))
  if (manifest.directory_content_identity !== expected) throw new Error('目录证据清单与数据库身份不匹配')
  const actual = await inventory(join(itemPath, 'source'), lease, DIRECTORY_EVIDENCE_LIMITS)
  if (JSON.stringify(actual.manifest) !== JSON.stringify(manifest)) throw new Error('持久目录与清单不一致')
  lease.assertHealthy()
  return manifest
}

export async function saveDirectoryEvidence(
  db: DatabaseSync, databasePath: string, batchItemId: string, sourceDirectory: string,
  overrides: Partial<Limits> = {}
): Promise<StoredEvidenceFile> {
  if (process.platform === 'darwin') throw new Error('当前 macOS 内部版本尚未支持目录证据')
  const item = loadItem(db, batchItemId)
  const target = paths(databasePath, batchItemId)
  const source = safeAbsolutePath(sourceDirectory)
  const bound = limits(overrides)
  const a = source.toLowerCase(), b = target.root.toLowerCase()
  if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep)) throw new Error('源目录与证据目录不能相互包含')
  const lease = new WindowsPathLease()
  let staging: string | null = null
  let published = false
  try {
    if (item.evidence_relative_path && item.evidence_source_kind !== 'directory') throw new DirectoryEvidenceConflict('已有 ZIP 证据，不能改成目录')
    db.prepare(`UPDATE batch_import_items SET evidence_source_kind = 'directory'
      WHERE id = ? AND evidence_relative_path IS NULL AND snapshot_relative_path IS NULL
        AND attachment_identity IS NULL`).run(batchItemId)
    await lease.lock(source, true)
    const before = await inventory(source, lease, bound)
    const identity = before.manifest.directory_content_identity
    if (item.attachment_identity && item.attachment_identity !== identity) throw new DirectoryEvidenceConflict('附件项已有不同内容身份')
    if (item.evidence_relative_path !== null) {
      if (item.evidence_relative_path !== target.relative || item.attachment_identity !== identity) throw new DirectoryEvidenceConflict('附件项已有不同目录记录')
      await verifyTree(target.item, identity, lease)
      const after = await inventory(source, lease, bound)
      if (before.metadata !== after.metadata || JSON.stringify(before.manifest) !== JSON.stringify(after.manifest)) throw new Error('幂等核验期间源目录发生变化')
      return { relativePath: target.relative, sha256: identity }
    }
    db.prepare(`UPDATE batch_import_items SET evidence_source_kind = 'directory'
      WHERE id = ? AND evidence_relative_path IS NULL AND (attachment_identity IS NULL OR attachment_identity = ?)`
    ).run(batchItemId, identity)
    await lease.lock(target.data, true)
    try { await fs.mkdir(target.root) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await lease.lock(target.root, true)
    if (await exists(target.item)) throw new DirectoryEvidenceConflict('证据目标已存在，禁止覆盖或接管')
    staging = join(target.root, `.directory-${batchItemId}-${randomUUID()}.tmp`)
    await fs.mkdir(staging)
    await lease.lock(staging, true)
    const stagingSource = join(staging, 'source')
    await fs.mkdir(stagingSource)
    await lease.lock(stagingSource, true)
    for (const directory of before.manifest.directories) {
      const path = join(stagingSource, ...directory.split('/'))
      await fs.mkdir(path)
      await lease.lock(path, true)
    }
    for (const file of before.manifest.files) {
      lease.assertHealthy()
      await lease.copyFile(join(source, ...file.path.split('/')), join(stagingSource, ...file.path.split('/')))
    }
    const after = await inventory(source, lease, bound)
    if (before.metadata !== after.metadata || JSON.stringify(before.manifest) !== JSON.stringify(after.manifest)) throw new Error('复制期间源目录发生变化')
    const serialized = `${JSON.stringify(before.manifest)}\n`
    if (Buffer.byteLength(serialized) > bound.maxManifestBytes) throw new Error('目录证据清单大小超限')
    await fs.writeFile(join(staging, 'manifest.json'), serialized, { encoding: 'utf8', flag: 'wx' })
    await verifyTree(staging, identity, lease)
    await lease.releaseTree(staging)
    if (await exists(target.item)) throw new DirectoryEvidenceConflict('证据目标已存在，禁止覆盖')
    lease.assertHealthy()
    // 暂存目录和最终目录为同一根目录下的兄弟目录，Windows 不替换已有目录。
    await fs.rename(staging, target.item)
    staging = null
    published = true
    await verifyTree(target.item, identity, lease)
    const updated = db.prepare(`UPDATE batch_import_items SET evidence_source_kind = 'directory',
      attachment_identity = ?, evidence_relative_path = ?, evidence_status = 'available',
      status = CASE WHEN status = 'failed' AND error_summary LIKE '目录证据保存失败：%' THEN 'pending' ELSE status END,
      error_summary = CASE WHEN error_summary LIKE '目录证据保存失败：%' THEN NULL ELSE error_summary END, updated_at = ?
      WHERE id = ? AND evidence_source_kind = 'directory' AND evidence_relative_path IS NULL
        AND (attachment_identity IS NULL OR attachment_identity = ?)`
    ).run(identity, target.relative, new Date().toISOString(), batchItemId, identity)
    if (updated.changes !== 1) throw new DirectoryEvidenceConflict('目录证据记录已被其他操作更新')
    published = false
    return { relativePath: target.relative, sha256: identity }
  } catch (error) {
    if (!(error instanceof DirectoryEvidenceConflict) && item.evidence_status !== 'available') {
      db.prepare(`UPDATE batch_import_items SET evidence_status = 'error', status = 'failed',
        error_summary = ?, updated_at = ? WHERE id = ? AND evidence_relative_path IS NULL`
      ).run(`目录证据保存失败：${error instanceof Error ? error.message : '未知错误'}`, new Date().toISOString(), batchItemId)
    }
    throw error
  } finally {
    // 先关闭所有自有句柄，避免 Windows 拒绝清理；不会清理其他项或已有目标。
    // 关闭失败也先确认辅助进程已销毁，再清理本次未登记的暂存/发布目标。
    try { await lease.close() } finally {
      lease.assertReleased()
      if (staging) await fs.rm(staging, { recursive: true, force: true })
      if (published) await fs.rm(target.item, { recursive: true, force: true })
    }
  }
}

export async function verifyDirectoryEvidence(
  db: DatabaseSync, databasePath: string, batchItemId: string
): Promise<EvidencePartResult> {
  return inspectDirectoryEvidence(loadItem(db, batchItemId), databasePath)
}

export async function inspectDirectoryEvidence(item: BatchImportItem, databasePath: string): Promise<EvidencePartResult> {
  if (process.platform === 'darwin') {
    return { status: 'error', relativePath: item.evidence_relative_path,
      expectedSha256: item.attachment_identity, actualSha256: null, error: '当前 macOS 内部版本尚未支持目录证据' }
  }
  const target = paths(databasePath, item.id)
  const result: EvidencePartResult = { status: 'pending', relativePath: item.evidence_relative_path,
    expectedSha256: item.attachment_identity, actualSha256: null }
  if (!item.evidence_relative_path || !item.attachment_identity) {
    return { ...result, status: item.evidence_status === 'error' || await exists(target.item) ? 'error' : 'pending' }
  }
  if (item.evidence_source_kind !== 'directory' || item.evidence_relative_path !== target.relative || !HASH.test(item.attachment_identity)) {
    return { ...result, status: 'corrupt', error: '目录证据记录或路径无效' }
  }
  let lease: WindowsPathLease | null = null
  try {
    if (!await exists(target.manifest) || !await exists(target.source)) return { ...result, status: 'missing' }
    lease = new WindowsPathLease()
    const manifest = await verifyTree(target.item, item.attachment_identity, lease)
    return { ...result, status: 'available', actualSha256: manifest.directory_content_identity }
  } catch (error) {
    return { ...result, status: 'corrupt', error: error instanceof Error ? error.message : '目录证据校验失败' }
  } finally { await lease?.close() }
}

async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
