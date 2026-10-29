import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { registerSearchHistoryIpc, readSearchHistory, SEARCH_HISTORY_SETTING } from '../src/main/search-history'
import type { SearchHistoryApi } from '../src/shared/search-history'
import { exportFixture, cleanupExportFixtures, sourceFingerprint } from './markdown-export-fixture'

const electron = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.expose }, ipcRenderer: { invoke: electron.invoke } }))
afterEach(() => { vi.restoreAllMocks(); cleanupExportFixtures() })
function setup(db?: DatabaseSync) {
  const f = db ? null : exportFixture(), database = db ?? f!.db
  const handlers = new Map<string, (...args: any[]) => any>()
  registerSearchHistoryIpc({ handle: (channel, action) => handlers.set(channel, action) }, database)
  return { f, db: database, call: (name: string, ...args: any[]) => handlers.get('search-history:' + name)!(null, ...args) }
}
describe('最近搜索复用原库设置', () => {
  it('未搜索时只读空历史，不建立新键或写入其它状态', () => {
    const { db, call } = setup(), before = db.prepare('SELECT * FROM app_settings ORDER BY key').all()
    expect(call('list')).toEqual({ ok: true, value: [] })
    expect(db.prepare('SELECT * FROM app_settings ORDER BY key').all()).toEqual(before)
  })
  it('实际记录后仅留六条、去重移到最前且保留实际查询中的空白语义', () => {
    const { call } = setup()
    for (let i = 1; i <= 7; i++) call('record', '问题' + i)
    expect(call('list').value).toEqual(['问题7', '问题6', '问题5', '问题4', '问题3', '问题2'])
    call('record', '  中文   查询  '); call('record', '另一条'); call('record', '中文 查询')
    expect(call('list').value.slice(0, 2)).toEqual(['中文 查询', '另一条'])
    call('record', '"原始   引号"  内容')
    expect(call('list').value[0]).toBe('"原始   引号"  内容')
  })
  it('重开同一个数据库后历史仍在，单删和清空也立即持久化', () => {
    const first = setup(), f = first.f!
    first.call('record', '中文😀'); first.call('record', '另一条')
    f.db.close()
    const db = new DatabaseSync(f.databasePath)
    try {
      const second = setup(db)
      expect(second.call('list').value).toEqual(['另一条', '中文😀'])
      expect(second.call('remove', '另一条').value).toEqual(['中文😀'])
      expect(JSON.parse(String(db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(SEARCH_HISTORY_SETTING)!.value_json))).toEqual(['中文😀'])
      expect(second.call('clear')).toEqual({ ok: true, value: [] })
      expect(readSearchHistory(db)).toEqual([])
    } finally { db.close() }
  })
  it('非法、损坏与超大存储安全处理，输入错误不改写现有历史', () => {
    const { db, call } = setup()
    call('record', '保留')
    for (const value of [null, {}, '', '  ', '文'.repeat(3000)]) {
      expect(call('record', value)).toMatchObject({ ok: false })
      expect(call('list').value).toEqual(['保留'])
    }
    for (const stored of ['不是JSON', '{}', JSON.stringify(['有效', 1, null, '有效', '']), JSON.stringify(['大'.repeat(200000)])]) {
      db.prepare('UPDATE app_settings SET value_json=? WHERE key=?').run(stored, SEARCH_HISTORY_SETTING)
      expect(call('list')).toEqual({ ok: true, value: stored.includes('有效') ? ['有效'] : [] })
    }
  })
  it('仅写搜索词到独立key，消息、证据、库结构、Vault设置不变，无外发', () => {
    const { f, db, call } = setup(); f!.add('消息'); f!.evidence('消息')
    db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)').run('obsidian_vault_path', JSON.stringify('D:\\知识库'), '原设置')
    const state = sourceFingerprint(db), schema = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    const other = db.prepare('SELECT * FROM app_settings WHERE key<>? ORDER BY key').all(SEARCH_HISTORY_SETTING)
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止外发'))
    call('record', '查询'); call('remove', '查询'); call('record', '保留搜索词')
    expect(sourceFingerprint(db)).toEqual(state)
    expect(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(schema)
    expect(db.prepare('SELECT * FROM app_settings WHERE key<>? ORDER BY key').all(SEARCH_HISTORY_SETTING)).toEqual(other)
    expect(db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(SEARCH_HISTORY_SETTING)).toEqual({ value_json: JSON.stringify(['保留搜索词']) })
    expect(readdirSync(f!.data).filter(name => name.endsWith('.db'))).toEqual(['private-radar.db'])
    expect(network).not.toHaveBeenCalled()
  })
  it('存储故障返回安全错误，不向界面泄漏SQL或路径', () => {
    const { db, call } = setup(); db.close()
    const result = call('record', '查询')
    expect(result).toEqual({ ok: false, error: { message: '最近搜索未能读取或保存，本次搜索仍可继续。' } })
  })
  it('preload只有固定历史操作，不提供任意设置键、文件或网络接口', async () => {
    electron.invoke.mockClear()
    await import('../src/preload/index')
    const api = electron.expose.mock.calls[0][1].searchHistory as SearchHistoryApi
    await api.list(); await api.record('查询'); await api.remove('查询'); await api.clear()
    expect(electron.invoke.mock.calls).toEqual([['search-history:list'], ['search-history:record', '查询'], ['search-history:remove', '查询'], ['search-history:clear']])
  })
})
