import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { EvidenceVerification, StoredEvidenceFile } from './evidence'
import { createManualJsonSnapshot, createManualJsonZip, getManualJsonItem, MANUAL_JSON_MAX_BYTES,
  validateManualJsonSnapshot, type ManualJsonSnapshotInput } from '../import/manual-json-contract'

let userDataRoot: string | null = null
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** 仅主进程启动时配置 Electron 的用户数据根；没有对应的渲染层入口。 */
export function configureMacEvidenceRoot(electronUserData: string): void {
  userDataRoot = resolve(electronUserData)
}

function paths(db: DatabaseSync, databasePath: string, id: string) {
  if (!userDataRoot || !ITEM_ID.test(id) || !getManualJsonItem(db, id) ||
      !db.location() || resolve(db.location()!) !== resolve(databasePath) ||
      resolve(dirname(databasePath)) !== userDataRoot) throw new Error('不支持的证据来源或受控目录')
  const directory = join(userDataRoot, 'evidence', id)
  return { directory, zip: join(directory, 'original.zip'), snapshot: join(directory, 'messages.json'),
    zipRelative: 'evidence/' + id + '/original.zip', snapshotRelative: 'evidence/' + id + '/messages.json' }
}

async function optionalStat(path: string): Promise<BigIntStats | null> {
  try { return await lstat(path, { bigint: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** 从文件系统根逐层检查祖先；不能只检查证据目录的最后一层。 */
async function directoryChain(path: string, create = false): Promise<Array<[string, BigIntStats]>> {
  const parent = dirname(path)
  const chain: Array<[string, BigIntStats]> = parent === path ? [] : await directoryChain(parent, create)
  let info = await optionalStat(path)
  if (!info && create) {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    info = await lstat(path, { bigint: true })
  }
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error('证据父目录不可用')
  chain.push([path, info])
  return chain
}

async function unchangedParents(chain: Array<[string, BigIntStats]>): Promise<void> {
  for (const [path, before] of chain) {
    const after = await lstat(path, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error('证据父目录发生变化')
    }
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

/** 固定受控文件用同一描述符限量读取，并检查读取期间的文件和父目录变化。 */
async function readControlled(path: string, maxBytes: number): Promise<Buffer> {
  const parents = await directoryChain(dirname(path)), selected = await lstat(path, { bigint: true })
  if (!selected.isFile() || selected.isSymbolicLink() || selected.size > BigInt(maxBytes)) throw new Error('证据不是受控普通文件')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await file.stat({ bigint: true })
    if (!sameFile(selected, before)) throw new Error('证据打开时发生变化')
    const blocks: Buffer[] = []
    let size = 0
    for (;;) {
      const block = Buffer.alloc(1024 * 1024), result = await file.read(block, 0, block.length, null)
      if (!result.bytesRead) break
      size += result.bytesRead
      if (size > maxBytes) throw new Error('证据容量超限')
      blocks.push(block.subarray(0, result.bytesRead))
    }
    if (BigInt(size) !== before.size || !sameFile(before, await file.stat({ bigint: true })) ||
        !sameFile(before, await lstat(path, { bigint: true }))) {
      throw new Error('证据读取时发生变化')
    }
    await unchangedParents(parents)
    return Buffer.concat(blocks, size)
  } finally { await file.close() }
}

async function publish(path: string, bytes: Buffer, register: () => void): Promise<void> {
  const parents = await directoryChain(dirname(path), true)
  const temporary = join(dirname(path), '.mac-json-' + randomUUID() + '.tmp')
  let owned: BigIntStats | null = null, published = false, registered = false
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    owned = await handle.stat({ bigint: true })
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  await handle.close()
  try {
    if (!(await readControlled(temporary, bytes.length)).equals(bytes)) throw new Error('临时证据校验失败')
    await unchangedParents(parents)
    // 目标存在时由文件系统原子拒绝；不使用可能覆盖的重命名降级。
    await link(temporary, path)
    published = true
    await unlink(temporary)
    await unchangedParents(parents)
    if (!(await readControlled(path, bytes.length)).equals(bytes)) throw new Error('发布证据校验失败')
    register()
    registered = true
  } finally {
    // 只清理本次发布的同一文件，不碰已登记证据或并发调用者的目标。
    const current = published && !registered ? await optionalStat(path).catch(() => null) : null
    if (current && owned && current.dev === owned.dev && current.ino === owned.ino) await unlink(path).catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

function item(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM batch_import_items WHERE id=?').get(id)
  if (!row || row.evidence_source_kind !== 'zip') throw new Error('不支持的证据类型')
  return row
}

async function raw(db: DatabaseSync, databasePath: string, id: string) {
  const p = paths(db, databasePath, id), row = item(db, id)
  if (row.evidence_status !== 'available' || row.evidence_relative_path !== p.zipRelative ||
      typeof row.attachment_identity !== 'string') throw new Error('原始证据未登记')
  const bytes = await readControlled(p.zip, MANUAL_JSON_MAX_BYTES + 120)
  if (hash(bytes) !== row.attachment_identity || bytes.length < 120 ||
      bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt16LE(26) !== 11) throw new Error('ZIP 证据校验失败')
  const size = bytes.readUInt32LE(22)
  if (size > MANUAL_JSON_MAX_BYTES || bytes.length !== size + 120) throw new Error('ZIP 证据容量不一致')
  const captured = bytes.subarray(41, 41 + size)
  // 与固定 ZIP 编码逐字节比较，同时覆盖名称、CRC、大小、目录、偏移和条目数量。
  if (!bytes.equals(createManualJsonZip(captured))) throw new Error('ZIP 不是固定原始 JSON 条目')
  return { p, row, captured, sha256: hash(bytes) }
}

export async function saveMacJsonRaw(db: DatabaseSync, databasePath: string, id: string, captured: Buffer): Promise<StoredEvidenceFile> {
  const p = paths(db, databasePath, id), row = item(db, id)
  if (captured.length > MANUAL_JSON_MAX_BYTES) throw new Error('原始 JSON 容量超限')
  const bytes = createManualJsonZip(captured), sha256 = hash(bytes)
  if (row.evidence_relative_path !== null) {
    if ((await raw(db, databasePath, id)).sha256 !== sha256) throw new Error('禁止替换已登记原始证据')
  } else {
    await publish(p.zip, bytes, () => {
      const updated = db.prepare("UPDATE batch_import_items SET attachment_identity=?,evidence_relative_path=?,evidence_status='available',updated_at=? WHERE id=? AND evidence_relative_path IS NULL AND evidence_source_kind='zip'")
        .run(sha256, p.zipRelative, new Date().toISOString(), id)
      if (updated.changes !== 1) throw new Error('原始证据登记冲突')
    })
  }
  return { relativePath: p.zipRelative, sha256 }
}

export async function saveMacJsonSnapshot(db: DatabaseSync, databasePath: string, id: string, input: ManualJsonSnapshotInput): Promise<StoredEvidenceFile> {
  const evidence = await raw(db, databasePath, id), expected = createManualJsonSnapshot(evidence.captured)
  const validated = validateManualJsonSnapshot(input)
  if (!snapshotEqual(validated, expected)) throw new Error('快照与原始 JSON 不一致')
  const bytes = Buffer.from(JSON.stringify({ schema_version: 1, input: validated }) + '\n'), sha256 = hash(bytes)
  if (evidence.row.snapshot_relative_path !== null) {
    const existing = await loadMacJsonSnapshot(db, databasePath, id)
    if (!snapshotEqual(existing, expected)) throw new Error('禁止替换已登记快照')
    return { relativePath: evidence.p.snapshotRelative, sha256: String(evidence.row.snapshot_sha256) }
  }
  await publish(evidence.p.snapshot, bytes, () => {
    const updated = db.prepare('UPDATE batch_import_items SET snapshot_relative_path=?,snapshot_sha256=?,updated_at=? WHERE id=? AND snapshot_relative_path IS NULL')
      .run(evidence.p.snapshotRelative, sha256, new Date().toISOString(), id)
    if (updated.changes !== 1) throw new Error('快照登记冲突')
  })
  return { relativePath: evidence.p.snapshotRelative, sha256 }
}

function snapshotEqual(a: ManualJsonSnapshotInput, b: ManualJsonSnapshotInput): boolean {
  // 对象键顺序不属于来源语义；只比较同一原始记录的 JSON 结构和原始字符串。
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]))
    return value
  }
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
}

export async function loadMacJsonSnapshot(db: DatabaseSync, databasePath: string, id: string): Promise<ManualJsonSnapshotInput> {
  const evidence = await raw(db, databasePath, id)
  if (evidence.row.snapshot_relative_path !== evidence.p.snapshotRelative || typeof evidence.row.snapshot_sha256 !== 'string') throw new Error('快照未登记')
  const bytes = await readControlled(evidence.p.snapshot, MANUAL_JSON_MAX_BYTES * 8 + 1024)
  if (hash(bytes) !== evidence.row.snapshot_sha256) throw new Error('快照摘要不一致')
  const payload = JSON.parse(bytes.toString('utf8')) as { schema_version: unknown; input: unknown }
  if (payload.schema_version !== 1) throw new Error('快照版本不支持')
  const input = validateManualJsonSnapshot(payload.input)
  if (!snapshotEqual(input, createManualJsonSnapshot(evidence.captured))) throw new Error('快照和原始证据关系不一致')
  return input
}

export async function verifyMacJsonEvidence(db: DatabaseSync, databasePath: string, id: string): Promise<EvidenceVerification> {
  const row = db.prepare('SELECT * FROM batch_import_items WHERE id=?').get(id)
  const kind = row?.evidence_source_kind === 'directory' ? 'directory' : 'zip'
  const unavailable = { status: 'error' as const, relativePath: null, expectedSha256: null, actualSha256: null,
    error: '此平台的证据不可用或来源类型尚未支持' }
  let verifiedSource = unavailable as EvidenceVerification['source']
  try {
    const source = await raw(db, databasePath, id)
    const zip = { status: 'available' as const, relativePath: source.p.zipRelative, expectedSha256: source.sha256, actualSha256: source.sha256 }
    verifiedSource = zip
    const input = await loadMacJsonSnapshot(db, databasePath, id)
    const snapshot = { status: 'available' as const, relativePath: source.p.snapshotRelative,
      expectedSha256: String(source.row.snapshot_sha256), actualSha256: String(source.row.snapshot_sha256), messageCount: input.messages.length }
    return { itemId: id, sourceKind: 'zip', status: 'available', source: zip, zip, snapshot }
  } catch {
    return { itemId: id, sourceKind: kind, status: 'error', source: verifiedSource, zip: verifiedSource, snapshot: unavailable,
      ...(kind === 'directory' ? { directory: unavailable } : {}) }
  }
}

export async function openMacJsonEvidence(db: DatabaseSync, databasePath: string, id: string, openPath: (path: string) => Promise<string>): Promise<void> {
  const p = paths(db, databasePath, id), parents = await directoryChain(p.directory)
  if ((await verifyMacJsonEvidence(db, databasePath, id)).status !== 'available') throw new Error('证据不可用')
  await unchangedParents(parents)
  if (await openPath(p.directory)) throw new Error('证据目录无法打开')
}
