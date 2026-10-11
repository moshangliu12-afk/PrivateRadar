import { sharedJsonFixture, createSharedJsonItem, saveSharedJsonRaw, sharedJsonItem, sharedEvidenceBytes } from './shared-json-evidence-fixture'
import { sharedRows, sharedCount, sharedCoreState, sharedCoreFixture, sharedCoreItems, ingestSharedCore } from './shared-core-fixture'
import { configureMacEvidenceRoot, saveMacJsonRaw, saveMacJsonSnapshot, verifyMacJsonEvidence } from '../src/main/batch-import/mac-json-evidence'
import { createManualJsonSnapshot } from '../src/main/import/manual-json-contract'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { DIRECTORY_EVIDENCE_LIMITS, saveDirectoryEvidence, verifyDirectoryEvidence, type DirectoryManifest } from '../src/main/batch-import/directory-evidence'
import { loadStructuredSnapshot, saveOriginalZip, saveStructuredSnapshot, verifyBatchEvidence } from '../src/main/batch-import/evidence'
import { WindowsPathLease } from '../src/main/batch-import/windows-path-lease'
import { importSavedBatchItem } from '../src/main/batch-import/import-item'
import { executeBatchImportSession, resumeInterruptedBatchImportSession } from '../src/main/batch-import/session'
import { parseWorkBuddyChatHistoryText } from '../src/main/import/workbuddy-chat-history'

// 用可替换的模块包装注入故障，生产服务没有测试回调或绕过安全检查的开关。
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>()
}))

const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture(files: Record<string, string | Buffer> = { '聊天记录.txt': '原文\r\n' }) {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-directory-'))
  directories.push(directory)
  const databasePath = join(directory, 'private-radar.db')
  const db = new DatabaseSync(databasePath)
  databases.push(db)
  initializeDatabase(db)
  const source = join(directory, '明确源目录')
  mkdirSync(source)
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(source, path)), { recursive: true })
    writeFileSync(join(source, path), value)
  }
  const session = createBatchImportSession(db, 'workbuddy')
  const id = createBatchImportItem(db, session.id, 0).id
  const target = join(directory, 'evidence', id)
  return { directory, databasePath, db, source, session, id, target }
}
type Fixture = ReturnType<typeof fixture>
function save(f: Fixture, overrides: Parameters<typeof saveDirectoryEvidence>[4] = {}) {
  return saveDirectoryEvidence(f.db, f.databasePath, f.id, f.source, overrides)
}
function manifest(f: Fixture): DirectoryManifest { return JSON.parse(readFileSync(join(f.target, 'manifest.json'), 'utf8')) as DirectoryManifest }
function input() {
  const parsed = parseWorkBuddyChatHistoryText('·发送人\n2001年1月16日 17:00\n  inline 原始正文 😀\n第二段\n', { expectedMessageCount: 1 })
  return { messages: parsed.messages }
}
function notReady(f: Fixture) {
  expect(f.db.prepare('SELECT evidence_status FROM batch_import_items WHERE id = ?').get(f.id)).not.toEqual({ evidence_status: 'available' })
  expect(existsSync(f.target)).toBe(false)
  if (existsSync(join(f.directory, 'evidence'))) expect(readdirSync(join(f.directory, 'evidence'))).toEqual([])
}

describe('目录证据：隔离固定磁盘上的持久快照', () => {
  it.skipIf(process.platform !== 'win32')('单文件目录先保存证据，未保存快照时不能进入导入器', async () => {
    const f = fixture()
    const result = await save(f)
    expect(result.relativePath).toBe(`evidence/${f.id}/manifest.json`)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest(f)).toMatchObject({ manifest_version: 1, source_kind: 'directory', total_file_count: 1, total_bytes: 8 })
    expect(manifest(f).files[0].sha256).toBe(createHash('sha256').update(readFileSync(join(f.source, '聊天记录.txt'))).digest('hex'))
    expect(readFileSync(join(f.target, 'source', '聊天记录.txt'))).toEqual(readFileSync(join(f.source, '聊天记录.txt')))
    expect((await verifyDirectoryEvidence(f.db, f.databasePath, f.id)).status).toBe('available')
    await expect(importSavedBatchItem(f.db, f.databasePath, f.id)).rejects.toThrow('pending')
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM import_jobs').get()).toEqual({ count: 0 })
  }, 30000)

  it.skipIf(process.platform !== 'win32')('保留多层目录、Unicode 名称、大小写、空文件和空目录，附件只复制字节', async () => {
    const f = fixture({ '图片/中文 😀.bin': Buffer.from([0, 255, 4]), '文件/Paper.PDF': '%PDF-不可解析', '空文件': '' })
    mkdirSync(join(f.source, '空目录', '二层'), { recursive: true })
    await save(f)
    expect(manifest(f).files.map((file) => file.path)).toEqual(['图片/中文 😀.bin', '文件/Paper.PDF', '空文件'])
    expect(manifest(f).directories).toEqual(['图片', '文件', '空目录', '空目录/二层'])
    expect(readFileSync(join(f.target, 'source', '图片', '中文 😀.bin'))).toEqual(Buffer.from([0, 255, 4]))
    expect(existsSync(join(f.target, 'original.zip'))).toBe(false)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('相同内容不同绝对路径和创建顺序产生相同清单，两个实例独立保存', async () => {
    const f = fixture({ '乙.txt': '乙', '甲.txt': '甲' })
    const other = join(f.directory, '第二个明确目录')
    mkdirSync(other)
    writeFileSync(join(other, '甲.txt'), '甲')
    writeFileSync(join(other, '乙.txt'), '乙')
    const id = createBatchImportItem(f.db, f.session.id, 1).id
    const a = await save(f)
    const original = fs.opendir
    vi.spyOn(fs, 'opendir').mockImplementation((async (...args: Parameters<typeof fs.opendir>) => {
      const entries: Dirent[] = []
      for await (const entry of await original(...args)) entries.push(entry)
      return { async *[Symbol.asyncIterator]() { yield* entries.reverse() } }
    }) as unknown as typeof fs.opendir)
    const b = await saveDirectoryEvidence(f.db, f.databasePath, id, other)
    expect(a.sha256).toBe(b.sha256)
    expect(a.relativePath).not.toBe(b.relativePath)
    const text = readFileSync(join(f.target, 'manifest.json'), 'utf8')
    expect(text).toBe(readFileSync(join(f.directory, 'evidence', id, 'manifest.json'), 'utf8'))
    expect(text).not.toContain(f.directory)
    expect(text).not.toContain(f.id)
    expect(text).not.toContain('mtime')
  }, 30000)

  it.skipIf(process.platform !== 'win32').each(['内容', '重命名', '空目录'])('改变%s改变内容身份', async (change) => {
    const f = fixture()
    const a = await save(f)
    if (change === '内容') writeFileSync(join(f.source, '聊天记录.txt'), '新正文')
    if (change === '重命名') renameSync(join(f.source, '聊天记录.txt'), join(f.source, '新名称.txt'))
    if (change === '空目录') mkdirSync(join(f.source, '新增空目录'))
    const id = createBatchImportItem(f.db, f.session.id, 1).id
    const b = await saveDirectoryEvidence(f.db, f.databasePath, id, f.source)
    expect(a.sha256).not.toBe(b.sha256)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('只修改 mtime 不改变身份，重复保存不改写已发布目录', async () => {
    const f = fixture()
    const a = await save(f)
    const before = readFileSync(join(f.target, 'manifest.json'))
    utimesSync(join(f.source, '聊天记录.txt'), new Date(0), new Date(0))
    expect(await save(f)).toEqual(a)
    expect(readFileSync(join(f.target, 'manifest.json'))).toEqual(before)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('同一项不同内容冲突，保留旧证据及数据库身份', async () => {
    const f = fixture()
    const first = await save(f)
    writeFileSync(join(f.source, '聊天记录.txt'), '不同内容')
    await expect(save(f)).rejects.toThrow('不同内容身份')
    expect(manifest(f).directory_content_identity).toBe(first.sha256)
    expect((await verifyDirectoryEvidence(f.db, f.databasePath, f.id)).status).toBe('available')
  }, 30000)

  it.skipIf(process.platform !== 'win32')('原临时目录删除并重开数据库后，只用持久副本仍可验证', async () => {
    const f = fixture()
    await save(f)
    rmSync(f.source, { recursive: true })
    f.db.close()
    databases.pop()
    const reopened = new DatabaseSync(f.databasePath)
    databases.push(reopened)
    initializeDatabase(reopened)
    expect((await verifyDirectoryEvidence(reopened, f.databasePath, f.id)).status).toBe('available')
  }, 30000)

  it.skipIf(process.platform !== 'win32').each(['正文', '删除', '新增', '重命名', '空目录新增', '空目录删除'])('检测持久 source 篡改：%s', async (change) => {
    const f = fixture()
    mkdirSync(join(f.source, '空目录'))
    await save(f)
    const root = join(f.target, 'source'), file = join(root, '聊天记录.txt')
    // 与原文同为 8 字节，必须依靠内容哈希发现篡改。
    if (change === '正文') writeFileSync(file, '改写\r\n')
    if (change === '删除') unlinkSync(file)
    if (change === '新增') writeFileSync(join(root, '额外.txt'), '额外')
    if (change === '重命名') renameSync(file, join(root, '换名.txt'))
    if (change === '空目录新增') mkdirSync(join(root, '额外空目录'))
    if (change === '空目录删除') rmSync(join(root, '空目录'), { recursive: true })
    expect((await verifyDirectoryEvidence(f.db, f.databasePath, f.id)).status).toBe('corrupt')
  }, 30000)

  it.skipIf(process.platform !== 'win32').each(['hash', '路径', '身份', '版本', '计数'])('检测 manifest 篡改：%s', async (change) => {
    const f = fixture()
    await save(f)
    const record = manifest(f)
    if (change === 'hash') record.files[0].sha256 = '0'.repeat(64)
    if (change === '路径') record.files[0].path = '../越界.txt'
    if (change === '身份') record.directory_content_identity = '0'.repeat(64)
    if (change === '版本') Object.assign(record, { manifest_version: 2 })
    if (change === '计数') record.total_file_count++
    writeFileSync(join(f.target, 'manifest.json'), JSON.stringify(record) + '\n')
    expect((await verifyDirectoryEvidence(f.db, f.databasePath, f.id)).status).toBe('corrupt')
  }, 30000)

  it.skipIf(process.platform !== 'win32').each(['source', 'manifest.json'])('缺少持久 %s 判为缺失', async (part) => {
    const f = fixture()
    await save(f)
    rmSync(join(f.target, part), { recursive: true })
    expect((await verifyDirectoryEvidence(f.db, f.databasePath, f.id)).status).toBe('missing')
  }, 30000)

  it.each(['根', '子目录', '祖先'])('真实 junction 出现在%s时拒绝，不读取外部正文', async (kind) => {
    const f = fixture()
    const outside = join(f.directory, '外部')
    mkdirSync(outside)
    writeFileSync(join(outside, '不应读取.txt'), '外部正文')
    let source = f.source
    if (kind === '根') { rmSync(f.source, { recursive: true }); symlinkSync(outside, f.source, 'junction') }
    if (kind === '子目录') symlinkSync(outside, join(f.source, '链接'), 'junction')
    if (kind === '祖先') {
      mkdirSync(join(outside, '普通子目录'))
      const junction = join(f.directory, '祖先链接')
      symlinkSync(outside, junction, 'junction')
      source = join(junction, '普通子目录')
    }
    await expect(saveDirectoryEvidence(f.db, f.databasePath, f.id, source)).rejects.toThrow()
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('拒绝文件符号链接；无创建权限时验证 lstat 拒绝分支', async () => {
    const f = fixture()
    const link = join(f.source, '文件链接')
    try { symlinkSync(join(f.source, '聊天记录.txt'), link, 'file') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      const original = fs.lstat
      vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await original(...args)
        if (String(args[0]) === join(f.source, '聊天记录.txt')) return new Proxy(stat, { get(target, key) {
          if (key === 'isSymbolicLink') return () => true
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        } })
        return stat
      }) as typeof fs.lstat)
    }
    await expect(save(f)).rejects.toThrow('链接')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('拒绝特殊文件系统项，不能静默跳过', async () => {
    const f = fixture()
    const original = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args)
      if (String(args[0]) === join(f.source, '聊天记录.txt')) return new Proxy(stat, { get(target, key) {
        if (key === 'isFile' || key === 'isDirectory') return () => false
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      return stat
    }) as typeof fs.lstat)
    await expect(save(f)).rejects.toThrow('特殊')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32').each(['../猜目录', 'C:\\目录\\..\\逃逸', '\\\\server\\share', '\\\\?\\C:\\设备', 'C:\\目录:流'])('拒绝不安全源路径 %s', async (path) => {
    const f = fixture()
    await expect(saveDirectoryEvidence(f.db, f.databasePath, f.id, path)).rejects.toThrow('路径')
    notReady(f)
  })

  it.skipIf(process.platform !== 'win32')('拒绝源目录包含证据目录，避免递归复制自身', async () => {
    const f = fixture()
    await expect(saveDirectoryEvidence(f.db, f.databasePath, f.id, f.directory)).rejects.toThrow('相互包含')
    notReady(f)
  })

  it.skipIf(process.platform !== 'win32').each([
    ['深度', { maxDepth: 0 }], ['数量', { maxFileCount: 0 }],
    ['单文件', { maxFileBytes: 1 }], ['总字节', { maxTotalBytes: 1 }],
    ['目录项', { maxEntries: 0 }], ['清单', { maxManifestBytes: 1 }]
  ] as const)('资源%s超限时整项失败且清理暂存', async (_label, bound) => {
    const f = fixture()
    await expect(save(f, bound)).rejects.toThrow('超限')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('不能通过参数提高集中资源上限', async () => {
    const f = fixture()
    await expect(save(f, { maxFileCount: DIRECTORY_EVIDENCE_LIMITS.maxFileCount + 1 })).rejects.toThrow('限制参数')
    notReady(f)
  })

  it.each(['删除', '改写', '新增', '重命名', '新增目录'])('复制期间源%s会被句柄阻止或二次清单检测', async (change) => {
    const f = fixture()
    const original = WindowsPathLease.prototype.copyFile
    vi.spyOn(WindowsPathLease.prototype, 'copyFile').mockImplementation(async function (this: WindowsPathLease, ...args) {
      await original.apply(this, args)
      const file = join(f.source, '聊天记录.txt')
      if (change === '删除') unlinkSync(file)
      if (change === '改写') writeFileSync(file, '变化')
      if (change === '新增') writeFileSync(join(f.source, '新增.txt'), '变化')
      if (change === '重命名') renameSync(file, join(f.source, '换名.txt'))
      if (change === '新增目录') mkdirSync(join(f.source, '新增目录'))
    })
    await expect(save(f)).rejects.toThrow()
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('部分复制失败清理 staging，重试可恢复', async () => {
    const f = fixture({ 'A': '甲', 'B': '乙' })
    const original = WindowsPathLease.prototype.copyFile
    let calls = 0
    vi.spyOn(WindowsPathLease.prototype, 'copyFile').mockImplementation(async function (this: WindowsPathLease, ...args) {
      if (++calls === 2) throw new Error('模拟复制失败')
      await original.apply(this, args)
    })
    await expect(save(f)).rejects.toThrow('模拟复制失败')
    notReady(f)
    vi.restoreAllMocks()
    await save(f)
    expect(f.db.prepare('SELECT status, evidence_status FROM batch_import_items WHERE id = ?').get(f.id)).toEqual({ status: 'pending', evidence_status: 'available' })
  }, 30000)

  it.skipIf(process.platform !== 'win32')('staging 内容不匹配时不发布', async () => {
    const f = fixture()
    const original = WindowsPathLease.prototype.copyFile
    vi.spyOn(WindowsPathLease.prototype, 'copyFile').mockImplementation(async function (this: WindowsPathLease, ...args) {
      await original.apply(this, args)
      writeFileSync(String(args[1]), '损坏副本')
    })
    await expect(save(f)).rejects.toThrow('不一致')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('原子发布失败清理暂存，不登记 ready', async () => {
    const f = fixture()
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('模拟发布失败'))
    await expect(save(f)).rejects.toThrow('模拟发布失败')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('不覆盖或接管已有孤立目录', async () => {
    const f = fixture()
    mkdirSync(f.target, { recursive: true })
    writeFileSync(join(f.target, '旧文件'), '不可覆盖')
    await expect(save(f)).rejects.toThrow('禁止覆盖')
    expect(readFileSync(join(f.target, '旧文件'), 'utf8')).toBe('不可覆盖')
  }, 30000)

  it.skipIf(process.platform !== 'win32')('安全句柄能力不可用时拒绝，不降级复制', async () => {
    const f = fixture()
    vi.spyOn(WindowsPathLease.prototype, 'lock').mockRejectedValue(new Error('模拟原生能力不可用'))
    await expect(save(f)).rejects.toThrow('原生能力不可用')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('原生桥接进程退出后拒绝复制，清理暂存而不降级', async () => {
    const f = fixture()
    const original = WindowsPathLease.prototype.copyFile
    vi.spyOn(WindowsPathLease.prototype, 'copyFile').mockImplementation(async function (this: WindowsPathLease, ...args) {
      // 租约关闭不再代表共享 helper 退出；只终止本用例创建的隔离辅助进程。
      const helper = (this as unknown as { runtime: { process: import('node:child_process').ChildProcessWithoutNullStreams } }).runtime.process
      const exited = new Promise<void>((done) => helper.once('close', () => done()))
      helper.kill()
      await exited
      await original.apply(this, args)
    })
    await expect(save(f)).rejects.toThrow('退出')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('真实多重硬链接被原生句柄拒绝，不复制外部共享内容', async () => {
    const f = fixture()
    linkSync(join(f.source, '聊天记录.txt'), join(f.directory, '外部硬链接.txt'))
    await expect(save(f)).rejects.toThrow('硬链接')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('实际名称不同的大小写路径别名拒绝，不按模糊名称接受句柄', async () => {
    const f = fixture()
    const actual = join(f.directory, 'SourceFolder')
    renameSync(f.source, actual)
    await expect(saveDirectoryEvidence(f.db, f.databasePath, f.id, join(f.directory, 'SOURCEFOLDER'))).rejects.toThrow('实际文件名不匹配')
    notReady(f)
  }, 30000)

  it.skipIf(process.platform !== 'win32')('持久 source 被换成 junction 后校验失败', async () => {
    const f = fixture()
    await save(f)
    rmSync(join(f.target, 'source'), { recursive: true })
    symlinkSync(f.source, join(f.target, 'source'), 'junction')
    expect((await verifyDirectoryEvidence(f.db, f.databasePath, f.id)).status).toBe('corrupt')
  }, 30000)

  it.skipIf(process.platform !== 'win32')('ZIP 与目录之间禁止替换，原 ZIP 哈希和路径不变', async () => {
    const f = fixture()
    const zip = join(f.directory, 'original-input.zip')
    writeFileSync(zip, '旧 ZIP 字节')
    const stored = await saveOriginalZip(f.db, f.databasePath, f.id, zip)
    await expect(save(f)).rejects.toThrow('已有 ZIP')
    expect((await verifyBatchEvidence(f.db, f.databasePath, f.id)).zip.actualSha256).toBe(stored.sha256)
    const id = createBatchImportItem(f.db, f.session.id, 1).id
    await saveDirectoryEvidence(f.db, f.databasePath, id, f.source)
    await expect(saveOriginalZip(f.db, f.databasePath, id, zip)).rejects.toThrow('不能被 ZIP')
  }, 30000)

  it.skipIf(process.platform !== 'win32')('messages.json 来自 inline Parser，不重解析证据 TXT；源清理后导入与重放稳定', async () => {
    const f = fixture({ '聊天记录.txt': '此 TXT 故意不等于 inline，且没有日期' })
    await expect(saveStructuredSnapshot(f.db, f.databasePath, f.id, input())).rejects.toThrow()
    await save(f)
    await saveStructuredSnapshot(f.db, f.databasePath, f.id, input())
    expect(await loadStructuredSnapshot(f.db, f.databasePath, f.id)).toEqual(input())
    const verified = await verifyBatchEvidence(f.db, f.databasePath, f.id)
    expect(verified).toMatchObject({ status: 'available', sourceKind: 'directory', zip: { relativePath: null, expectedSha256: null }, snapshot: { messageCount: 1 } })
    rmSync(f.source, { recursive: true })
    const first = await importSavedBatchItem(f.db, f.databasePath, f.id)
    expect(first).toMatchObject({ importedCount: 1, duplicateCount: 0 })
    const second = await importSavedBatchItem(f.db, f.databasePath, f.id, 'deterministic_replay')
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 1 })
    expect(f.db.prepare('SELECT content, sender_name, timestamp_source, source_position FROM messages').get()).toEqual({
      content: input().messages[0].content.trim(), sender_name: '·发送人', timestamp_source: 'source_native', source_position: 0
    })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()).toEqual({ count: 1 })
  }, 90000)

  it.skipIf(process.platform !== 'win32')('两个目录项仍由既有会话执行，不合并相同内容实例', async () => {
    const f = fixture()
    const id = createBatchImportItem(f.db, f.session.id, 1).id
    for (const itemId of [f.id, id]) {
      await saveDirectoryEvidence(f.db, f.databasePath, itemId, f.source)
      await saveStructuredSnapshot(f.db, f.databasePath, itemId, input())
    }
    const result = await executeBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(result).toMatchObject({ status: 'success', attachments_total: 2, imported_total: 2 })
    expect(f.db.prepare('SELECT COUNT(DISTINCT source_batch_id) AS count FROM messages').get()).toEqual({ count: 2 })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM import_jobs').get()).toEqual({ count: 2 })
  }, 120000)

  it.skipIf(process.platform !== 'win32')('中断会话仅恢复尚未开始的目录项，不重跑已成功项', async () => {
    const f = fixture()
    const id = createBatchImportItem(f.db, f.session.id, 1).id
    for (const itemId of [f.id, id]) {
      await saveDirectoryEvidence(f.db, f.databasePath, itemId, f.source)
      await saveStructuredSnapshot(f.db, f.databasePath, itemId, input())
    }
    f.db.prepare("UPDATE batch_import_sessions SET status = 'in_progress' WHERE id = ?").run(f.session.id)
    await importSavedBatchItem(f.db, f.databasePath, f.id)
    const resumed = await resumeInterruptedBatchImportSession(f.db, f.databasePath, f.session.id)
    expect(resumed).toMatchObject({ status: 'success', imported_total: 2 })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM import_jobs').get()).toEqual({ count: 2 })
  }, 120000)

  it.skipIf(process.platform !== 'win32')('目录证据被篡改后禁止快照保存及 importer，消息和任务均不写入', async () => {
    const f = fixture()
    await save(f)
    writeFileSync(join(f.target, 'source', '聊天记录.txt'), '篡改')
    await expect(saveStructuredSnapshot(f.db, f.databasePath, f.id, input())).rejects.toThrow('原始证据')
    expect(existsSync(join(f.target, 'messages.json'))).toBe(false)
    await expect(importSavedBatchItem(f.db, f.databasePath, f.id)).rejects.toThrow()
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM import_jobs').get()).toEqual({ count: 0 })
  }, 30000)

  it.skipIf(process.platform !== 'win32')('注册数据库失败时撤销本次发布，既无暂存也无 ready 记录', async () => {
    const f = fixture()
    const original = f.db.prepare.bind(f.db)
    vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
      const statement = original(sql)
      if (sql.includes("SET evidence_source_kind = 'directory'") && sql.includes('attachment_identity = ?, evidence_relative_path = ?')) {
        return new Proxy(statement, { get(target, key) {
          if (key === 'run') return () => { throw new Error('模拟登记失败') }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      }
      return statement
    })
    await expect(save(f)).rejects.toThrow('模拟登记失败')
    notReady(f)
  }, 30000)
})

describe('共享受控文件发布故障边界',()=>{
  function setup() {const f=sharedJsonFixture();configureMacEvidenceRoot(f.directory);const item=createSharedJsonItem(f);return {...f,item,target:join(f.directory,'evidence',item.id)}}
  // 漏跳：5、79、109；在 Windows 也直接运行现有受控发布单元，不启用外部目录入口。
  it('真实临时文件写入故障清理自己文件，后续正常保存可用',async()=>{
    const f=setup(),open=fs.open
    vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
      const handle=await open(...args)
      if(String(args[0]).includes('.mac-json-')&&String(args[0]).endsWith('.tmp')) vi.spyOn(handle,'writeFile').mockRejectedValueOnce(new Error('受控写入故障'))
      return handle
    })
    await expect(saveMacJsonRaw(f.db,f.path,f.item.id,Buffer.from('[]'))).rejects.toThrow('受控写入故障')
    expect(sharedJsonItem(f,f.item.id).evidence_relative_path).toBeNull();expect(readdirSync(f.target)).toEqual([])
    expect(sharedCount(f.db,'import_jobs')).toBe(0)
    vi.restoreAllMocks()
    await saveMacJsonRaw(f.db,f.path,f.item.id,Buffer.from('[]'));await saveMacJsonSnapshot(f.db,f.path,f.item.id,createManualJsonSnapshot(Buffer.from('[]')))
    expect((await verifyMacJsonEvidence(f.db,f.path,f.item.id)).status).toBe('available')
  })
  // 漏跳：80；修改本次实际临时字节，保留生产读回校验。
  it('临时文件字节不同阻止发布且清理本次 temporary',async()=>{
    const f=setup(),open=fs.open
    vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
      const handle=await open(...args)
      if(String(args[0]).includes('.mac-json-')&&String(args[0]).endsWith('.tmp')) {
        const write=handle.writeFile.bind(handle)
        vi.spyOn(handle,'writeFile').mockImplementation(async()=>{await write(Buffer.from('错误临时字节'))})
      }
      return handle
    })
    await expect(saveMacJsonRaw(f.db,f.path,f.item.id,Buffer.from('[]'))).rejects.toThrow()
    expect(sharedJsonItem(f,f.item.id).evidence_relative_path).toBeNull();expect(readdirSync(f.target)).toEqual([])
    expect(sharedCount(f.db,'import_jobs')).toBe(0)
  })
  // 漏跳：81、109；Mac 原子机制是 link，原 Windows rename 全部保留。
  it('真实 link 发布故障不登记，也不遗留本次临时文件',async()=>{
    const f=setup();vi.spyOn(fs,'link').mockRejectedValueOnce(new Error('受控发布故障'))
    await expect(saveMacJsonRaw(f.db,f.path,f.item.id,Buffer.from('[]'))).rejects.toThrow('受控发布故障')
    expect(sharedJsonItem(f,f.item.id).evidence_relative_path).toBeNull();expect(readdirSync(f.target)).toEqual([])
    expect(sharedCount(f.db,'import_jobs')).toBe(0)
  })
  // 漏跳：93、110；真正发布后由 SQLite trigger 拒绝登记。
  it('发布成功而登记 UPDATE 失败，撤销自己的 published 文件和临时文件',async()=>{
    const f=setup(),link=vi.spyOn(fs,'link')
    f.db.exec("CREATE TRIGGER reject_shared_raw BEFORE UPDATE OF evidence_relative_path ON batch_import_items WHEN new.evidence_relative_path IS NOT NULL BEGIN SELECT RAISE(ABORT,'登记故障'); END")
    await expect(saveMacJsonRaw(f.db,f.path,f.item.id,Buffer.from('[]'))).rejects.toThrow('登记故障')
    expect(link).toHaveBeenCalledTimes(1);expect(readdirSync(f.target)).toEqual([])
    expect(sharedJsonItem(f,f.item.id).evidence_relative_path).toBeNull();expect(sharedJsonItem(f,f.item.id).evidence_status).not.toBe('available')
    expect(sharedCount(f.db,'import_jobs')).toBe(0)
  })
  // 漏跳：92、136；受控 Raw 失效后不能再发布 snapshot，无新消息/Job/来源。
  it('Raw 篡改阻止真实 snapshot 发布，已有核心基线不变',async()=>{
    const f=setup(),bytes=Buffer.from('[{"content":"未知群名原文"}]')
    expect(ingestWorkBuddyMessages(f.db,{messages:[{content:'先前已有的真实核心原文'}]}).status).toBe('success')
    await saveMacJsonRaw(f.db,f.path,f.item.id,bytes)
    writeFileSync(join(f.target,'original.zip'),'隔离篡改')
    const before=sharedCoreState(f.db),bad=readFileSync(join(f.target,'original.zip'))
    await expect(saveMacJsonSnapshot(f.db,f.path,f.item.id,createManualJsonSnapshot(bytes))).rejects.toThrow()
    expect(existsSync(join(f.target,'messages.json'))).toBe(false)
    expect(sharedCoreState(f.db)).toEqual(before);expect(readFileSync(join(f.target,'original.zip'))).toEqual(bad)
    for(const table of ['import_jobs','messages','messages_fts']) expect(sharedCount(f.db,table)).toBe(1)
    expect(sharedCount(f.db,'batch_item_message_sources')).toBe(0)
  })
})

// 漏跳：89、90；只运行原 snapshot 输入的内部核心，不从证据 TXT 重解析，也不补群名。
describe('共享原解析记录的核心重放与弱来源身份',()=>{
  it('原空格、换行、sender/time/位置保全，同 Item duplicate-only，跨 Item 独立 canonical',()=>{
    const f=sharedCoreItems(sharedCoreFixture()),values=input().messages
    const a=ingestSharedCore(f,0,values),first=sharedRows(f.db,'messages'),fts=sharedRows(f.db,'messages_fts_data'),sources=sharedRows(f.db,'batch_item_message_sources')
    expect(a).toMatchObject({status:'success',importedCount:1,duplicateCount:0})
    expect(ingestSharedCore(f,0,values)).toMatchObject({status:'success',importedCount:0,duplicateCount:1})
    expect(sharedRows(f.db,'messages')).toEqual(first);expect(sharedRows(f.db,'messages_fts_data')).toEqual(fts);expect(sharedRows(f.db,'batch_item_message_sources')).toEqual(sources)
    expect(ingestSharedCore(f,1,values)).toMatchObject({status:'success',importedCount:1,duplicateCount:0})
    for(const item of f.items) expect(f.db.prepare('SELECT m.content,s.source_sender_name,s.source_timestamp,s.source_timestamp_source,s.source_position,s.source_conversation_name,s.source_conversation_name_source FROM batch_item_message_sources s JOIN messages m ON m.id=s.message_id WHERE s.batch_item_id=?').get(item.id))
      .toEqual({content:values[0].content!.trim(),source_sender_name:values[0].sender_name,source_timestamp:new Date(values[0].timestamp!).toISOString(),source_timestamp_source:'source_native',source_position:0,source_conversation_name:null,source_conversation_name_source:'unknown'})
    for(const table of ['messages','messages_fts','batch_item_message_sources']) expect(sharedCount(f.db,table)).toBe(2)
  })
})
