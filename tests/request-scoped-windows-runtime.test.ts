import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsPathLease, RequestScopedWindowsPathLeaseRuntime, withRequestScopedWindowsPathLeaseRuntime } from '../src/main/batch-import/windows-path-lease'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'
import type { WorkBuddyBatchResult } from '../src/main/integrations/workbuddy/validation'
import { createCollection } from '../src/main/collections/service'
import { ingestWorkBuddyCurrentContextBatch } from '../src/main/integrations/workbuddy/batch-tool'
import { initializeDatabase } from '../src/main/schema'
import { verifyBatchEvidence } from '../src/main/batch-import/evidence'

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof fs>() }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args) as ChildProcessWithoutNullStreams
    observeHelper(child)
    return child
  } }
})

// 只在测试模块观测真实子进程和原有私有协议，不给正式产品增加计时或观测接口。
interface HelperObservation {
  process: ChildProcessWithoutNullStreams
  spawned: boolean
  ready: boolean
  exited: boolean
  acquired: number
  closed: number
}
interface RuntimeCapture { helpers: HelperObservation[] }
const captureStorage = new AsyncLocalStorage<RuntimeCapture>()
function createRuntimeCapture(): RuntimeCapture { return { helpers: [] } }
function withRuntimeCapture<T>(capture: RuntimeCapture, action: () => T): T {
  return captureStorage.run(capture, action)
}
function observeHelper(child: ChildProcessWithoutNullStreams): void {
  const capture = captureStorage.getStore()
  if (!capture) return
  const observed: HelperObservation = { process: child, spawned: false, ready: false, exited: false, acquired: 0, closed: 0 }
  capture.helpers.push(observed)
  child.once('spawn', () => { observed.spawned = true })
  child.once('close', () => { observed.exited = true })
  // 首行是原有 ready 握手；读完即停止监听，不收集后续文件读取响应。
  let firstLine = ''
  const ready = (chunk: Buffer) => {
    firstLine += chunk.toString('utf8')
    const newline = firstLine.indexOf('\n')
    if (newline < 0) return
    try { observed.ready = (JSON.parse(firstLine.slice(0, newline)) as { ready?: boolean }).ready === true }
    catch { observed.ready = false }
    firstLine = ''
    child.stdout.off('data', ready)
  }
  child.stdout.on('data', ready)
  const write = child.stdin.write.bind(child.stdin)
  vi.spyOn(child.stdin, 'write').mockImplementation(((chunk: string | Buffer, ...args: unknown[]) => {
    try {
      const command = JSON.parse(chunk.toString()) as { op?: string }
      if (command.op === 'acquire') observed.acquired++
      if (command.op === 'close_lease') observed.closed++
    } catch { /* 观测失败不改变真实协议行为，计数断言会检出异常。 */ }
    return Reflect.apply(write, child.stdin, [chunk, ...args]) as boolean
  }) as typeof child.stdin.write)
}
function acquiredLeases(capture: RuntimeCapture): number {
  return capture.helpers.reduce((total, helper) => total + helper.acquired, 0)
}
function closedLeases(capture: RuntimeCapture): number {
  return capture.helpers.reduce((total, helper) => total + helper.closed, 0)
}
const roots: string[] = [], databases: DatabaseSync[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'privateradar-request-runtime-'))
  roots.push(root)
  const file = join(root, '合成证据.txt')
  writeFileSync(file, '只用于隔离测试')
  return { root, file }
}

function batchFixture() {
  const f = fixture()
  const chatHistoryRoot = join(f.root, 'user', '.workbuddy', 'app', 'tmp', 'chat-history')
  const data = join(f.root, 'data')
  mkdirSync(data)
  const databasePath = join(data, 'private-radar.db')
  const db = new DatabaseSync(databasePath)
  databases.push(db)
  initializeDatabase(db)
  const sources = [join(chatHistoryRoot, '源甲'), join(chatHistoryRoot, '源乙')]
  const contexts = sources.map((source, attachment) => {
    mkdirSync(source, { recursive: true })
    const transcript = Array.from({ length: 6 }, (_, index) =>
      `·测试发送者${attachment}\n2026年10月3日 20:0${index}\n合成正文 ${attachment}-${index}`).join('\n\n') + '\n'
    writeFileSync(join(source, '聊天记录.txt'), transcript)
    return { file: `合成${attachment}.zip`, extracted_dir_path: source, message_count: 6, transcript }
  })
  return { ...f, db, data, sources, options: { databasePath, chatHistoryRoot },
    input: { mode: 'current_context' as const, contexts: [contexts[0], contexts[1], { ...contexts[0] }] } }
}

function runtimeProcess(lease: WindowsPathLease): ChildProcessWithoutNullStreams {
  return (lease as unknown as { runtime: { process: ChildProcessWithoutNullStreams } }).runtime.process
}
function noHelpers(capture: RuntimeCapture) {
  for (const helper of capture.helpers) {
    expect(helper.exited).toBe(true)
    if (helper.process.pid !== undefined) expect(() => process.kill(helper.process.pid!, 0)).toThrow()
  }
}
function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

describe('单请求共享执行载体，租约和原生句柄仍独立', () => {
  it.each([false, true])('最小隔离双卡完整 MCP 链路仅启动一个 helper，三块上下文导入十二条消息，显式归集=%s', async (withCollection) => {
    const f = batchFixture(), capture = createRuntimeCapture()
    const collection = withCollection ? createCollection(f.db, '隔离性能契约') : null
    const server = createWorkBuddyMcpServer(f.db, undefined, f.options)
    const client = new Client({ name: '隔离双卡回归', version: '0.1.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    try {
      const started = performance.now()
      const response = await withRuntimeCapture(capture, () => client.callTool({
        name: 'privateradar_ingest_current_context_batch',
        arguments: { ...f.input, ...(collection ? { collection_id: collection.id } : {}) }
      }))
      const elapsedMs = performance.now() - started
      expect(response.isError).not.toBe(true)
      const result = response.structuredContent as WorkBuddyBatchResult
      expect(result.collection_id).toBe(collection?.id ?? null)
      expect(result.session_id).toBe(result.batch_session_id)
      expect(f.db.prepare('SELECT collection_id FROM batch_import_sessions WHERE id = ?').get(result.session_id))
        .toEqual({ collection_id: result.collection_id })
      expect(result.status).toBe('success')
      expect(result.items.map((item) => item.imported)).toEqual([6, 6])
      expect(capture.helpers).toHaveLength(1)
      expect(capture.helpers[0]).toMatchObject({ spawned: true, ready: true, exited: true })
      expect(acquiredLeases(capture)).toBe(30)
      expect(closedLeases(capture)).toBe(30)
      noHelpers(capture)
      expect(['messages', 'messages_fts', 'messages_fts_docsize', 'import_jobs',
        'message_import_batches', 'batch_import_sessions', 'batch_import_items'].map((table) => count(f.db, table)))
        .toEqual([12, 12, 12, 2, 2, 1, 2])
      expect(f.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
      expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      // 只删除本测试创建且已确认位于隔离根目录下的源，验证持久证据可独立恢复。
      for (const source of f.sources) {
        const target = relative(f.root, source)
        expect(isAbsolute(source) && target !== '' && !target.startsWith('..') && !isAbsolute(target)).toBe(true)
        rmSync(source, { recursive: true })
      }
      await withRequestScopedWindowsPathLeaseRuntime(async () => {
        for (const item of result.items) {
          expect((await verifyBatchEvidence(f.db, f.options.databasePath, item.item_id)).status).toBe('available')
        }
      })
      // 仅测试输出耗时和数量；不设依赖机器性能的脆弱断言，不输出路径或正文。
      console.info('隔离双卡运行统计', { elapsedMs: Math.round(elapsedMs), helper: capture.helpers.length,
        powershell: capture.helpers.filter((helper) => helper.spawned).length, lease: acquiredLeases(capture), messages: 12 })
    } finally { await client.close(); await server.close() }
  }, 60000)

  it('独立租约原生哈希和读取结果不变，关闭后无 helper 残留', async () => {
    const f = fixture(), capture = createRuntimeCapture()
    const bytes = Buffer.from('只用于隔离测试')
    await withRuntimeCapture(capture, async () => {
      const lease = new WindowsPathLease()
      try {
        await lease.lock(f.file, false)
        expect(await lease.hashFile(f.file)).toBe(createHash('sha256').update(bytes).digest('hex'))
        expect(await lease.readFile(f.file, 1024)).toEqual(bytes)
      } finally { await lease.close() }
    })
    expect(capture.helpers).toHaveLength(1)
    noHelpers(capture)
  }, 30000)

  it('runtime 关闭超时在两秒触发 kill，确认退出后仍拒绝成功返回', async () => {
    vi.useFakeTimers()
    const runtime = Object.create(RequestScopedWindowsPathLeaseRuntime.prototype) as RequestScopedWindowsPathLeaseRuntime
    const end = vi.fn()
    let resolveExit!: () => void
    const exit = new Promise<void>((done) => { resolveExit = done })
    const kill = vi.fn(() => { Object.assign(runtime, { exited: true }); resolveExit(); return true })
    try {
      // 仅模拟本测试的无法退出子进程，不启动或终止任何真实用户进程。
      Object.assign(runtime, { process: { stdin: { end }, exitCode: null, killed: false, kill },
        leases: new Map(), pending: [], ready: Promise.resolve(), queue: Promise.resolve(), exit, exited: false,
        failure: null, closePromise: null })
      const closing = runtime.close()
      const rejected = expect(closing).rejects.toThrow('关闭超时')
      await vi.advanceTimersByTimeAsync(1999)
      expect(kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      expect(end).toHaveBeenCalledTimes(1)
      expect(kill).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('Gate 拒绝非法输入不初始化 helper，不改变原有零副作用行为', async () => {
    const f = batchFixture(), capture = createRuntimeCapture()
    await expect(withRuntimeCapture(capture, () => ingestWorkBuddyCurrentContextBatch(f.db, f.options,
      { ...f.input, messages: [] }))).rejects.toThrow()
    expect(capture.helpers).toHaveLength(0)
    expect(count(f.db, 'messages')).toBe(0)
    expect(count(f.db, 'batch_import_sessions')).toBe(0)
  })

  it('无租约提前返回后，遗留异步上下文也不能再创建 helper', async () => {
    const capture = createRuntimeCapture()
    let continueLater!: () => void
    const continuation = new Promise<void>((done) => { continueLater = done })
    let leftover!: Promise<void>
    await withRuntimeCapture(capture, () => withRequestScopedWindowsPathLeaseRuntime(async () => {
      leftover = continuation.then(() => { expect(() => new WindowsPathLease()).toThrow('作用域已关闭') })
    }))
    continueLater()
    await leftover
    expect(capture.helpers.filter((helper) => helper.spawned)).toHaveLength(0)
  })

  it('同路径两个租约有独立句柄，关闭/释放其中一个不影响另一个，也不能借用其他租约的句柄', async () => {
    const f = fixture(), capture = createRuntimeCapture()
    const expected = createHash('sha256').update('只用于隔离测试').digest('hex')
    await withRuntimeCapture(capture, () => withRequestScopedWindowsPathLeaseRuntime(async () => {
      const a = new WindowsPathLease(), b = new WindowsPathLease(), unowned = new WindowsPathLease()
      await Promise.all([a.lock(f.file, false), b.lock(f.file, false)])
      expect(runtimeProcess(a)).toBe(runtimeProcess(b))
      await expect(unowned.hashFile(f.file)).rejects.toThrow('没有安全句柄')
      await a.releaseTree(f.root)
      expect(await b.hashFile(f.file)).toBe(expected)
      await a.close()
      await expect(a.hashFile(f.file)).rejects.toThrow('已关闭')
      expect(() => writeFileSync(f.file, '不允许改写')).toThrow()
      expect(await b.hashFile(f.file)).toBe(expected)
      await b.close()
      await unowned.close()
      writeFileSync(f.file, '全部释放后可写')
    }))
    expect(acquiredLeases(capture)).toBe(3)
    expect(capture.helpers.filter((helper) => helper.ready)).toHaveLength(1)
    expect(capture.helpers.filter((helper) => helper.spawned)).toHaveLength(1)
    expect(closedLeases(capture)).toBe(3)
    noHelpers(capture)
  }, 30000)

  it('不同并发 Tool 请求各自创建 runtime，不共用进程，均完成十二条导入', async () => {
    const a = batchFixture(), b = batchFixture()
    const captures = [createRuntimeCapture(), createRuntimeCapture()]
    await Promise.all([a, b].map((f, index) => withRuntimeCapture(captures[index], async () => {
      const result = await ingestWorkBuddyCurrentContextBatch(f.db, f.options, f.input)
      expect(result.status).toBe('success')
      expect(result.items.map((item) => item.imported)).toEqual([6, 6])
      expect(count(f.db, 'messages')).toBe(12)
      expect(count(f.db, 'messages_fts_docsize')).toBe(12)
    })))
    const pids = captures.map((capture) => {
      expect(capture.helpers.filter((helper) => helper.spawned)).toHaveLength(1)
      expect(capture.helpers.filter((helper) => helper.ready)).toHaveLength(1)
      expect(acquiredLeases(capture)).toBe(30)
      noHelpers(capture)
      return capture.helpers[0].process.pid
    })
    expect(pids[0]).not.toBe(pids[1])
  }, 60000)

  it.each(['提前返回', '异常'])('请求%s时清理未显式 close 的全部租约，并拒绝请求后继续使用', async (mode) => {
    const f = fixture(), capture = createRuntimeCapture()
    let leftover!: WindowsPathLease
    const result = withRuntimeCapture(capture, () => withRequestScopedWindowsPathLeaseRuntime(async () => {
      leftover = new WindowsPathLease()
      const b = new WindowsPathLease()
      await Promise.all([leftover.lock(f.file, false), b.lock(f.file, false)])
      if (mode === '异常') throw new Error('隔离测试中止')
      return 42
    }))
    if (mode === '异常') await expect(result).rejects.toThrow('隔离测试中止')
    else expect(await result).toBe(42)
    expect(closedLeases(capture)).toBe(2)
    await expect(leftover.hashFile(f.file)).rejects.toThrow('已关闭')
    writeFileSync(f.file, '资源已释放')
    noHelpers(capture)
  }, 30000)

  it('Helper 崩溃即使被调用方捕获也不能成功返回，且不污染另一并发请求', async () => {
    const a = fixture(), b = fixture(), failed = createRuntimeCapture(), healthy = createRuntimeCapture()
    await Promise.all([
      expect(withRuntimeCapture(failed, () => withRequestScopedWindowsPathLeaseRuntime(async () => {
        const lease = new WindowsPathLease()
        await lease.lock(a.file, false)
        runtimeProcess(lease).kill()
        await lease.hashFile(a.file).catch(() => undefined)
        return '不能返回成功'
      }))).rejects.toThrow(),
      withRuntimeCapture(healthy, () => withRequestScopedWindowsPathLeaseRuntime(async () => {
        const lease = new WindowsPathLease()
        await lease.lock(b.file, false)
        expect((await lease.readFile(b.file, 1024)).toString()).toBe('只用于隔离测试')
        await lease.close()
      }))
    ])
    noHelpers(failed)
    noHelpers(healthy)
  }, 30000)

  it.each(['acquire', 'close_lease'])('租约 %s 失败时拒绝 Tool、无业务写入且销毁 helper', async (op) => {
    const f = batchFixture(), capture = createRuntimeCapture()
    const original = RequestScopedWindowsPathLeaseRuntime.prototype.request
    let fault = false
    vi.spyOn(RequestScopedWindowsPathLeaseRuntime.prototype, 'request').mockImplementation(function (this: RequestScopedWindowsPathLeaseRuntime, lease, value) {
      if (!fault && (value as { op: string }).op === op) { fault = true; return Promise.reject(new Error('隔离租约故障')) }
      return original.call(this, lease, value)
    })
    await expect(withRuntimeCapture(capture, () => ingestWorkBuddyCurrentContextBatch(f.db, f.options, f.input))).rejects.toThrow()
    expect(fault).toBe(true)
    expect(count(f.db, 'messages')).toBe(0)
    expect(count(f.db, 'batch_import_sessions')).toBe(0)
    noHelpers(capture)
  }, 30000)

  it('runtime stdin 关闭同步失败也 kill 自有进程，并拒绝成功返回', async () => {
    const f = fixture(), capture = createRuntimeCapture()
    await expect(withRuntimeCapture(capture, () => withRequestScopedWindowsPathLeaseRuntime(async () => {
      const lease = new WindowsPathLease()
      await lease.lock(f.file, false)
      await lease.close()
      vi.spyOn(runtimeProcess(lease).stdin, 'end').mockImplementation(() => { throw new Error('隔离关闭故障') })
    }))).rejects.toThrow('隔离关闭故障')
    noHelpers(capture)
    writeFileSync(f.file, '原生句柄已随进程销毁')
  }, 30000)

  it.each(['复制前', '复制后'])('保存 Evidence %s helper 崩溃不登记可用证据、不导入消息、不留下暂存目标', async (moment) => {
    const f = batchFixture(), capture = createRuntimeCapture()
    const original = WindowsPathLease.prototype.copyFile
    let crashed = false
    vi.spyOn(WindowsPathLease.prototype, 'copyFile').mockImplementation(async function (this: WindowsPathLease, ...args) {
      if (!crashed && moment === '复制前') { crashed = true; runtimeProcess(this).kill() }
      await original.apply(this, args)
      if (!crashed && moment === '复制后') { crashed = true; runtimeProcess(this).kill() }
    })
    await expect(withRuntimeCapture(capture, () => ingestWorkBuddyCurrentContextBatch(f.db, f.options, f.input))).rejects.toThrow()
    expect(crashed).toBe(true)
    expect(count(f.db, 'messages')).toBe(0)
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM batch_import_items WHERE evidence_status = 'available'").get()).toEqual({ count: 0 })
    if (existsSync(join(f.data, 'evidence'))) expect(readdirSync(join(f.data, 'evidence'))).toEqual([])
    noHelpers(capture)
  }, 30000)

  it.each(['junction', 'symlink', 'reparse', 'hardlink', 'special', 'escape', 'mutation'])('共享 runtime 下 %s 仍拒绝不可信附件，保留另一附件的独立有效结果', async (kind) => {
    const f = batchFixture(), capture = createRuntimeCapture()
    if (kind === 'junction') {
      symlinkSync(f.sources[1], join(f.sources[0], '目录链接'), 'junction')
    } else if (kind === 'symlink') {
      // 有权限时创建真实符号链接；否则明确验证同一拒绝分支，不跳过用例。
      try { symlinkSync(join(f.sources[1], '聊天记录.txt'), join(f.sources[0], '文件链接'), 'file') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        const original = fs.lstat
        vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
          const stat = await original(...args)
          if (String(args[0]) === join(f.sources[0], '聊天记录.txt')) return new Proxy(stat, { get(target, key) {
            if (key === 'isSymbolicLink') return () => true
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          } })
          return stat
        }) as typeof fs.lstat)
      }
    } else if (kind === 'reparse') {
      // 模拟 lstat 未报告链接，仍由原生句柄属性检查拒绝真实重解析点。
      const link = join(f.sources[0], '目录链接')
      symlinkSync(f.sources[1], link, 'junction')
      const original = fs.lstat
      vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await original(...args)
        if (String(args[0]) === link) return new Proxy(stat, { get(target, key) {
          if (key === 'isSymbolicLink') return () => false
          if (key === 'isDirectory') return () => true
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        } })
        return stat
      }) as typeof fs.lstat)
    } else if (kind === 'hardlink') {
      linkSync(join(f.sources[0], '聊天记录.txt'), join(f.root, '源硬链接.txt'))
    } else if (kind === 'special') {
      const original = fs.lstat
      vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await original(...args)
        if (String(args[0]) === join(f.sources[0], '聊天记录.txt')) return new Proxy(stat, { get(target, key) {
          if (key === 'isFile' || key === 'isDirectory') return () => false
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        } })
        return stat
      }) as typeof fs.lstat)
    } else if (kind === 'escape') {
      f.input.contexts[0].extracted_dir_path = join(f.root, '不存在的越界路径')
      f.input.contexts[2].extracted_dir_path = f.input.contexts[0].extracted_dir_path
    } else {
      const original = WindowsPathLease.prototype.copyFile
      let changed = false
      vi.spyOn(WindowsPathLease.prototype, 'copyFile').mockImplementation(async function (this: WindowsPathLease, ...args) {
        await original.apply(this, args)
        if (!changed) { changed = true; writeFileSync(join(f.sources[0], '新增.txt'), '隔离源变化') }
      })
    }
    if (kind === 'escape') {
      await expect(withRuntimeCapture(capture, () => ingestWorkBuddyCurrentContextBatch(f.db, f.options, f.input))).rejects.toThrow()
      expect(count(f.db, 'messages')).toBe(0)
    } else {
      const result = await withRuntimeCapture(capture, () => ingestWorkBuddyCurrentContextBatch(f.db, f.options, f.input))
      expect(result.status).toBe('partial_success')
      expect(result.items[0].imported).toBe(0)
      expect(result.items[1].imported).toBe(6)
      expect(result.items[0].status).toBe('failed')
      expect(count(f.db, 'messages')).toBe(6)
      expect(count(f.db, 'messages_fts_docsize')).toBe(6)
      await withRequestScopedWindowsPathLeaseRuntime(async () => {
        expect((await verifyBatchEvidence(f.db, f.options.databasePath, result.items[1].item_id)).status).toBe('available')
      })
    }
    expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    noHelpers(capture)
  }, 60000)
})
