import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { exportObsidianConversations } from '../src/main/export/obsidian-batch'
import { exportObsidianVault, VAULT_MANIFEST, type VaultManifest } from '../src/main/export/obsidian-export'
import { sha256 } from '../src/main/export/chat-markdown'
import { ExportSelectionError } from '../src/main/export/chat-selection'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'
import type { ObsidianExportOutcome } from '../src/shared/obsidian-export'

// 本组用注入的单会话 worker 验证编排，不执行文件发布。非 Windows runner
// 显式提供 Windows 路径词法依赖；真实 Windows 集成仍使用原安全实现。
vi.mock('../src/main/batch-import/windows-path-lease', async original => {
  const actual = await original<typeof import('../src/main/batch-import/windows-path-lease')>()
  return { ...actual, safeAbsolutePath: (value: string) => {
    if (process.platform === 'win32') return actual.safeAbsolutePath(value)
    if (!win32.isAbsolute(value) || !/^[A-Za-z]:[\\/]/.test(value) || /[\x00-\x1f]/.test(value) || value.split(/[\\/]/).includes('..')) throw new Error('测试路径必须是安全的 Windows 绝对路径')
    return win32.resolve(value)
  } }
})

afterEach(() => { vi.restoreAllMocks(); cleanupExportFixtures() })
const range = { type: 'conversation' as const, start_date: null, end_date: null }
const single = (): ObsidianExportOutcome => ({ status: 'completed', directory: 'D:\\Vault\\PrivateRadar', conversationCount: 1,
  created: 1, updated: 0, skipped: 0, preserved: 0, failed: 0, manifestRecovered: false, userModifiedFilePreserved: false })

describe('Vault 不限选择数的顺序编排', () => {
  it('51个会话逐次进入原单会话核心，保留日期范围，不累计并发和正文', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => '会话' + index)
    const seen: string[] = []; let active = 0, peak = 0
    const worker: typeof exportObsidianVault = async (_database, _vault, request) => {
      active++; peak = Math.max(peak, active)
      expect(request.conversation_ids).toHaveLength(1); expect(request.range).toEqual(range)
      seen.push(request.conversation_ids[0]); await Promise.resolve(); active--
      return single()
    }
    const result = await exportObsidianConversations('D:\\source.db', 'D:\\Vault', { conversation_ids: ids, range }, {}, worker)
    expect(seen).toEqual(ids); expect(peak).toBe(1)
    expect(result).toMatchObject({ created: 51, conversationCount: 51, batch: { requested: 51, processed: 51, remaining: 0, errors: [] } })
  })
  it('已完成会话后资源错误停止，保留统计并明确未处理部分', async () => {
    let calls = 0
    const worker: typeof exportObsidianVault = async () => {
      if (++calls === 2) throw new ExportSelectionError('EXPORT_LIMIT_EXCEEDED', '真实资源边界')
      return single()
    }
    const result = await exportObsidianConversations('D:\\source.db', 'D:\\Vault', { conversation_ids: ['甲', '乙', '丙'], range }, {}, worker)
    expect(calls).toBe(2)
    expect(result).toMatchObject({ created: 1, failed: 1, batch: { processed: 2, remaining: 1, errors: [{ conversationId: '乙', code: 'EXPORT_LIMIT_EXCEEDED' }] } })
  })
  it('首个会话开始前目录失效时保留原错误，不包装成正常完成', async () => {
    const failure = new ExportSelectionError('EXPORT_PATH_UNSAFE', 'Vault 不可用，请重新选择目录。')
    const worker: typeof exportObsidianVault = vi.fn(async () => { throw failure })
    await expect(exportObsidianConversations('D:\\source.db', 'D:\\Vault', { conversation_ids: ['甲', '乙'], range }, {}, worker)).rejects.toBe(failure)
    expect(worker).toHaveBeenCalledTimes(1)
  })
  it('部分完成后目录失效时保留完成计数并停止余下会话', async () => {
    let calls = 0
    const worker: typeof exportObsidianVault = async () => {
      if (++calls === 2) throw new ExportSelectionError('EXPORT_PATH_UNSAFE', 'Vault 不可用，请重新选择目录。')
      return single()
    }
    const result = await exportObsidianConversations('D:\\source.db', 'D:\\Vault', { conversation_ids: ['甲', '乙', '丙'], range }, {}, worker)
    expect(calls).toBe(2)
    expect(result).toMatchObject({ created: 1, failed: 1, batch: { processed: 2, remaining: 1, errors: [{ conversationId: '乙', code: 'EXPORT_PATH_UNSAFE' }] } })
  })
  it('取消保留已完成计数与当前单会话已发布的完整文件计数', async () => {
    let calls = 0
    const worker: typeof exportObsidianVault = async () => ++calls === 2 ? { ...single(), status: 'cancelled' } : single()
    const result = await exportObsidianConversations('D:\\source.db', 'D:\\Vault', { conversation_ids: ['甲', '乙', '丙'], range }, {}, worker)
    expect(calls).toBe(2)
    expect(result).toMatchObject({ status: 'cancelled', created: 2, batch: { processed: 1, remaining: 2 } })
  })
  it('来源个别缺失可以继续，未知错误不泄漏内部路径', async () => {
    const worker: typeof exportObsidianVault = async (_database, _vault, request) => {
      if (request.conversation_ids[0] === '甲') throw new ExportSelectionError('CONVERSATION_NOT_FOUND', '所选会话不存在。')
      if (request.conversation_ids[0] === '丙') throw Error('秘密路径与正文')
      return single()
    }
    const result = await exportObsidianConversations('D:\\source.db', 'D:\\Vault', { conversation_ids: ['甲', '乙', '丙', '丁'], range }, {}, worker)
    expect(result).toMatchObject({ created: 1, failed: 2, batch: { processed: 3, remaining: 1 } })
    expect(JSON.stringify(result)).not.toContain('秘密路径与正文')
  })
  it('系统时区跨会话改变时停止，不把剩余会话记为成功', async () => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions
    let changed = false, calls = 0
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      const result = original.call(this)
      return { ...result, timeZone: changed ? 'Asia/Tokyo' : 'America/New_York' }
    })
    const worker: typeof exportObsidianVault = async () => { calls++; changed = true; return single() }
    const result = await exportObsidianConversations('D:\\source.db', 'D:\\Vault', { conversation_ids: ['甲', '乙', '丙'], range }, {}, worker)
    expect(calls).toBe(1)
    expect(result).toMatchObject({ created: 1, failed: 1, batch: { remaining: 1, errors: [{ code: 'TIMEZONE_CHANGED' }] } })
  })
})

describe.skipIf(process.platform !== 'win32')('Vault 原清单与资源边界保持', () => {
  it('真实两会话顺序归档，重复跳过，源库与Evidence和schema不变', async () => {
    const f = exportFixture(); f.add('甲消息', '甲正文'); f.evidence('甲消息')
    f.db.prepare("INSERT INTO conversations(id,platform,name,created_at) VALUES('乙会话','wechat','乙群','合成')").run()
    f.add('乙消息', '乙正文'); f.db.prepare("UPDATE messages SET conversation_id='乙会话' WHERE id='乙消息'").run()
    const before = sourceFingerprint(f.db), schema = f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    const request = { conversation_ids: ['导出会话', '乙会话'], range }
    expect(await exportObsidianConversations(f.databasePath, f.output, request)).toMatchObject({ created: 2, batch: { processed: 2, remaining: 0 } })
    expect(await exportObsidianConversations(f.databasePath, f.output, request)).toMatchObject({ skipped: 2, created: 0 })
    const manifest = JSON.parse(readFileSync(join(f.output, 'PrivateRadar', VAULT_MANIFEST), 'utf8')) as VaultManifest
    expect(manifest.conversations).toHaveLength(2); expect(manifest.files).toHaveLength(2)
    for (const file of manifest.files) expect(readFileSync(join(f.output, 'PrivateRadar', file.relative_path), 'utf8')).toContain(file.conversation_id === '导出会话' ? '甲正文' : '乙正文')
    expect(sourceFingerprint(f.db)).toEqual(before)
    expect(f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(schema)
  }, 30000)
  it('达到已有10000条会话映射安全容量时不发布文档或改变原清单', async () => {
    const f = exportFixture(); f.add('新增会话正文')
    const root = join(f.output, 'PrivateRadar'), manifestPath = join(root, VAULT_MANIFEST)
    mkdirSync(join(root, '.privateradar'), { recursive: true })
    const conversations = Array.from({ length: 10000 }, (_, index) => ({ conversation_id: '已有' + index,
      directory: '已有--' + sha256('已有' + index).slice(0, 16) }))
    const bytes = Buffer.from(JSON.stringify({ version: 1, vault_export_version: 'obsidian-v1', conversations, files: [] }))
    writeFileSync(manifestPath, bytes)
    await expect(exportObsidianVault(f.databasePath, f.output, { conversation_ids: ['导出会话'], range })).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
    expect(readFileSync(manifestPath)).toEqual(bytes)
  }, 30000)
})
