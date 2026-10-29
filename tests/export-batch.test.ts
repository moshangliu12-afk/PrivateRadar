import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { captureConversationBatch, runFormattedExportBatch } from '../src/main/export/export-batch-selection'
import { exportConversations, registerMarkdownExportIpc } from '../src/main/export/markdown-export'
import { ExportSelectionError } from '../src/main/export/chat-selection'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'
import type { ExportFormat } from '../src/shared/markdown-export'

afterEach(cleanupExportFixtures)
const range = { type: 'conversation' as const, start_date: null, end_date: null }
const created = (id: string) => ({ status: 'created' as const, directory: 'D:\\导出\\PrivateRadar\\' + id, messageCount: 1, excludedUnknownTimeCount: 0 })
function twoConversations() {
  const f = exportFixture(); f.add('甲消息', '甲正文')
  f.db.prepare("INSERT INTO conversations(id,platform,name,created_at) VALUES('乙会话','wechat','乙来源群','合成')").run()
  f.add('乙消息', '乙正文'); f.db.prepare("UPDATE messages SET conversation_id='乙会话' WHERE id='乙消息'").run()
  f.evidence('甲消息')
  return { ...f, selection: { ...f.request, conversation_ids: ['导出会话', '乙会话'] } }
}

describe('同一选择集合的顺序导出编排', () => {
  it.each(['markdown', 'json', 'txt', 'pdf'] as const)('%s 接受超过50个会话且逐次处理，不累计正文快照', async format => {
    const ids = Array.from({ length: 51 }, (_, index) => '会话' + index), seen: string[] = []
    let active = 0, peak = 0
    const result = await runFormattedExportBatch(ids, range, ids[0], format, async (id, receivedRange) => {
      active++; peak = Math.max(peak, active); seen.push(id)
      await Promise.resolve(); active--
      expect(receivedRange).toEqual(range)
      return created(id)
    })
    expect(seen).toEqual(ids); expect(peak).toBe(1)
    expect(result).toMatchObject({ status: 'created', batch: { requested: 51, succeeded: 51, remaining: 0, failed: 0 } })
    if (format === 'pdf') expect(result.pdf).toBe(result.batch)
    else expect(result.pdf).toBeUndefined()
  })
  it('无效身份、重复及首选不一致均在任何导出前拒绝', () => {
    for (const ids of [null, [], ['甲', '甲'], ['甲', 7], [' '], ['x'.repeat(8193)]]) {
      expect(() => captureConversationBatch(ids, range)).toThrow('INVALID_SELECTION')
    }
    expect(() => captureConversationBatch(['甲'], range, '乙')).toThrow('INVALID_SELECTION')
  })
  it('稀疏数组在任何会话导出前整体拒绝，Vault选择也不接受缺失身份', async () => {
    const ids = new Array(2); ids[0] = '甲'; let calls = 0
    expect(() => captureConversationBatch(ids, range)).toThrow('INVALID_SELECTION')
    await expect(runFormattedExportBatch(ids, range, '甲', 'json', async id => { calls++; return created(id) })).rejects.toThrow('INVALID_SELECTION')
    expect(calls).toBe(0)
  })
  it('普通文件批量请求必须提供与首项一致的主会话，不能省略', async () => {
    let calls = 0
    await expect(runFormattedExportBatch(['甲'], range, undefined, 'json', async id => { calls++; return created(id) })).rejects.toThrow('INVALID_SELECTION')
    expect(calls).toBe(0)
  })
  it('开始时固定身份与日期，调用者修改原数组不会改动待导出集合', async () => {
    const ids = ['甲', '乙'], seen: string[] = []
    const result = await runFormattedExportBatch(ids, range, '甲', 'json', async id => {
      seen.push(id); ids[1] = '伪造后加'; return created(id)
    })
    expect(seen).toEqual(['甲', '乙']); expect(result.batch?.succeeded).toBe(2)
  })
  it('失败不泄露内部详情，取消保留完成统计并标记剩余', async () => {
    const controller = new AbortController()
    const result = await runFormattedExportBatch(['甲', '乙', '丙', '丁'], range, '甲', 'markdown', async id => {
      if (id === '乙') throw Error('内部私有正文和路径')
      if (id === '丙') controller.abort()
      return created(id)
    }, controller.signal)
    expect(result).toMatchObject({ status: 'cancelled', batch: { succeeded: 2, failed: 1, remaining: 1 } })
    expect(JSON.stringify(result)).not.toContain('内部私有正文和路径')
  })
  it.each(['EXPORT_UNSUPPORTED', 'ENOSPC'] as const)('全局%s故障停止后续会话，明确未处理数量', async code => {
    let calls = 0
    const result = await runFormattedExportBatch(['甲', '乙', '丙'], range, '甲', 'json', async () => {
      calls++
      if (code === 'EXPORT_UNSUPPORTED') throw new ExportSelectionError(code, '当前输出环境不支持。')
      throw Object.assign(Error('内部磁盘路径'), { code })
    })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ status: 'failed', batch: { failed: 1, remaining: 2 } })
    expect(JSON.stringify(result)).not.toContain('内部磁盘路径')
  })
})

describe.skipIf(process.platform !== 'win32')('复用已验收单会话文件出口', () => {
  it.each(['markdown', 'json', 'txt', 'pdf'] as const)('%s 两会话分别输出、重复跳过、原库及关系和表结构不变', async format => {
    const f = twoConversations(), before = sourceFingerprint(f.db), schema = f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    // 仅 PDF 编排使用替代字节，不据此证明真实打印或排版。
    const options = { format: format as ExportFormat, renderPdf: async () => Buffer.from('%PDF-1.7\n' + '打印替代字节'.repeat(15) + '\n%%EOF') }
    const result = await exportConversations(f.databasePath, f.output, f.selection, '测试版本', options)
    expect(result).toMatchObject({ status: 'created', batch: { requested: 2, created: 2, failed: 0 } })
    const folders = readdirSync(result.directory!)
    expect(folders).toHaveLength(2)
    const names = folders.map(folder => readdirSync(join(result.directory!, folder)).find(name => name !== 'export.json')!)
    const extension = format === 'markdown' ? '.md' : '.' + format
    expect(names.every(name => name.endsWith(extension))).toBe(true)
    if (format !== 'pdf') {
      const texts = folders.map((folder, index) => readFileSync(join(result.directory!, folder, names[index]), 'utf8')).join('\n')
      expect(texts).toContain('甲正文'); expect(texts).toContain('乙正文')
    }
    expect(await exportConversations(f.databasePath, f.output, f.selection, '测试版本', options)).toMatchObject({ status: 'unchanged', batch: { unchanged: 2 } })
    expect(sourceFingerprint(f.db)).toEqual(before)
    expect(f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(schema)
    expect(readdirSync(f.data).filter(name => name.endsWith('.db'))).toEqual(['private-radar.db'])
  }, 30000)
  it('原桌面通道将非PDF多选交给批量编排，旧单会话请求仍无batch字段', async () => {
    const f = twoConversations(), handlers = new Map<string, (...args: any[]) => any>()
    registerMarkdownExportIpc({ handle: (name, fn) => handlers.set(name, fn) }, f.db, f.databasePath, '测试版本',
      { chooseDirectory: async () => f.output, openDirectory: async () => '' })
    await handlers.get('markdown-export:choose-directory')!(null)
    const result = await handlers.get('markdown-export:start')!(null, { ...f.selection, format: 'json' })
    expect(result).toMatchObject({ ok: true, value: { batch: { succeeded: 2 } } })
    const legacy = await handlers.get('markdown-export:start')!(null, { ...f.request, format: 'json' })
    expect(legacy.ok).toBe(true); expect(legacy.value.batch).toBeUndefined()
  }, 30000)
  it.each(['抛出错误', '无效打印字节'])('单个PDF渲染失败后仍尝试下一会话：%s', async failure => {
    const f = twoConversations(); let renderCalls = 0
    const result = await exportConversations(f.databasePath, f.output, f.selection, '测试版本', {
      format: 'pdf', renderPdf: async () => {
        if (++renderCalls === 1) {
          if (failure === '抛出错误') throw new ExportSelectionError('EXPORT_IO_ERROR', '单个打印页面失败。')
          return Buffer.from('无效PDF字节')
        }
        return Buffer.from('%PDF-1.7\n' + '打印替代'.repeat(20) + '\n%%EOF')
      }
    })
    expect(renderCalls).toBe(2)
    expect(result).toMatchObject({ status: 'partial', batch: { created: 1, failed: 1, remaining: 0 } })
    expect(readdirSync(result.directory!)).toHaveLength(1)
  }, 30000)
  it('实际暂存写入失败后停止整批，保留未处理数量且清理半成品', async () => {
    const f = twoConversations(); let writes = 0
    const result = await exportConversations(f.databasePath, f.output, f.selection, '测试版本', {
      format: 'json', writeStagedFile: async () => { writes++; throw Error('内部写入路径与磁盘故障') }
    })
    expect(writes).toBe(1)
    expect(result).toMatchObject({ status: 'failed', batch: { failed: 1, remaining: 1 } })
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    expect(JSON.stringify(result)).not.toContain('内部写入路径与磁盘故障')
  }, 30000)
})
