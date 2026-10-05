import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession, attachImportJobToBatchItem } from '../src/main/batch-import/repository'
import { createCollection, completeCollection } from '../src/main/collections/service'
import { getDesktopCollection, listDesktopCollections, listDesktopCollectionSessions, registerCollectionIpc } from '../src/main/collections/desktop'
import { importChatContent } from '../src/main/import/importer'

const databases: DatabaseSync[] = []
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db); initializeDatabase(db)
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  registerCollectionIpc({ handle: (name, handler) => handlers.set(name, handler) }, db)
  const call = (name: string, value?: unknown): any => handlers.get(`collections:${name}`)!(undefined, value)
  return { db, handlers, call }
}

describe('批量收集桌面只读查询与真实 IPC', () => {
  it('空列表为空且只注册五个最小通道，不公开绑定、删除或重试', () => {
    const f = fixture()
    expect(f.call('list')).toEqual([])
    expect([...f.handlers.keys()].sort()).toEqual(['collections:complete', 'collections:create', 'collections:get', 'collections:list', 'collections:sessions'])
  })
  it('通过 IPC 创建时 trim，由服务端生成完整 UUID，同名互不覆盖', () => {
    const f = fixture(), first = f.call('create', '  同名收集  '), second = f.call('create', '同名收集')
    expect(first.display_name).toBe('同名收集')
    expect(first.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    expect(second.id).not.toBe(first.id)
    expect(f.call('list')).toHaveLength(2)
    expect(f.call('get', first.id).collection).toEqual(first)
  })
  it.each(['', '  ', null, 42])('IPC 不绕过服务端名称校验：%j', (name) => {
    const f = fixture()
    expect(() => f.call('create', name)).toThrow('名称不能为空')
    expect(f.call('list')).toEqual([])
  })
  it('详情固定按完整 ID，名称及截断 ID 均不作为身份，也不退回最近记录', () => {
    const f = fixture(), first = f.call('create', '同名'), latest = f.call('create', '同名')
    expect(f.call('get', first.id).collection.id).toBe(first.id)
    expect(f.call('get', latest.id).collection.id).toBe(latest.id)
    expect(() => f.call('get', '同名')).toThrow('INVALID_COLLECTION_ID')
    expect(() => f.call('sessions', first.id.slice(0, 8))).toThrow('INVALID_COLLECTION_ID')
    expect(f.call('get', '00000000-0000-4000-8000-000000000000')).toBeNull()
  })
  it('按真实会话时间排序，刷新可读到新会话，旧空归属记录不被收编', () => {
    const f = fixture(), c = createCollection(f.db, '目标')
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T01:00:00Z'))
    const first = createBatchImportSession(f.db, 'workbuddy', c.id)
    const old = createBatchImportSession(f.db, 'workbuddy')
    expect(f.call('sessions', c.id).map((s: { id: string }) => s.id)).toEqual([first.id])
    vi.setSystemTime(new Date('2026-10-05T02:00:00Z'))
    const second = createBatchImportSession(f.db, 'workbuddy', c.id)
    createBatchImportItem(f.db, second.id, 1, '真实附件名')
    createBatchImportItem(f.db, second.id, 0)
    const detail = f.call('get', c.id)
    expect(detail.sessions.map((s: { id: string }) => s.id)).toEqual([first.id, second.id])
    expect(detail.sessions[1].items.map((i: { ordinal: number }) => i.ordinal)).toEqual([0, 1])
    expect(f.db.prepare('SELECT collection_id FROM batch_import_sessions WHERE id = ?').get(old.id)).toEqual({ collection_id: null })
    expect(listDesktopCollections(f.db)[0]).toMatchObject({ sessionCount: 2, itemCount: 2, activeItems: 2 })
  })
  it('列表准确展示附件成功、失败、部分成功与待结束概况，包括空会话', () => {
    const f = fixture(), c = createCollection(f.db, '混合状态')
    createBatchImportSession(f.db, 'workbuddy', c.id)
    const session = createBatchImportSession(f.db, 'workbuddy', c.id)
    for (const [ordinal, status] of ['success', 'failed', 'partial_success', 'pending', 'preparing', 'in_progress'].entries()) {
      const item = createBatchImportItem(f.db, session.id, ordinal)
      f.db.prepare('UPDATE batch_import_items SET status = ? WHERE id = ?').run(status, item.id)
    }
    expect(listDesktopCollections(f.db)[0]).toMatchObject({ sessionCount: 2, itemCount: 6, successfulItems: 1, failedItems: 1, partialItems: 1, activeItems: 3 })
  })
  it('任务统计只读取匹配附件的当前有效任务，不累计历史新增数，不伪造空统计', () => {
    const f = fixture(), c = createCollection(f.db, '任务统计')
    const session = createBatchImportSession(f.db, 'workbuddy', c.id), item = createBatchImportItem(f.db, session.id, 0, '附件.zip')
    expect(getDesktopCollection(f.db, c.id)?.sessions[0].stats).toBeNull()
    const content = JSON.stringify([{ conversation_name: '隔离群', sender_name: '甲', content: '合成消息', timestamp: '2026-10-05 09:00' }])
    const old = importChatContent(f.db, '隔离.json', 'JSON', content)
    attachImportJobToBatchItem(f.db, old.jobId, item.id)
    f.db.prepare('UPDATE import_jobs SET imported_count = 999 WHERE id = ?').run(old.jobId)
    const current = importChatContent(f.db, '隔离.json', 'JSON', content)
    attachImportJobToBatchItem(f.db, current.jobId, item.id)
    f.db.prepare('UPDATE batch_import_items SET effective_job_id = ?, evidence_relative_path = ?, evidence_status = ? WHERE id = ?')
      .run(current.jobId, '只读元数据/不会访问物理文件', 'available', item.id)
    const view = getDesktopCollection(f.db, c.id)!.sessions[0]
    expect(view.stats).toEqual({ imported: current.importedCount, duplicate: current.duplicateCount, updated: current.updatedCount, invalid: current.invalidCount })
    expect(view.items[0]).toMatchObject({ attachment_name: '附件.zip', evidenceRecorded: true, evidence_status: 'available', job: { id: current.jobId, status: 'success' } })
    const otherItem = createBatchImportItem(f.db, session.id, 1)
    f.db.prepare('UPDATE batch_import_items SET effective_job_id = ? WHERE id = ?').run(current.jobId, otherItem.id)
    expect(listDesktopCollectionSessions(f.db, c.id)[0].items[1].job).toBeNull()
  })
  it('所有读取零写入，不触发派生、证据校验或变更已有业务表', () => {
    const f = fixture(), c = createCollection(f.db, '只读')
    createBatchImportItem(f.db, createBatchImportSession(f.db, 'workbuddy', c.id).id, 0)
    const tables = ['collections', 'batch_import_sessions', 'batch_import_items', 'import_jobs', 'messages', 'messages_fts', 'app_settings']
    const before = tables.map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
    const changes = f.db.prepare('SELECT total_changes() AS count').get()
    f.call('list'); f.call('get', c.id); f.call('sessions', c.id)
    expect(tables.map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).toEqual(before)
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
    expect(f.db.isTransaction).toBe(false)
  })
  it.each(['pending', 'preparing', 'in_progress'])('完成规则只由服务端决定，%s 会话存在时拒绝', (status) => {
    const f = fixture(), c = f.call('create', '未结束')
    const session = createBatchImportSession(f.db, 'workbuddy', c.id)
    f.db.prepare('UPDATE batch_import_sessions SET status = ? WHERE id = ?').run(status, session.id)
    expect(() => f.call('complete', c.id)).toThrow('未终结')
    expect(f.call('get', c.id).collection.status).toBe('collecting')
  })
  it('完成后保留历史与完成时间，继续加入新会话时仍由既有服务端明确拒绝', () => {
    const f = fixture(), c = f.call('create', '完成')
    const session = createBatchImportSession(f.db, 'workbuddy', c.id)
    f.db.prepare("UPDATE batch_import_sessions SET status = 'failed' WHERE id = ?").run(session.id)
    createBatchImportItem(f.db, session.id, 0)
    const completed = f.call('complete', c.id)
    expect(completed).toMatchObject({ status: 'completed', completed_at: expect.any(String) })
    expect(f.call('get', c.id).sessions).toHaveLength(1)
    expect(() => createBatchImportSession(f.db, 'workbuddy', c.id)).toThrow('COLLECTION_COMPLETED')
    expect(completeCollection(f.db, c.id)).toEqual(completed)
  })
})
