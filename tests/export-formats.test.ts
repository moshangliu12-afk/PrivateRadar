import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCanonicalExportSnapshot } from '../src/main/export/chat-selection'
import { createMarkdownExport, sha256 } from '../src/main/export/chat-markdown'
import { createExportFiles, validateExportFormat } from '../src/main/export/chat-formats'
import { exportChat, exportMarkdown, registerMarkdownExportIpc } from '../src/main/export/markdown-export'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'

afterEach(cleanupExportFixtures)
describe.each(['json', 'txt'] as const)('复用安全发布链 %s', format => {
  it.skipIf(process.platform !== 'win32')('完整导出、清单匹配、相同数据复用、用户修改后新版本及单一源库保护', async () => {
    const f = exportFixture(); f.add('消息', '完整原文🙂\r\nURL https://example.invalid'); f.evidence('消息')
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const bytes = readFileSync(f.databasePath), state = sourceFingerprint(f.db), options = { format }
    const first = await exportChat(f.databasePath, f.output, f.request, '测试版本', options)
    expect(first.status).toBe('created')
    const filename = `聊天.${format}`, file = join(first.directory!, filename), content = readFileSync(file)
    const manifest = JSON.parse(readFileSync(join(first.directory!, 'export.json'), 'utf8'))
    expect(readdirSync(first.directory!).sort()).toEqual(['export.json', filename])
    expect(manifest).toMatchObject({ export_format: format, output: { path: filename, bytes: content.length, sha256: sha256(content) } })
    if (format === 'json') expect(JSON.parse(content.toString()).messages[0].content).toBe('完整原文🙂\r\nURL https://example.invalid')
    else expect(content.toString()).toContain('完整原文🙂\r\nURL https://example.invalid')
    expect((await exportChat(f.databasePath, f.output, f.request, '测试版本', options)).status).toBe('unchanged')
    writeFileSync(file, '用户手动编辑的文件')
    const second = await exportChat(f.databasePath, f.output, f.request, '测试版本', options)
    expect(second.directory).toBe(first.directory + '--v2')
    expect(readFileSync(file, 'utf8')).toBe('用户手动编辑的文件')
    expect(readFileSync(f.databasePath)).toEqual(bytes); expect(sourceFingerprint(f.db)).toEqual(state)
    expect(readdirSync(f.data).filter(name => name.endsWith('.db'))).toEqual(['private-radar.db'])
  })
  it.skipIf(process.platform !== 'win32')('第二文件部分写入失败和取消，沿用 staging 清理且不破坏已有笔记', async () => {
    const f = exportFixture(); f.add('消息'); const note = join(f.output, '既有笔记.txt'); writeFileSync(note, '保留笔记')
    await expect(exportChat(f.databasePath, f.output, f.request, '测试版本', { format, writeStagedFile: async (file, bytes) => {
      writeFileSync(file, basename(file) === 'export.json' ? bytes.subarray(0, 10) : bytes, { flag: 'wx' })
      if (basename(file) === 'export.json') throw new Error('模拟写入失败')
    } })).rejects.toThrow('模拟写入失败')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    const controller = new AbortController()
    await expect(exportChat(f.databasePath, f.output, f.request, '测试版本', { format, signal: controller.signal, beforePublish: async () => { controller.abort() } })).rejects.toThrow('EXPORT_CANCELLED')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([]); expect(readFileSync(note, 'utf8')).toBe('保留笔记')
  })
  it.skipIf(process.platform !== 'win32')('不安全标签继续安全化，目标抢占和损坏格式元数据不会覆盖旧内容', async () => {
    const f = exportFixture(); f.add('消息'); f.db.prepare('UPDATE conversations SET user_conversation_label=?').run('..\\..\\CON')
    let race = true, oldTarget = ''
    const first = await exportChat(f.databasePath, f.output, f.request, '测试版本', { format, beforePublish: async (_stage, destination) => {
      if (race) { race = false; oldTarget = destination; mkdirSync(destination) }
    } })
    expect(first.directory).toBe(oldTarget + '--v2'); expect(readdirSync(oldTarget)).toEqual([])
    expect(first.directory!.startsWith(join(f.output, 'PrivateRadar') + '\\')).toBe(true)
    expect(basename(first.directory!)).not.toMatch(/[\\/]/)
    writeFileSync(join(first.directory!, 'export.json'), '{损坏')
    const second = await exportChat(f.databasePath, f.output, f.request, '测试版本', { format })
    expect(second.directory).toBe(oldTarget + '--v3')
    expect(readFileSync(join(first.directory!, 'export.json'), 'utf8')).toBe('{损坏')
  })
  it.skipIf(process.platform !== 'win32')('桌面 IPC 传递格式并使用同一个原生目录选择器和数据库', async () => {
    const f = exportFixture(); f.add('消息')
    const handlers = new Map<string, (event: unknown, ...args: any[]) => any>()
    registerMarkdownExportIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, f.db, f.databasePath, '测试版本', { chooseDirectory: async () => f.output, openDirectory: async () => '' })
    await handlers.get('markdown-export:choose-directory')!(null)
    const result = await handlers.get('markdown-export:start')!(null, { ...f.request, format })
    expect(result).toMatchObject({ ok: true, value: { status: 'created', messageCount: 1 } })
    expect(readdirSync(result.value.directory)).toContain(`聊天.${format}`)
  })
})

describe('格式分发与 Markdown 兼容', () => {
  it.each([null, '', 'PDF', 'JSON', '../json', '__proto__', {}])('拒绝不支持或注入格式 %j', value => {
    expect(() => validateExportFormat(value)).toThrow('INVALID_SELECTION')
  })
  it('默认仍为 Markdown，原 renderer 的字节、选择摘要及投影不变，格式之间摘要隔离', async () => {
    const f = exportFixture(); f.add('消息', '原文\n# 不变')
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, f.request)
    const previous = createMarkdownExport(snapshot, '测试版本'), markdown = createExportFiles(snapshot, '测试版本', 'markdown')
    expect(validateExportFormat(undefined)).toBe('markdown')
    expect(markdown.content).toEqual(previous.markdown); expect(markdown.selectionDigest).toBe(previous.selectionDigest)
    expect(markdown.digestProjection).toEqual(previous.projection)
    const json = createExportFiles(snapshot, '测试版本', 'json'), txt = createExportFiles(snapshot, '测试版本', 'txt')
    expect(new Set([markdown.selectionDigest, json.selectionDigest, txt.selectionDigest]).size).toBe(3)
    expect(createExportFiles(snapshot, '另一应用版本', 'json').selectionDigest).toBe(json.selectionDigest)
    expect(JSON.parse(markdown.manifest.toString()).export_format).toBe('markdown')
  })
  it.skipIf(process.platform !== 'win32')('已有不含新字段的 Markdown 导出仍原位复用，不改写旧文件', async () => {
    const f = exportFixture(); f.add('消息')
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, f.request), legacy = createMarkdownExport(snapshot, '旧版本')
    const first = await exportMarkdown(f.databasePath, f.output, f.request, '当前版本')
    const mdPath = join(first.directory!, '聊天.md'), manifestPath = join(first.directory!, 'export.json')
    writeFileSync(mdPath, legacy.markdown); writeFileSync(manifestPath, legacy.manifest)
    const result = await exportChat(f.databasePath, f.output, f.request, '新版本', { format: 'markdown' })
    expect(result).toMatchObject({ status: 'unchanged', directory: first.directory })
    expect(readFileSync(mdPath)).toEqual(legacy.markdown); expect(readFileSync(manifestPath)).toEqual(legacy.manifest)
  })
})
