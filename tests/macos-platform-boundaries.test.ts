import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { importChatFile } from '../src/main/import/importer'
import { configureMacEvidenceRoot } from '../src/main/batch-import/mac-json-evidence'
import { loadManualJsonSnapshot, saveCapturedJsonEvidence, saveStructuredSnapshot, verifyBatchEvidence } from '../src/main/batch-import/evidence'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { saveDirectoryEvidence, verifyDirectoryEvidence } from '../src/main/batch-import/directory-evidence'
import { createManualJsonSnapshot, createManualJsonZip } from '../src/main/import/manual-json-contract'
import { openBatchItemEvidence, openKeywordHitEvidence } from '../src/main/keyword-radar/evidence-navigation'
import { openCommitmentCandidateEvidence } from '../src/main/commitment/evidence-navigation'
import { listRecentKeywordHits } from '../src/main/keyword-radar/desktop'
import { listCommitmentCandidates } from '../src/main/commitment/desktop'
import { addKeywordTerm, createKeywordGroup } from '../src/main/keyword-radar/config'
import * as lease from '../src/main/batch-import/windows-path-lease'
import { manualImportDialogOptions, macEditMenu } from '../src/main/desktop-platform'
import { getFirstUseStatus, markConnectorHeartbeat } from '../src/main/first-use'
import * as deployment from '../src/main/deployment'
import type { ManualJsonImportResult } from '../src/main/import/manual-json'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/main/deployment', async original => ({ ...await original<typeof import('../src/main/deployment')>() }))
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const fixtures: Array<{ db: DatabaseSync; directory: string; path: string }> = []
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function platform(value: 'darwin' | 'win32') { Object.defineProperty(process, 'platform', { ...originalPlatform, value }) }
async function flush() { for (let i = 0; i < 12; i++) await new Promise<void>(done => setImmediate(done)) }
afterEach(async () => {
  await flush()
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    if (f.db.isOpen) f.db.close()
    expect(dirname(resolve(f.directory))).toBe(resolve(tmpdir()))
    expect(basename(f.directory)).toMatch(/^privateradar-stage2b-/)
    rmSync(f.directory, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-stage2b-')), path = join(directory, 'private-radar.db')
  const db = new DatabaseSync(path); initializeDatabase(db)
  configureMacEvidenceRoot(directory)
  const f = { directory, path, db }; fixtures.push(f); return f
}
function bytes(count = 1) {
  return Buffer.from(JSON.stringify(Array.from({ length: count }, (_, i) => ({
    conversation_name: '隔离聊天', sender_name: '测试人', timestamp: '2026-10-01T09:00:00+08:00',
    content: '我会把文件' + i + '整理好发给你'
  }))))
}
function manualItem(f: ReturnType<typeof fixture>) {
  const session = createBatchImportSession(f.db, 'file'), item = createBatchImportItem(f.db, session.id, 0)
  f.db.prepare("UPDATE batch_import_items SET source_batch_id='file:json:item:' || id WHERE id=?").run(item.id)
  return item.id
}
async function imported(f: ReturnType<typeof fixture>, count = 1) {
  const source = join(f.directory, '所选原文.json'); writeFileSync(source, bytes(count))
  const result = await importChatFile(f.db, source, f.path) as ManualJsonImportResult
  await flush()
  expect(result.status).toBe('success')
  return result
}
function stored(f: ReturnType<typeof fixture>, id: string) { return f.db.prepare('SELECT * FROM batch_import_items WHERE id=?').get(id)! }
function filePaths(f: ReturnType<typeof fixture>, id: string) {
  const directory = join(f.directory, 'evidence', id)
  return { directory, zip: join(directory, 'original.zip'), snapshot: join(directory, 'messages.json') }
}
async function refused(f: ReturnType<typeof fixture>, id: string) {
  const open = vi.fn(async () => ''), before = stored(f, id)
  await expect(openBatchItemEvidence(f.db, f.path, id, open)).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
  expect(stored(f, id)).toEqual(before)
}

describe('桌面文件入口和编辑菜单平台边界', () => {
  it('Mac 文件选择器只显示 JSON', () => {
    platform('darwin')
    expect(manualImportDialogOptions()).toMatchObject({ title: '选择 JSON 原始证据', filters: [{ extensions: ['json'] }] })
  })
  it.each(['csv', 'txt', 'zip', 'exe'])('Mac 主进程拒绝绕过选择器的 %s，拒绝前不读源文件或登记任务', async extension => {
    platform('darwin'); const f = fixture(), read = vi.spyOn(fs, 'open')
    await expect(importChatFile(f.db, join(f.directory, '不存在.' + extension), f.path)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT count(*) AS n FROM import_jobs').get()!.n).toBe(0)
  })
  it('Windows 选择器保持三格式，CSV/TXT 保持旧无附件导入', async () => {
    platform('win32'); const f = fixture()
    expect(manualImportDialogOptions().filters).toEqual([{ name: '聊天记录', extensions: ['json', 'csv', 'txt'] }])
    for (const [name, content] of [['旧.csv', 'conversation_name,sender_name,timestamp,content\n群,甲,2026-10-01T09:00:00+08:00,旧 CSV 原文'],
      ['旧.txt', '[2026-10-01 09:00:00] 群 | 甲: 旧 TXT 原文']]) {
      const path = join(f.directory, name); writeFileSync(path, content)
      expect(await importChatFile(f.db, path, f.path)).toMatchObject({
        fileType: name.endsWith('.csv') ? 'CSV' : 'TXT', status: 'success', importedCount: 1
      })
    }
    expect(f.db.prepare('SELECT count(*) AS n FROM batch_import_items').get()!.n).toBe(0)
    await imported(f)
    expect(f.db.prepare('SELECT count(*) AS n FROM batch_import_items').get()!.n).toBe(1)
  })
  it('Mac 编辑菜单提供角色和 Command 快捷键', () => {
    const menu = macEditMenu(), edit = menu.find(entry => entry.label === '编辑')!.submenu as Array<{ role: string; accelerator: string }>
    expect(edit).toEqual(expect.arrayContaining([
      { role: 'cut', accelerator: 'Command+X' }, { role: 'copy', accelerator: 'Command+C' },
      { role: 'paste', accelerator: 'Command+V' }, { role: 'selectAll', accelerator: 'Command+A' }
    ]))
  })
})

describe('Mac 受控 ZIP 证据验证与来源导航', () => {
  it('真实临时来源导入、Hit/Candidate 都打开本 Item 固定目录，不使用 Windows 租约', async () => {
    platform('darwin'); const f = fixture()
    addKeywordTerm(f.db, createKeywordGroup(f.db, '测试关键词').id, '文件')
    const lock = vi.spyOn(lease.WindowsPathLease.prototype, 'lock'), runtime = vi.spyOn(lease, 'withRequestScopedWindowsPathLeaseRuntime')
    const result = await imported(f), open = vi.fn(async () => '')
    expect((await verifyBatchEvidence(f.db, f.path, result.batchItemId)).status).toBe('available')
    await openKeywordHitEvidence(f.db, f.path, listRecentKeywordHits(f.db)[0].id, open)
    await openCommitmentCandidateEvidence(f.db, f.path, listCommitmentCandidates(f.db)[0].id, open)
    expect(open.mock.calls).toEqual([[filePaths(f, result.batchItemId).directory], [filePaths(f, result.batchItemId).directory]])
    expect(lock).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled()
  })
  it('ZIP 摘要不符不得打开', async () => {
    platform('darwin'); const f = fixture(), result = await imported(f)
    writeFileSync(filePaths(f, result.batchItemId).zip, '被修改')
    await refused(f, result.batchItemId)
  })
  it('即使容器摘要被同步登记，错误条目名也不得打开', async () => {
    platform('darwin'); const f = fixture(), result = await imported(f), p = filePaths(f, result.batchItemId)
    const zip = readFileSync(p.zip); zip.write('otherx.json', 30)
    writeFileSync(p.zip, zip); f.db.prepare('UPDATE batch_import_items SET attachment_identity=? WHERE id=?').run(hash(zip), result.batchItemId)
    await refused(f, result.batchItemId)
  })
  it('快照摘要被同步登记但 raw 身份或原文关系不一致时仍拒绝', async () => {
    platform('darwin'); const f = fixture(), result = await imported(f), p = filePaths(f, result.batchItemId)
    const payload = JSON.parse(readFileSync(p.snapshot, 'utf8'))
    payload.input.messages[0].value.content = '伪造另一原文'
    const snapshot = Buffer.from(JSON.stringify(payload))
    writeFileSync(p.snapshot, snapshot); f.db.prepare('UPDATE batch_import_items SET snapshot_sha256=? WHERE id=?').run(hash(snapshot), result.batchItemId)
    await refused(f, result.batchItemId)
  })
  it.each(['ZIP', '快照'])('拒绝最终 %s 文件符号链接', async target => {
    platform('darwin'); const f = fixture(), result = await imported(f), p = filePaths(f, result.batchItemId)
    const path = target === 'ZIP' ? p.zip : p.snapshot, replacement = join(f.directory, '外部副本')
    // Windows 无文件符号链接创建权限；模拟 Mac 的最终链接元数据，父目录链接另用真实 junction 覆盖。
    const original = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const info = await original(...args)
      if (args[0] === path) vi.spyOn(info, 'isSymbolicLink').mockReturnValue(true)
      return info
    })
    await refused(f, result.batchItemId)
  })
  it('拒绝受控根的父目录符号链接', async () => {
    platform('darwin'); const f = fixture(), result = await imported(f)
    const actualParent = join(f.directory, '实际父目录'), alias = join(f.directory, '别名父目录')
    mkdirSync(join(actualParent, '应用'), { recursive: true }); symlinkSync(actualParent, alias, 'junction')
    const path = join(alias, '应用', 'private-radar.db'), db = new DatabaseSync(path)
    try {
      initializeDatabase(db); configureMacEvidenceRoot(join(alias, '应用'))
      const id = manualItem({ ...f, db, path }), open = vi.fn(async () => '')
      await expect(saveCapturedJsonEvidence(db, path, id, bytes())).rejects.toThrow('父目录')
      await expect(openBatchItemEvidence(db, path, id, open)).rejects.toThrow()
      expect(open).not.toHaveBeenCalled()
    } finally { db.close(); unlinkSync(alias) }
  })
  it('拒绝 Item 目录符号链接和任意登记路径', async () => {
    platform('darwin'); const f = fixture(), result = await imported(f), p = filePaths(f, result.batchItemId)
    const backup = join(f.directory, '移出的证据目录'); renameSync(p.directory, backup); symlinkSync(backup, p.directory, 'junction')
    await refused(f, result.batchItemId); unlinkSync(p.directory); renameSync(backup, p.directory)
    f.db.prepare("UPDATE batch_import_items SET evidence_relative_path='../外部.zip' WHERE id=?").run(result.batchItemId)
    await refused(f, result.batchItemId)
  })
  it('数据库目录不在 Electron 用户数据根时拒绝', async () => {
    platform('darwin'); const f = fixture(), result = await imported(f)
    configureMacEvidenceRoot(join(f.directory, '另一个根'))
    await refused(f, result.batchItemId)
  })
  it('已有未登记文件不能作为证据打开', async () => {
    platform('darwin'); const f = fixture(), id = manualItem(f), p = filePaths(f, id)
    mkdirSync(p.directory, { recursive: true }); writeFileSync(p.zip, createManualJsonZip(bytes()))
    await refused(f, id)
  })
  it('目录证据在 Mac 只读返回不可用，不进入 Windows 租约或打开边界', async () => {
    platform('darwin'); const f = fixture(), session = createBatchImportSession(f.db, 'workbuddy'), id = createBatchImportItem(f.db, session.id, 0).id
    f.db.prepare("UPDATE batch_import_items SET evidence_source_kind='directory',evidence_status='available',evidence_relative_path='evidence/' || id WHERE id=?").run(id)
    const lock = vi.spyOn(lease.WindowsPathLease.prototype, 'lock'), runtime = vi.spyOn(lease, 'withRequestScopedWindowsPathLeaseRuntime')
    const before = stored(f, id)
    const constructor = vi.spyOn(lease, 'WindowsPathLease')
    expect(await verifyBatchEvidence(f.db, f.path, id)).toMatchObject({ status: 'error', sourceKind: 'directory' })
    expect(await verifyDirectoryEvidence(f.db, f.path, id)).toMatchObject({ status: 'error', error: expect.stringContaining('尚未支持') })
    await expect(saveDirectoryEvidence(f.db, f.path, id, join(f.directory, '不存在的源目录'))).rejects.toThrow('尚未支持')
    await refused(f, id)
    expect(stored(f, id)).toEqual(before); expect(lock).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled()
    expect(constructor).not.toHaveBeenCalled()
  })
  it('Windows 导航仍持有原 WindowsPathLease 打开目录', async () => {
    platform('win32'); const f = fixture(), result = await imported(f), lock = vi.spyOn(lease.WindowsPathLease.prototype, 'lock')
    await openBatchItemEvidence(f.db, f.path, result.batchItemId, async () => '')
    expect(lock).toHaveBeenCalledWith(filePaths(f, result.batchItemId).directory, true)
  }, 15000)
})

describe('Mac 非覆盖发布和捕获失败边界', () => {
  it('已有目标不会覆盖，也不会登记为本次可用证据', async () => {
    platform('darwin'); const f = fixture(), id = manualItem(f), p = filePaths(f, id)
    mkdirSync(p.directory, { recursive: true }); writeFileSync(p.zip, '已有内容')
    await expect(saveCapturedJsonEvidence(f.db, f.path, id, bytes())).rejects.toThrow()
    expect(readFileSync(p.zip, 'utf8')).toBe('已有内容'); expect(stored(f, id).evidence_relative_path).toBeNull()
  })
  it('两个并发发布最多一个成功，已发布内容和登记一致', async () => {
    platform('darwin'); const f = fixture(), id = manualItem(f)
    const result = await Promise.allSettled([saveCapturedJsonEvidence(f.db, f.path, id, bytes()), saveCapturedJsonEvidence(f.db, f.path, id, bytes(2))])
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(hash(readFileSync(filePaths(f, id).zip))).toBe(stored(f, id).attachment_identity)
    expect(stored(f, id).evidence_status).toBe('available')
  })
  it.each(['writeFile', 'sync'] as const)('%s 中断不登记 partial；随后可重新封存', async operation => {
    platform('darwin'); const f = fixture(), id = manualItem(f), original = fs.open
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      if (operation === 'writeFile') vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
        await handle.write(Buffer.from('partial')); throw new Error('隔离写入中断')
      })
      else vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('隔离写入中断'))
      return handle
    })
    await expect(saveCapturedJsonEvidence(f.db, f.path, id, bytes())).rejects.toThrow('隔离写入中断')
    expect(stored(f, id).evidence_relative_path).toBeNull()
    expect(await fs.readdir(filePaths(f, id).directory)).toEqual([])
    vi.restoreAllMocks(); await saveCapturedJsonEvidence(f.db, f.path, id, bytes())
    await saveStructuredSnapshot(f.db, f.path, id, createManualJsonSnapshot(bytes()))
    expect((await verifyBatchEvidence(f.db, f.path, id)).status).toBe('available')
  })
  it('硬链接失败不降级到覆盖重命名', async () => {
    platform('darwin'); const f = fixture(), id = manualItem(f), rename = vi.spyOn(fs, 'rename')
    vi.spyOn(fs, 'link').mockRejectedValueOnce(new Error('此文件系统不支持硬链接'))
    await expect(saveCapturedJsonEvidence(f.db, f.path, id, bytes())).rejects.toThrow()
    expect(rename).not.toHaveBeenCalled(); expect(stored(f, id).evidence_relative_path).toBeNull()
  })
  it('捕获后源路径替换检查失败时，不创建 Item 或 Evidence', async () => {
    platform('darwin'); const f = fixture(), source = join(f.directory, '原文.json'); writeFileSync(source, bytes())
    const original = fs.lstat; let seen = 0
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const info = await original(...args)
      if (args[0] === source && ++seen === 3) Object.defineProperty(info, 'ino', {
        value: typeof info.ino === 'bigint' ? info.ino + 1n : Number(info.ino) + 1024
      })
      return info
    })
    await expect(importChatFile(f.db, source, f.path)).rejects.toThrow('源路径')
    expect(f.db.prepare('SELECT count(*) AS n FROM batch_import_items').get()!.n).toBe(0)
  })
  it('Mac 的 501 条来源保留原始位置与两个派生处理', async () => {
    platform('darwin'); const f = fixture()
    addKeywordTerm(f.db, createKeywordGroup(f.db, '文件').id, '文件')
    const result = await imported(f, 501), snapshot = await loadManualJsonSnapshot(f.db, f.path, result.batchItemId)
    expect(snapshot.messages).toHaveLength(501)
    expect(snapshot.messages[500].source_position).toBe(500)
    expect(f.db.prepare('SELECT count(*) AS n FROM keyword_hits').get()!.n).toBe(501)
    expect(f.db.prepare('SELECT count(*) AS n FROM commitment_candidates').get()!.n).toBe(501)
  })
})

describe('Mac 未支持集成状态', () => {
  it('旧连接心跳不能显示为已连接；不探测配置或回写信任状态，核心数据库健康', () => {
    platform('darwin'); const f = fixture(); markConnectorHeartbeat(f.db, 'connected')
    const inspect = vi.spyOn(deployment, 'inspectWorkBuddyConnection'), trust = vi.spyOn(deployment, 'acknowledgeConnectorTrust')
    const before = f.db.prepare('SELECT * FROM app_settings').all()
    expect(getFirstUseStatus(f.db, f.path)).toMatchObject({ manualJsonOnly: true, workBuddyConnected: false,
      workBuddyInstalled: false, connectorPrepared: false, connectorRequiresRetrust: false, databaseHealthy: true })
    expect(inspect).not.toHaveBeenCalled(); expect(trust).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT * FROM app_settings').all()).toEqual(before)
  })
  it('主动配置也先拒绝，不创建集成目录或用户配置', async () => {
    platform('darwin'); const f = fixture()
    const before = await fs.readdir(f.directory)
    expect(() => deployment.prepareWorkBuddyConnector('不存在的载荷', f.directory, '0.2.0-alpha.20')).toThrow('尚未支持')
    expect(await fs.readdir(f.directory)).toEqual(before)
  })
})
