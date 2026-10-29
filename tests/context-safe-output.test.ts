import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256 } from '../src/main/export/chat-markdown'
import { publishExportFiles, type PublishExportInput } from '../src/main/export/markdown-export'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'

afterEach(cleanupExportFixtures)

function document(format: 'markdown' | 'json' = 'markdown'): PublishExportInput {
  const projection = { context_identity: '上下文选择', format, message_ids: ['消息'] }
  const content = Buffer.from(format === 'markdown' ? '# AI 上下文\n\n中文 😀\n' : JSON.stringify({ items: [{ id: '消息', content: '中文 😀' }] }) + '\n', 'utf8')
  const filename = format === 'markdown' ? 'AI上下文.md' : 'AI上下文.json'
  const selectionDigest = sha256(canonicalJson(projection))
  const exportFormat = 'context-' + format
  const manifest = Buffer.from(JSON.stringify({ schema_version: 1, export_version: 'context-v1', export_format: exportFormat,
    context_identity: projection.context_identity, projection, selection_digest: selectionDigest,
    output: { path: filename, bytes: content.length, sha256: sha256(content) } }), 'utf8')
  return { identity: projection.context_identity, title: 'AI上下文', messageCount: 1, excludedUnknownTimeCount: 0,
    rendered: { filename, content, manifest, selectionDigest, digestProjection: projection, format: exportFormat, exportVersion: 'context-v1' },
    storedProjection: saved => saved.projection, storedIdentity: saved => saved.context_identity }
}

describe.skipIf(process.platform !== 'win32')('上下文复用原安全输出管线', () => {
  it.each(['markdown', 'json'] as const)('发布 %s 并校验未变化复用，源数据和运行数据库数量不变', async format => {
    const f = exportFixture(); f.add('消息'); f.evidence('消息')
    const state = sourceFingerprint(f.db), input = document(format)
    const result = await publishExportFiles(f.databasePath, f.output, input)
    expect(result).toMatchObject({ status: 'created', messageCount: 1 })
    expect(readdirSync(result.directory!).sort()).toEqual([input.rendered.filename, 'export.json'].sort())
    expect(readFileSync(join(result.directory!, input.rendered.filename))).toEqual(input.rendered.content)
    if (format === 'json') expect(JSON.parse(readFileSync(join(result.directory!, input.rendered.filename), 'utf8')).items[0].content).toBe('中文 😀')
    expect(await publishExportFiles(f.databasePath, f.output, input)).toMatchObject({ status: 'unchanged', directory: result.directory })
    expect(sourceFingerprint(f.db)).toEqual(state)
    expect(readdirSync(f.data).filter(name => name.endsWith('.db'))).toEqual(['private-radar.db'])
  }, 30000)
  it('手动修改文件后创建新版本，不覆盖现有内容', async () => {
    const f = exportFixture(), input = document()
    const first = await publishExportFiles(f.databasePath, f.output, input)
    writeFileSync(join(first.directory!, input.rendered.filename), '用户原稿')
    const next = await publishExportFiles(f.databasePath, f.output, input)
    expect(next).toMatchObject({ status: 'created', directory: first.directory + '--v2' })
    expect(readFileSync(join(first.directory!, input.rendered.filename), 'utf8')).toBe('用户原稿')
  }, 30000)
  it('新渲染器文件名也必须拒绝路径穿越、设备名称及清单同名', async () => {
    const f = exportFixture()
    for (const filename of ['../上下文.md', 'C:\\上下文.md', 'CON.md', 'export.json', '上下文.md.']) {
      const input = document(); input.rendered.filename = filename
      await expect(publishExportFiles(f.databasePath, f.output, input)).rejects.toThrow('EXPORT_PATH_UNSAFE')
    }
    expect(readdirSync(f.output)).toEqual([])
  })
  it('禁止原库目录、相对穿越和远程输出目标', async () => {
    const f = exportFixture()
    for (const directory of [f.data, 'C:\\bad\\..\\escape', '\\\\server\\share']) {
      await expect(publishExportFiles(f.databasePath, directory, document())).rejects.toThrow(/EXPORT_PATH_UNSAFE|本地绝对路径/)
    }
    expect(existsSync(join(f.data, 'PrivateRadar'))).toBe(false)
  })
  it('发布前取消会清理暂存且保留其他文件', async () => {
    const f = exportFixture(), controller = new AbortController()
    writeFileSync(join(f.output, '用户文件.md'), '保留')
    await expect(publishExportFiles(f.databasePath, f.output, document(), { signal: controller.signal,
      beforePublish: async () => controller.abort() })).rejects.toThrow('EXPORT_CANCELLED')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    expect(readFileSync(join(f.output, '用户文件.md'), 'utf8')).toBe('保留')
  }, 30000)
  it('半写失败和目标抢占均不替换用户内容', async () => {
    const f = exportFixture()
    await expect(publishExportFiles(f.databasePath, f.output, document(), {
      writeStagedFile: async (filename, bytes) => { writeFileSync(filename, bytes.subarray(0, 3), { flag: 'wx' }); throw Error('模拟写入失败') }
    })).rejects.toThrow('模拟写入失败')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    let occupied = ''
    const result = await publishExportFiles(f.databasePath, f.output, document(), { beforePublish: async (_stage, destination) => {
      if (!occupied) { occupied = destination; mkdirSync(destination); writeFileSync(join(destination, '用户文件.md'), '保留') }
    } })
    expect(result.directory).toBe(occupied + '--v2')
    expect(readFileSync(join(occupied, '用户文件.md'), 'utf8')).toBe('保留')
  }, 30000)
})
