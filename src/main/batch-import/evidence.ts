import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { workBuddyIngestSchema, type WorkBuddyIngestInput } from '../integrations/workbuddy/validation'
import type { BatchImportItem } from './repository'
import { inspectDirectoryEvidence } from './directory-evidence'
import { WindowsPathLease } from './windows-path-lease'
import { loadMacJsonSnapshot, saveMacJsonRaw, saveMacJsonSnapshot, verifyMacJsonEvidence } from './mac-json-evidence'
import { createManualJsonZip, getManualJsonItem, MANUAL_JSON_MAX_BYTES, validateManualJsonSnapshot,
  type ManualJsonSnapshotInput } from '../import/manual-json-contract'

const ITEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ZIP_NAME = 'original.zip'
const SNAPSHOT_NAME = 'messages.json'
const SNAPSHOT_VERSION = 1
const DIRECTORY_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024

export type EvidenceState = 'pending' | 'available' | 'missing' | 'corrupt' | 'error'

export interface EvidencePartResult {
  status: EvidenceState
  relativePath: string | null
  expectedSha256: string | null
  actualSha256: string | null
  messageCount?: number
  error?: string
}

export interface EvidenceVerification {
  itemId: string
  status: EvidenceState
  zip: EvidencePartResult
  snapshot: EvidencePartResult
  sourceKind: 'zip' | 'directory'
  source: EvidencePartResult
  directory?: EvidencePartResult
}

export interface StoredEvidenceFile {
  relativePath: string
  sha256: string
}

export async function saveCapturedJsonEvidence(
  db: DatabaseSync, databasePath: string, batchItemId: string, capturedBytes: Buffer
): Promise<StoredEvidenceFile> {
  if (process.platform === 'darwin') return saveMacJsonRaw(db, databasePath, batchItemId, capturedBytes)
  if (!getManualJsonItem(db, batchItemId)) throw new Error('手动 JSON 来源身份未登记')
  if (capturedBytes.length > MANUAL_JSON_MAX_BYTES) throw new Error('文件超过 50 MB，请拆分后再导入')
  const item = loadItem(db, batchItemId), paths = itemPaths(databasePath, batchItemId)
  const zipBytes = createManualJsonZip(capturedBytes), expectedHash = sha256Bytes(zipBytes)
  let temporaryPath: string | null = null, published = false
  try {
    if (item.evidence_relative_path !== null) {
      if (item.evidence_relative_path !== paths.zipRelative || item.attachment_identity !== expectedHash ||
          (await inspectFile(paths.zipPath, expectedHash, paths)).status !== 'available') {
        throw new EvidenceConflictError('原始 JSON 已有不同或不可验证的证据，禁止覆盖')
      }
      return { relativePath: paths.zipRelative, sha256: expectedHash }
    }
    await ensureSafeDirectory(paths)
    temporaryPath = join(paths.itemDirectory, '.json-' + randomUUID() + '.tmp')
    await writeFile(temporaryPath, zipBytes, { flag: 'wx' })
    if (await sha256File(temporaryPath) !== expectedHash) throw new Error('原始 JSON ZIP 写入后校验失败')
    // 硬链接的目标创建是原子的；不会覆盖已有目标。
    await link(temporaryPath, paths.zipPath)
    published = true
    await rm(temporaryPath)
    temporaryPath = null
    if ((await inspectFile(paths.zipPath, expectedHash, paths)).status !== 'available') throw new Error('原始 JSON ZIP 发布后校验失败')
    const registered = db.prepare(
      "UPDATE batch_import_items SET attachment_identity=?,evidence_relative_path=?,evidence_status='available',updated_at=? " +
      "WHERE id=? AND evidence_relative_path IS NULL AND evidence_source_kind='zip'"
    ).run(expectedHash, paths.zipRelative, new Date().toISOString(), batchItemId)
    if (registered.changes !== 1) throw new Error('原始 JSON ZIP 登记冲突')
    published = false
    return { relativePath: paths.zipRelative, sha256: expectedHash }
  } catch (error) {
    if (published) await rm(paths.zipPath, { force: true }).catch(() => undefined)
    db.prepare(
      "UPDATE batch_import_items SET evidence_status='error',status='failed',error_summary=?,updated_at=? " +
      "WHERE id=? AND evidence_relative_path IS NULL"
    ).run('原始 JSON 证据封存失败，未导入本来源', new Date().toISOString(), batchItemId)
    throw error
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export async function saveOriginalZip(
  db: DatabaseSync,
  databasePath: string,
  batchItemId: string,
  sourceZipPath: string
): Promise<StoredEvidenceFile> {
  if (process.platform === 'darwin') throw new Error('此平台尚未支持外部 ZIP 证据导入')
  const item = loadItem(db, batchItemId)
  const paths = itemPaths(databasePath, batchItemId)
  let temporaryPath: string | null = null
  let published = false
  try {
    if (item.evidence_source_kind !== 'zip') throw new EvidenceConflictError('目录证据不能被 ZIP 替换')
    const source = await lstat(sourceZipPath)
    if (!source.isFile()) throw new Error('源 ZIP 不是普通文件')
    const sourceHash = await sha256File(sourceZipPath)
    if (item.attachment_identity && item.attachment_identity !== sourceHash) {
      throw new EvidenceConflictError('附件项已有不同的 ZIP SHA-256')
    }

    if (item.evidence_relative_path !== null) {
      if (item.evidence_relative_path !== paths.zipRelative || item.attachment_identity !== sourceHash) {
        throw new EvidenceConflictError('附件项已有不同的原始 ZIP 记录')
      }
      const existing = await inspectFile(paths.zipPath, sourceHash, paths)
      if (existing.status !== 'available') throw new EvidenceConflictError('已有原始 ZIP 不可验证，禁止静默替换')
      return { relativePath: paths.zipRelative, sha256: sourceHash }
    }

    await ensureSafeDirectory(paths)
    if (await lstatOrNull(paths.zipPath)) throw new EvidenceConflictError('原始 ZIP 目标路径已存在，禁止覆盖')
    temporaryPath = join(paths.itemDirectory, `.original-${randomUUID()}.tmp`)
    await copyFile(sourceZipPath, temporaryPath, constants.COPYFILE_EXCL)
    if (await sha256File(temporaryPath) !== sourceHash) throw new Error('复制后的 ZIP SHA-256 与源文件不一致')
    if (await lstatOrNull(paths.zipPath)) throw new EvidenceConflictError('原始 ZIP 目标路径已存在，禁止覆盖')
    await rename(temporaryPath, paths.zipPath)
    temporaryPath = null
    published = true
    if (await sha256File(paths.zipPath) !== sourceHash) throw new Error('发布后的 ZIP SHA-256 与源文件不一致')

    const updated = db.prepare(`
      UPDATE batch_import_items
      SET attachment_identity = ?, evidence_relative_path = ?, evidence_status = 'available',
          status = CASE WHEN status = 'failed' AND error_summary LIKE '原始 ZIP 保存失败：%'
            THEN 'pending' ELSE status END,
          error_summary = NULL, updated_at = ?
      WHERE id = ? AND evidence_source_kind = 'zip' AND evidence_relative_path IS NULL
        AND (attachment_identity IS NULL OR attachment_identity = ?)
    `).run(sourceHash, paths.zipRelative, new Date().toISOString(), batchItemId, sourceHash)
    if (updated.changes !== 1) throw new EvidenceConflictError('附件项原始 ZIP 记录已被其他操作更新')
    published = false
    return { relativePath: paths.zipRelative, sha256: sourceHash }
  } catch (error) {
    if (published) await rm(paths.zipPath, { force: true }).catch(() => undefined)
    if (!(error instanceof EvidenceConflictError) && item.evidence_status !== 'available') {
      db.prepare(`
        UPDATE batch_import_items SET evidence_status = 'error', status = 'failed',
          error_summary = ?, updated_at = ? WHERE id = ? AND evidence_relative_path IS NULL
      `).run(`原始 ZIP 保存失败：${errorMessage(error)}`, new Date().toISOString(), batchItemId)
    }
    throw error
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export async function saveStructuredSnapshot(
  db: DatabaseSync,
  databasePath: string,
  batchItemId: string,
  input: WorkBuddyIngestInput | ManualJsonSnapshotInput
): Promise<StoredEvidenceFile> {
  if (process.platform === 'darwin') {
    if (!getManualJsonItem(db, batchItemId)) throw new Error('此平台尚未支持该来源的证据快照')
    return saveMacJsonSnapshot(db, databasePath, batchItemId, input as ManualJsonSnapshotInput)
  }
  const item = loadItem(db, batchItemId)
  const paths = itemPaths(databasePath, batchItemId)
  let temporaryPath: string | null = null
  let published = false
  let lease: WindowsPathLease | null = null
  const manualJson = getManualJsonItem(db, batchItemId) !== null
  try {
    if (item.evidence_source_kind === 'directory') {
      lease = new WindowsPathLease()
      await lease.lock(paths.itemDirectory, true)
    }
    const source = await inspectRecordedSource(item, paths, databasePath)
    if (source.status !== 'available') throw new Error('原始证据尚未通过校验，不能保存消息快照')
    const serializableInput = jsonValue(input)
    const payload = { schema_version: SNAPSHOT_VERSION, input: serializableInput }
    const serialized = `${JSON.stringify(payload)}\n`
    if (lease && Buffer.byteLength(serialized, 'utf8') > DIRECTORY_SNAPSHOT_MAX_BYTES) throw new Error('目录消息快照容量超限')
    const expectedHash = sha256Bytes(Buffer.from(serialized, 'utf8'))
    validateSnapshot(serialized, input.messages.length, manualJson)

    if (item.snapshot_relative_path !== null) {
      if (item.snapshot_relative_path !== paths.snapshotRelative || item.snapshot_sha256 !== expectedHash) {
        throw new EvidenceConflictError('附件项已有不同的结构化快照记录')
      }
      if (lease) await lease.lock(paths.snapshotPath, false)
      const existing = await inspectSnapshot(paths.snapshotPath, expectedHash, paths, lease, manualJson)
      if (existing.status !== 'available') throw new EvidenceConflictError('已有结构化快照不可验证，禁止静默替换')
      return { relativePath: paths.snapshotRelative, sha256: expectedHash }
    }

    await ensureSafeDirectory(paths)
    if (await lstatOrNull(paths.snapshotPath)) throw new EvidenceConflictError('结构化快照目标路径已存在，禁止覆盖')
    temporaryPath = join(paths.itemDirectory, `.messages-${randomUUID()}.tmp`)
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' })
    const savedText = await readFile(temporaryPath, 'utf8')
    validateSnapshot(savedText, input.messages.length, manualJson)
    if (sha256Bytes(Buffer.from(savedText, 'utf8')) !== expectedHash) throw new Error('结构化快照写入后哈希不一致')
    if (await lstatOrNull(paths.snapshotPath)) throw new EvidenceConflictError('结构化快照目标路径已存在，禁止覆盖')
    if (manualJson) {
      await link(temporaryPath, paths.snapshotPath)
      published = true
      await rm(temporaryPath)
    } else await rename(temporaryPath, paths.snapshotPath)
    temporaryPath = null
    published = true
    if (lease) await lease.lock(paths.snapshotPath, false)
    const verified = await inspectSnapshot(paths.snapshotPath, expectedHash, paths, lease, manualJson)
    if (verified.status !== 'available' || verified.messageCount !== input.messages.length) {
      throw new Error('发布后的结构化快照未通过校验')
    }

    const updated = db.prepare(`
      UPDATE batch_import_items
      SET snapshot_relative_path = ?, snapshot_sha256 = ?,
          status = CASE WHEN status = 'failed' AND error_summary LIKE '快照保存失败：%'
            THEN 'pending' ELSE status END,
          error_summary = CASE WHEN error_summary LIKE '快照保存失败：%' THEN NULL ELSE error_summary END,
          updated_at = ?
      WHERE id = ? AND snapshot_relative_path IS NULL
    `).run(paths.snapshotRelative, expectedHash, new Date().toISOString(), batchItemId)
    if (updated.changes !== 1) throw new EvidenceConflictError('附件项快照记录已被其他操作更新')
    published = false
    return { relativePath: paths.snapshotRelative, sha256: expectedHash }
  } catch (error) {
    try { await lease?.close() } finally {
      lease?.assertReleased()
      lease = null
      if (published) await rm(paths.snapshotPath, { force: true }).catch(() => undefined)
      if (!(error instanceof EvidenceConflictError) && item.snapshot_relative_path === null) {
        db.prepare(`
          UPDATE batch_import_items SET status = 'failed', error_summary = ?, updated_at = ?
          WHERE id = ? AND snapshot_relative_path IS NULL
        `).run(`快照保存失败：${errorMessage(error)}`, new Date().toISOString(), batchItemId)
      }
    }
    throw error
  } finally {
    try { await lease?.close() } finally {
      lease?.assertReleased()
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

export async function verifyBatchEvidence(
  db: DatabaseSync,
  databasePath: string,
  batchItemId: string
): Promise<EvidenceVerification> {
  if (process.platform === 'darwin') return verifyMacJsonEvidence(db, databasePath, batchItemId)
  const item = loadItem(db, batchItemId)
  const paths = itemPaths(databasePath, batchItemId)
  const source = await inspectRecordedSource(item, paths, databasePath)
  const zip: EvidencePartResult = item.evidence_source_kind === 'zip' ? source
    : { status: 'pending', relativePath: null, expectedSha256: null, actualSha256: null }
  let lease: WindowsPathLease | null = null
  try {
    if (item.evidence_source_kind === 'directory' && item.snapshot_relative_path !== null) {
      lease = new WindowsPathLease()
      await lease.lock(paths.snapshotPath, false)
    }
    const unregisteredSnapshot = item.snapshot_relative_path === null ? await lstatOrNull(paths.snapshotPath) : null
    const snapshot = item.snapshot_relative_path === null
      ? { status: unregisteredSnapshot || item.error_summary?.startsWith('快照保存失败：') ? 'error' : 'pending',
          relativePath: null, expectedSha256: null, actualSha256: null } as EvidencePartResult
      : item.snapshot_relative_path !== paths.snapshotRelative || !item.snapshot_sha256
        ? { status: 'corrupt', relativePath: item.snapshot_relative_path,
            expectedSha256: item.snapshot_sha256, actualSha256: null, error: '结构化快照记录不完整或路径无效' } as EvidencePartResult
        : await inspectSnapshot(paths.snapshotPath, item.snapshot_sha256, paths, lease, getManualJsonItem(db, batchItemId) !== null)
    const status = ['corrupt', 'missing', 'error', 'pending'].find((state) => source.status === state || snapshot.status === state) as EvidenceState | undefined
    return { itemId: batchItemId, status: status ?? 'available', zip, snapshot,
      sourceKind: item.evidence_source_kind, source,
      ...(item.evidence_source_kind === 'directory' ? { directory: source } : {}) }
  } catch (error) {
    const snapshot: EvidencePartResult = { status: 'corrupt', relativePath: item.snapshot_relative_path,
      expectedSha256: item.snapshot_sha256, actualSha256: null, error: errorMessage(error) }
    return { itemId: batchItemId, status: 'corrupt', zip, snapshot,
      sourceKind: item.evidence_source_kind, source, directory: source }
  } finally { await lease?.close() }
}

export async function loadManualJsonSnapshot(
  db: DatabaseSync, databasePath: string, batchItemId: string
): Promise<ManualJsonSnapshotInput> {
  if (process.platform === 'darwin') return loadMacJsonSnapshot(db, databasePath, batchItemId)
  if (!getManualJsonItem(db, batchItemId)) throw new Error('不是手动 JSON 来源')
  if ((await verifyBatchEvidence(db, databasePath, batchItemId)).status !== 'available') throw new Error('手动 JSON 证据不可用')
  const item = loadItem(db, batchItemId), paths = itemPaths(databasePath, batchItemId)
  const bytes = await readFile(paths.snapshotPath)
  if (sha256Bytes(bytes) !== item.snapshot_sha256) throw new Error('手动 JSON 快照读取时哈希改变')
  return validateSnapshot(bytes.toString('utf8'), undefined, true).input as ManualJsonSnapshotInput
}

export async function loadStructuredSnapshot(
  db: DatabaseSync,
  databasePath: string,
  batchItemId: string
): Promise<WorkBuddyIngestInput> {
  if (process.platform === 'darwin') throw new Error('此平台尚未支持 WorkBuddy 证据快照')
  if (getManualJsonItem(db, batchItemId)) throw new Error('手动 JSON 来源需读取专属快照')
  const verified = await verifyBatchEvidence(db, databasePath, batchItemId)
  if (verified.status !== 'available') throw new Error(`附件证据不可用：${verified.status}`)
  const item = loadItem(db, batchItemId)
  const paths = itemPaths(databasePath, batchItemId)
  let lease: WindowsPathLease | null = null
  try {
    if (item.evidence_source_kind === 'directory') {
      lease = new WindowsPathLease()
      await lease.lock(paths.snapshotPath, false)
    }
    const bytes = lease ? await lease.readFile(paths.snapshotPath, DIRECTORY_SNAPSHOT_MAX_BYTES) : await readFile(paths.snapshotPath)
    if (sha256Bytes(bytes) !== item.snapshot_sha256) throw new Error('读取结构化快照时哈希发生变化')
    return validateSnapshot(bytes.toString('utf8')).input as WorkBuddyIngestInput
  } finally { await lease?.close() }
}

async function inspectRecordedSource(item: BatchImportItem, paths: EvidencePaths, databasePath: string): Promise<EvidencePartResult> {
  return item.evidence_source_kind === 'directory'
    ? inspectDirectoryEvidence(item, databasePath) : inspectRecordedZip(item, paths)
}

class EvidenceConflictError extends Error {}

interface EvidencePaths {
  root: string
  itemDirectory: string
  zipPath: string
  zipRelative: string
  snapshotPath: string
  snapshotRelative: string
}

function itemPaths(databasePath: string, batchItemId: string): EvidencePaths {
  if (!ITEM_ID_PATTERN.test(batchItemId)) throw new Error('附件项编号无效')
  const dataDirectory = resolve(dirname(databasePath))
  const root = resolve(dataDirectory, 'evidence')
  const itemDirectory = resolve(root, batchItemId)
  if (!itemDirectory.startsWith(`${root}${sep}`)) throw new Error('附件证据目录越界')
  return {
    root,
    itemDirectory,
    zipPath: join(itemDirectory, ZIP_NAME),
    zipRelative: `evidence/${batchItemId}/${ZIP_NAME}`,
    snapshotPath: join(itemDirectory, SNAPSHOT_NAME),
    snapshotRelative: `evidence/${batchItemId}/${SNAPSHOT_NAME}`
  }
}

function loadItem(db: DatabaseSync, batchItemId: string): BatchImportItem {
  if (!ITEM_ID_PATTERN.test(batchItemId)) throw new Error('附件项编号无效')
  const item = db.prepare('SELECT * FROM batch_import_items WHERE id = ?').get(batchItemId) as unknown as BatchImportItem | undefined
  if (!item) throw new Error('附件项不存在')
  return item
}

async function ensureSafeDirectory(paths: EvidencePaths): Promise<void> {
  for (const path of [paths.root, paths.itemDirectory]) {
    const existing = await lstatOrNull(path)
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('证据目录不是安全的普通目录')
    if (!existing) await mkdir(path)
  }
}

async function inspectRecordedZip(item: BatchImportItem, paths: EvidencePaths): Promise<EvidencePartResult> {
  if (!item.evidence_relative_path || !item.attachment_identity) {
    const unregisteredFile = await lstatOrNull(paths.zipPath)
    return { status: unregisteredFile || item.evidence_status === 'error' ? 'error' : 'pending',
      relativePath: item.evidence_relative_path, expectedSha256: item.attachment_identity, actualSha256: null }
  }
  if (item.evidence_relative_path !== paths.zipRelative) {
    return { status: 'corrupt', relativePath: item.evidence_relative_path,
      expectedSha256: item.attachment_identity, actualSha256: null, error: '原始 ZIP 相对路径无效' }
  }
  return inspectFile(paths.zipPath, item.attachment_identity, paths)
}

async function inspectSnapshot(path: string, expectedHash: string, paths: EvidencePaths, lease: WindowsPathLease | null = null, manualJson = false): Promise<EvidencePartResult> {
  const actualSha256 = lease ? await lease.hashFile(path) : null
  const file = lease
    ? { status: actualSha256 === expectedHash ? 'available' : 'corrupt', relativePath: paths.snapshotRelative,
        expectedSha256: expectedHash, actualSha256 } as EvidencePartResult
    : await inspectFile(path, expectedHash, paths)
  if (file.status !== 'available') return file
  try {
    const text = lease ? (await lease.readFile(path, DIRECTORY_SNAPSHOT_MAX_BYTES)).toString('utf8') : await readFile(path, 'utf8')
    const snapshot = validateSnapshot(text, undefined, manualJson)
    return { ...file, messageCount: snapshot.input.messages.length }
  } catch (error) {
    return { ...file, status: 'corrupt', error: `结构化快照无效：${errorMessage(error)}` }
  }
}

async function inspectFile(path: string, expectedHash: string, paths: EvidencePaths): Promise<EvidencePartResult> {
  const relativePath = path === paths.zipPath ? paths.zipRelative : paths.snapshotRelative
  const root = await lstatOrNull(paths.root)
  const directory = await lstatOrNull(paths.itemDirectory)
  if (root?.isSymbolicLink() || directory?.isSymbolicLink()) {
    return { status: 'corrupt', relativePath, expectedSha256: expectedHash, actualSha256: null, error: '证据路径包含符号链接' }
  }
  const file = await lstatOrNull(path)
  if (!file) return { status: 'missing', relativePath, expectedSha256: expectedHash, actualSha256: null }
  if (!file.isFile() || file.isSymbolicLink()) {
    return { status: 'corrupt', relativePath, expectedSha256: expectedHash, actualSha256: null, error: '证据不是普通文件' }
  }
  try {
    const actualSha256 = await sha256File(path)
    return { status: actualSha256 === expectedHash ? 'available' : 'corrupt', relativePath,
      expectedSha256: expectedHash, actualSha256 }
  } catch (error) {
    return { status: 'error', relativePath, expectedSha256: expectedHash, actualSha256: null, error: errorMessage(error) }
  }
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function validateSnapshot(text: string, expectedCount?: number, manualJson = false): { input: WorkBuddyIngestInput | ManualJsonSnapshotInput } {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('结构化快照不是 JSON 对象')
  const record = value as Record<string, unknown>
  if (record.schema_version !== SNAPSHOT_VERSION) throw new Error('结构化快照版本不支持')
  if (manualJson) {
    const input = validateManualJsonSnapshot(record.input)
    if (expectedCount !== undefined && input.messages.length !== expectedCount) throw new Error('手动 JSON 快照数量不一致')
    return { input }
  }
  const validated = workBuddyIngestSchema.safeParse(record.input)
  if (!validated.success) throw new Error('结构化快照消息格式无效')
  const input = record.input as WorkBuddyIngestInput
  if (expectedCount !== undefined && input.messages.length !== expectedCount) throw new Error('结构化快照消息数量不一致')
  return { input }
}

function jsonValue(value: unknown, visited = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (visited.has(value)) throw new Error('快照包含循环引用')
    visited.add(value)
    const array = value.map((entry) => jsonValue(entry, visited))
    visited.delete(value)
    return array
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('快照包含非 JSON 对象')
    if (visited.has(value)) throw new Error('快照包含循环引用')
    visited.add(value)
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = jsonValue(source[key], visited)
    }
    visited.delete(value)
    return sorted
  }
  throw new Error('快照包含非 JSON 值')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}
