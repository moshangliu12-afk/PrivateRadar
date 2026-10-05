import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { attachImportJobToBatchItem, createBatchImportItem, createBatchImportSession, listBatchImportItems } from '../src/main/batch-import/repository'
import { importChatContent } from '../src/main/import/importer'
import {
  bindSession, completeCollection, createCollection, getCollection, listCollections, listCollectionSessions
} from '../src/main/collections/service'

const databases: DatabaseSync[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const db of databases.splice(0)) db.close()
})

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  initializeDatabase(db)
  return db
}

describe('归集持久层内部契约', () => {
  it('创建时服务端生成随机 UUID，初态正在归集，完成时间为空', () => {
    const db = database()
    const collection = createCollection(db, '长期聊天')
    expect(collection).toEqual({
      id: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/),
      display_name: '长期聊天', status: 'collecting', created_at: expect.any(String), completed_at: null
    })
    expect(Number.isNaN(Date.parse(collection.created_at))).toBe(false)
    expect(getCollection(db, collection.id)).toEqual(collection)
  })

  it('名称只裁剪首尾空白，保留名称内部内容', () => {
    expect(createCollection(database(), ' \n 甲  乙\t ').display_name).toBe('甲  乙')
  })

  it.each(['', ' ', '\n\t'])('拒绝空白名称 %j，且不创建记录', (name) => {
    const db = database()
    expect(() => createCollection(db, name)).toThrow('名称不能为空')
    expect(listCollections(db)).toEqual([])
  })

  it('拒绝运行时非字符串名称', () => {
    expect(() => createCollection(database(), null as unknown as string)).toThrow('名称不能为空')
  })

  it('同名归集身份不同，只按 ID 查找，不按名称或最近记录猜测', () => {
    const db = database()
    const first = createCollection(db, '同名')
    const second = createCollection(db, '同名')
    expect(first.id).not.toBe(second.id)
    expect(getCollection(db, first.id)).toEqual(first)
    expect(getCollection(db, second.id)).toEqual(second)
    expect(getCollection(db, '同名')).toBeNull()
    expect(getCollection(db, '不存在')).toBeNull()
  })

  it('列表来自持久数据，按创建时间倒序、ID 稳定排序', () => {
    const db = database()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T00:00:00Z'))
    const first = createCollection(db, '甲')
    vi.setSystemTime(new Date('2026-10-05T00:00:01Z'))
    const second = createCollection(db, '乙')
    expect(listCollections(db)).toEqual([second, first])
  })

  it('绑定只改变会话归属，单个归集可以查询多个会话', () => {
    const db = database()
    const collection = createCollection(db, '甲')
    const other = createCollection(db, '乙')
    const first = createBatchImportSession(db, 'workbuddy')
    const second = createBatchImportSession(db, 'workbuddy')
    const unbound = createBatchImportSession(db, 'workbuddy')
    expect(bindSession(db, collection.id, first.id)).toEqual({ ...first, collection_id: collection.id })
    expect(bindSession(db, collection.id, second.id)).toEqual({ ...second, collection_id: collection.id })
    expect(listCollectionSessions(db, collection.id).map((session) => session.id).sort()).toEqual([first.id, second.id].sort())
    expect(listCollectionSessions(db, other.id)).toEqual([])
    expect(db.prepare('SELECT * FROM batch_import_sessions WHERE id = ?').get(unbound.id)).toEqual(unbound)
  })

  it('同一归集重复绑定幂等，不更新会话时间或其他字段', () => {
    const db = database()
    const collection = createCollection(db, '甲')
    const session = createBatchImportSession(db, 'workbuddy')
    const first = bindSession(db, collection.id, session.id)
    expect(bindSession(db, collection.id, session.id)).toEqual(first)
    expect(listCollectionSessions(db, collection.id)).toEqual([first])
  })

  it('已绑定会话不能移动到另一个同名归集', () => {
    const db = database()
    const first = createCollection(db, '同名')
    const second = createCollection(db, '同名')
    const session = createBatchImportSession(db, 'workbuddy')
    const bound = bindSession(db, first.id, session.id)
    expect(() => bindSession(db, second.id, session.id)).toThrow('已绑定其他归集')
    expect(listCollectionSessions(db, first.id)).toEqual([bound])
    expect(listCollectionSessions(db, second.id)).toEqual([])
  })

  it('不存在的归集拒绝绑定和完成，不能将名称当作 ID', () => {
    const db = database()
    createCollection(db, '名称不是身份')
    const session = createBatchImportSession(db, 'workbuddy')
    expect(() => bindSession(db, '名称不是身份', session.id)).toThrow('归集不存在')
    expect(() => completeCollection(db, '不存在')).toThrow('归集不存在')
    expect(db.prepare('SELECT * FROM batch_import_sessions WHERE id = ?').get(session.id)).toEqual(session)
  })

  it('不存在的会话拒绝绑定，不创建隐式会话', () => {
    const db = database()
    const collection = createCollection(db, '甲')
    expect(() => bindSession(db, collection.id, '不存在')).toThrow('导入会话不存在')
    expect(listCollectionSessions(db, collection.id)).toEqual([])
  })

  it('完成的归集不能绑定新会话，也不能绕过状态检查重复绑定', () => {
    const db = database()
    const collection = createCollection(db, '甲')
    const member = createBatchImportSession(db, 'workbuddy')
    bindSession(db, collection.id, member.id)
    db.prepare("UPDATE batch_import_sessions SET status = 'success' WHERE id = ?").run(member.id)
    completeCollection(db, collection.id)
    const fresh = createBatchImportSession(db, 'workbuddy')
    expect(() => bindSession(db, collection.id, fresh.id)).toThrow('已完成的归集')
    expect(() => bindSession(db, collection.id, member.id)).toThrow('已完成的归集')
    expect(listCollectionSessions(db, collection.id)).toHaveLength(1)
    expect(db.prepare('SELECT collection_id FROM batch_import_sessions WHERE id = ?').get(fresh.id)).toEqual({ collection_id: null })
  })

  it.each(['pending', 'preparing', 'in_progress'])('存在 %s 会话不能完成，事务回滚且完成时间为空', (status) => {
    const db = database()
    const collection = createCollection(db, '甲')
    const session = createBatchImportSession(db, 'workbuddy')
    bindSession(db, collection.id, session.id)
    db.prepare('UPDATE batch_import_sessions SET status = ? WHERE id = ?').run(status, session.id)
    expect(() => completeCollection(db, collection.id)).toThrow('未终结')
    expect(getCollection(db, collection.id)).toEqual(collection)
    db.exec('BEGIN IMMEDIATE; ROLLBACK')
  })

  it.each(['success', 'partial_success', 'failed'])('会话为 %s 时可以完成，不改变会话或附件终态', (status) => {
    const db = database()
    const collection = createCollection(db, '甲')
    const session = createBatchImportSession(db, 'workbuddy')
    const item = createBatchImportItem(db, session.id, 0)
    bindSession(db, collection.id, session.id)
    db.prepare('UPDATE batch_import_sessions SET status = ? WHERE id = ?').run(status, session.id)
    db.prepare("UPDATE batch_import_items SET status = 'failed', error_summary = '隔离失败记录' WHERE id = ?").run(item.id)
    const beforeSessions = listCollectionSessions(db, collection.id)
    const beforeItems = listBatchImportItems(db, session.id)
    expect(completeCollection(db, collection.id)).toMatchObject({ status: 'completed', completed_at: expect.any(String) })
    expect(listCollectionSessions(db, collection.id)).toEqual(beforeSessions)
    expect(listBatchImportItems(db, session.id)).toEqual(beforeItems)
  })

  it('空归集可以完成，其他归集的未完成会话不影响它', () => {
    const db = database()
    const empty = createCollection(db, '甲')
    const other = createCollection(db, '乙')
    bindSession(db, other.id, createBatchImportSession(db, 'workbuddy').id)
    expect(completeCollection(db, empty.id).status).toBe('completed')
    expect(getCollection(db, other.id)?.status).toBe('collecting')
  })

  it('多个成员全部终结后可完成，保留混合结果与原导入任务，不将失败视为全部成功', () => {
    const db = database()
    const collection = createCollection(db, '混合结果')
    for (const status of ['success', 'partial_success', 'failed']) {
      const session = createBatchImportSession(db, 'workbuddy')
      const item = createBatchImportItem(db, session.id, 0)
      bindSession(db, collection.id, session.id)
      db.prepare('UPDATE batch_import_sessions SET status = ? WHERE id = ?').run(status, session.id)
      db.prepare('UPDATE batch_import_items SET status = ? WHERE id = ?').run(status, item.id)
      const job = importChatContent(db, '隔离聊天.json', 'JSON', JSON.stringify([
        { conversation_name: '隔离群', sender_name: '甲', timestamp: '2026-10-04 09:00', content: `隔离消息 ${status}` }
      ]))
      attachImportJobToBatchItem(db, job.jobId, item.id)
    }
    const tables = ['batch_import_sessions', 'batch_import_items', 'import_jobs', 'messages', 'messages_fts']
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    expect(completeCollection(db, collection.id).status).toBe('completed')
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before)
    expect(listCollectionSessions(db, collection.id).map((session) => session.status).sort())
      .toEqual(['failed', 'partial_success', 'success'])
  })

  it('完成时间只写一次，重复完成不改变创建时间和完成时间', () => {
    const db = database()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T00:00:00Z'))
    const collection = createCollection(db, '甲')
    vi.setSystemTime(new Date('2026-10-05T00:00:01Z'))
    const completed = completeCollection(db, collection.id)
    expect(completed).toEqual({ ...collection, status: 'completed', completed_at: '2026-10-05T00:00:01.000Z' })
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'))
    expect(completeCollection(db, collection.id)).toEqual(completed)
    expect(getCollection(db, collection.id)).toEqual(completed)
  })

  it('旧式空归属会话仍正常创建附件和查询，不强制创建归集', () => {
    const db = database()
    const session = createBatchImportSession(db, 'workbuddy')
    const item = createBatchImportItem(db, session.id, 0)
    expect(session.collection_id).toBeNull()
    expect(listBatchImportItems(db, session.id)).toEqual([item])
    expect(listCollections(db)).toEqual([])
  })

  it('绑定写入失败时回滚，不留下半完成事务或归属', () => {
    const db = database()
    const collection = createCollection(db, '甲')
    const session = createBatchImportSession(db, 'workbuddy')
    db.exec(`CREATE TRIGGER reject_binding BEFORE UPDATE OF collection_id ON batch_import_sessions
      BEGIN SELECT RAISE(ABORT, '隔离绑定写入故障'); END`)
    expect(() => bindSession(db, collection.id, session.id)).toThrow('隔离绑定写入故障')
    expect(db.prepare('SELECT * FROM batch_import_sessions WHERE id = ?').get(session.id)).toEqual(session)
    db.exec('DROP TRIGGER reject_binding')
    expect(bindSession(db, collection.id, session.id).collection_id).toBe(collection.id)
  })

  it('完成写入失败时回滚状态和时间，之后可以正常完成', () => {
    const db = database()
    const collection = createCollection(db, '甲')
    db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE ON collections
      BEGIN SELECT RAISE(ABORT, '隔离完成写入故障'); END`)
    expect(() => completeCollection(db, collection.id)).toThrow('隔离完成写入故障')
    expect(getCollection(db, collection.id)).toEqual(collection)
    db.exec('DROP TRIGGER reject_completion')
    expect(completeCollection(db, collection.id).status).toBe('completed')
  })
})
