import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportSession } from '../src/main/batch-import/repository'
import { bindSession, completeCollection, createCollection, getCollection, listCollectionSessions } from '../src/main/collections/service'

const databases: DatabaseSync[] = []
const directories: string[] = []
const workers: Worker[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) {
    expect(resolve(directory)).toBe(directory)
    expect(resolve(directory, '..')).toBe(resolve(tmpdir()))
    expect(basename(directory).startsWith('privateradar-collection-race-')).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-collection-race-'))
  directories.push(directory)
  const path = join(directory, '并发.db')
  const db = new DatabaseSync(path)
  databases.push(db)
  initializeDatabase(db)
  return { path, db }
}

// 在线程内执行当前真实服务实现；只做内存转译，不复制绑定/完成逻辑或生成构建文件。
const modules = Object.fromEntries([
  ['repository', '../src/main/collections/repository.ts'],
  ['service', '../src/main/collections/service.ts'],
  ['batch', '../src/main/batch-import/repository.ts']
].map(([name, path]) => [name,
  transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText
]))

interface Operation { method: 'bindSession' | 'completeCollection' | 'createBatchImportSession'; args: string[] }
interface Result { success: boolean; error?: string; sessionId?: string }

async function race(path: string, operations: Operation[]): Promise<Result[]> {
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const attempts = operations.map((operation) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const loaded = {};
      function load(name) {
        if (loaded[name]) return loaded[name].exports;
        const module = loaded[name] = { exports: {} };
        new Function('require', 'module', 'exports', workerData.modules[name])(
          key => key === './repository' || key === '../collections/repository' ? load('repository') : require(key), module, module.exports);
        return module.exports;
      }
      const service = load('service');
      const db = new DatabaseSync(workerData.path);
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
      parentPort.postMessage({ ready: true });
      const gate = new Int32Array(workerData.gate);
      Atomics.wait(gate, 0, 0);
      let result;
      try {
        const target = workerData.operation.method === 'createBatchImportSession' ? load('batch') : service;
        const value = target[workerData.operation.method](db, ...workerData.operation.args);
        result = { success: true, sessionId: value.id };
      } catch (error) { result = { success: false, error: error.message }; }
      finally { db.close(); }
      parentPort.postMessage(result);
    `, { eval: true, workerData: { path, operation, modules, gate: gate.buffer } })
    workers.push(worker)
    let ready!: () => void
    const started = new Promise<void>((done) => { ready = done })
    const result = new Promise<Result>((done, reject) => {
      let received = false
      worker.on('message', (message: Result & { ready?: boolean }) => {
        if (message.ready) ready()
        else { received = true; done(message) }
      })
      worker.on('error', (error) => { ready(); reject(error) })
      worker.on('exit', (code) => {
        if (!received) { ready(); reject(new Error(`并发测试线程未返回结果，退出码 ${code}`)) }
      })
    })
    return { started, result }
  })
  const results = Promise.all(attempts.map((attempt) => attempt.result))
  await Promise.all(attempts.map((attempt) => attempt.started))
  Atomics.store(gate, 0, 1)
  Atomics.notify(gate, 0, operations.length)
  return results
}

describe('归集绑定与完成的真实多连接并发边界', () => {
  it('新会话原子创建归属与完成竞争，完成先赢时不能留下孤儿会话', async () => {
    const { db, path } = fixture()
    for (let index = 0; index < 8; index++) {
      const collection = createCollection(db, `新导入归集${index}`)
      const before = db.prepare('SELECT COUNT(*) AS count FROM batch_import_sessions').get() as { count: number }
      const results = await race(path, [
        { method: 'createBatchImportSession', args: ['workbuddy', collection.id] },
        { method: 'completeCollection', args: [collection.id] }
      ])
      expect(results.filter((result) => result.success)).toHaveLength(1)
      const after = db.prepare('SELECT COUNT(*) AS count FROM batch_import_sessions').get() as { count: number }
      if (results[0].success) {
        expect(results[1].error).toContain('未终结')
        expect(getCollection(db, collection.id)?.status).toBe('collecting')
        expect(after.count).toBe(before.count + 1)
        expect(listCollectionSessions(db, collection.id)).toEqual([
          expect.objectContaining({ id: results[0].sessionId, collection_id: collection.id, status: 'pending' })
        ])
      } else {
        expect(results[0].error).toContain('COLLECTION_COMPLETED')
        expect(getCollection(db, collection.id)?.status).toBe('completed')
        expect(after).toEqual(before)
        expect(listCollectionSessions(db, collection.id)).toEqual([])
      }
    }
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }, 30000)

  it('显式外层短事务创建归属与两个先后顺序均安全，失败回滚不遗留会话', () => {
    const { db, path } = fixture()
    const other = new DatabaseSync(path)
    databases.push(other)
    initializeDatabase(other)
    const completedFirst = createCollection(db, '先完成后导入')
    completeCollection(other, completedFirst.id)
    db.exec('BEGIN IMMEDIATE')
    try {
      expect(() => createBatchImportSession(db, 'workbuddy', completedFirst.id)).toThrow('COLLECTION_COMPLETED')
    } finally { db.exec('ROLLBACK') }
    expect(db.prepare('SELECT COUNT(*) AS count FROM batch_import_sessions').get()).toEqual({ count: 0 })
    const importedFirst = createCollection(db, '先导入后完成')
    db.exec('BEGIN IMMEDIATE')
    const session = createBatchImportSession(db, 'workbuddy', importedFirst.id)
    db.exec('COMMIT')
    expect(() => completeCollection(other, importedFirst.id)).toThrow('未终结')
    expect(listCollectionSessions(other, importedFirst.id)).toEqual([session])
  })

  it('绑定待处理会话与完成同时竞争时，只能一个成功，不产生已完成后新增成员', async () => {
    const { db, path } = fixture()
    // 多轮竞争不依赖某一个线程必定先取得写锁。
    for (let index = 0; index < 8; index++) {
      const collection = createCollection(db, `并发归集${index}`)
      const session = createBatchImportSession(db, 'workbuddy')
      const results = await race(path, [
        { method: 'bindSession', args: [collection.id, session.id] },
        { method: 'completeCollection', args: [collection.id] }
      ])
      expect(results.filter((result) => result.success)).toHaveLength(1)
      if (results[0].success) {
        expect(results[1].error).toContain('未终结')
        expect(getCollection(db, collection.id)?.status).toBe('collecting')
        expect(listCollectionSessions(db, collection.id).map((member) => member.id)).toEqual([session.id])
      } else {
        expect(results[0].error).toContain('已完成的归集')
        expect(getCollection(db, collection.id)?.status).toBe('completed')
        expect(listCollectionSessions(db, collection.id)).toEqual([])
      }
    }
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }, 30000)

  it('同一会话并发绑定两个同名归集，只有一个成功，另一方明确拒绝而非覆盖', async () => {
    const { db, path } = fixture()
    const first = createCollection(db, '同名')
    const second = createCollection(db, '同名')
    const session = createBatchImportSession(db, 'workbuddy')
    const results = await race(path, [
      { method: 'bindSession', args: [first.id, session.id] },
      { method: 'bindSession', args: [second.id, session.id] }
    ])
    expect(results.filter((result) => result.success)).toHaveLength(1)
    expect(results.find((result) => !result.success)?.error).toContain('已绑定其他归集')
    const winner = results[0].success ? first : second
    const loser = results[0].success ? second : first
    expect(listCollectionSessions(db, winner.id).map((member) => member.id)).toEqual([session.id])
    expect(listCollectionSessions(db, loser.id)).toEqual([])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }, 30000)

  it('确定性验证两个事务取得锁的先后顺序，均不允许越过完成边界', () => {
    const { db, path } = fixture()
    const other = new DatabaseSync(path)
    databases.push(other)
    initializeDatabase(other)
    const completedFirst = createCollection(db, '先完成')
    completeCollection(db, completedFirst.id)
    const fresh = createBatchImportSession(other, 'workbuddy')
    expect(() => bindSession(other, completedFirst.id, fresh.id)).toThrow('已完成的归集')
    const boundFirst = createCollection(db, '先绑定')
    bindSession(other, boundFirst.id, fresh.id)
    expect(() => completeCollection(db, boundFirst.id)).toThrow('未终结')
    expect(listCollectionSessions(db, completedFirst.id)).toEqual([])
    expect(listCollectionSessions(db, boundFirst.id)).toHaveLength(1)
  })
})
