import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCanonicalExportSnapshot } from '../src/main/export/chat-selection'
import { createMarkdownExport, renderMessageBody, sha256 } from '../src/main/export/chat-markdown'
import { exportMarkdown, safeConversationFilename } from '../src/main/export/markdown-export'
import { setConversationLabel } from '../src/main/conversation-labels'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'

afterEach(cleanupExportFixtures)
describe('Markdown 原文、名称和元数据', () => {
  it.each(['中文 👩🏽‍💻 e\u0301', '# 标题\n---\n- 列表\r\n![图片](x)\n<script>原文</script>\n```text\n````', 'https://example.invalid/a?q=1&b=2#段落', '', '  \n\t  ', '长消息中文🙂\n'.repeat(7000)].map((body, index) => [index, body] as const))('原文完整保留：用例 %i', async (_index, body) => {
    const f = exportFixture(); f.add('正文消息', body)
    const result = createMarkdownExport(await buildCanonicalExportSnapshot(f.databasePath, f.request), '0.2.0-alpha.24')
    expect(result.markdown.toString('utf8')).toContain(body)
    const manifest = JSON.parse(result.manifest.toString('utf8'))
    expect(manifest.messages[0]).toMatchObject({ content_sha256: sha256(body), content_bytes: Buffer.byteLength(body, 'utf8') })
    expect(manifest.messages[0]).not.toHaveProperty('content')
    expect(manifest.markdown).toEqual({ path: '聊天.md', bytes: result.markdown.length, sha256: sha256(result.markdown) })
    expect(result.markdown.toString()).not.toContain('\uFFFD')
  })
  it('动态围栏避免原文关闭围栏，长反引号消息不触发参数上限', () => {
    expect(renderMessageBody('```\n````\n# 原文')).toMatch(/^`````text\n/)
    expect(renderMessageBody('` '.repeat(100000))).toContain('` '.repeat(100000))
  })
  it.each([['来源群', '用户标签', '用户标签'], ['来源群', null, '来源群'], ['', null, '未知会话']])('标题遵循名称三层语义 %s / %s', async (source, user, display) => {
    const f = exportFixture(); f.add('消息')
    f.db.prepare('UPDATE conversations SET name=?,user_conversation_label=?').run(source, user)
    const before = sourceFingerprint(f.db)
    const result = createMarkdownExport(await buildCanonicalExportSnapshot(f.databasePath, f.request), '测试版本')
    const metadata = JSON.parse(result.manifest.toString())
    expect(result.markdown.toString()).toMatch(new RegExp('^# ' + display))
    expect(metadata.conversation).toMatchObject({ sourceConversationName: source || null, userConversationLabel: user, displayConversationName: display })
    expect(sourceFingerprint(f.db)).toEqual(before)
  })
  it('消息时间稳定、未知时间放在末尾，来源及附件只保留登记事实', async () => {
    const f = exportFixture(); f.add('晚消息', '较晚正文', '2026-10-02T00:00:00.000Z'); f.add('早消息', '较早正文'); f.add('无时间', '未知时间正文', null)
    f.evidence('早消息')
    f.db.prepare("UPDATE messages SET message_type='image',attachments_json=? WHERE id='无时间'").run(JSON.stringify([{ type: 'image', path: 'C:\\私有附件.png' }]))
    const output = createMarkdownExport(await buildCanonicalExportSnapshot(f.databasePath, f.request), '测试版本')
    const text = output.markdown.toString(), metadata = JSON.parse(output.manifest.toString())
    expect(text.indexOf('较早正文')).toBeLessThan(text.indexOf('较晚正文'))
    expect(text.indexOf('较晚正文')).toBeLessThan(text.indexOf('未知时间正文'))
    expect(text).toContain('## 时间未提供'); expect(text).toContain('图片（未复制')
    expect(metadata.evidence.occurrences).toHaveLength(1)
    expect(metadata.evidence).toMatchObject({ verification: 'not_performed', is_evidence_backup: false })
    expect(output.manifest.toString()).not.toMatch(/不得导出原路径|私有附件|raw_metadata|messages_fts/)
  })
})

describe('安全文件名', () => {
  it.each(['..\\..\\test', 'CON', 'con.txt', 'LPT¹', 'a/b:c*d?e', '', '. . ', '👩🏽‍💻'.repeat(100), '标\u202e题', '中文'.repeat(200)])('安全处理 %s', name => {
    const result = safeConversationFilename(name)
    expect(result).not.toMatch(/[<>:"/\\|?*\u0000-\u001f\u202a-\u202e]/)
    expect(result).not.toMatch(/^[. ]|[. ]$/)
    expect(result).not.toMatch(/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i)
    expect(result.length).toBeGreaterThan(0); expect(result.length).toBeLessThanOrEqual(60)
  })
})

describe.skipIf(process.platform !== 'win32')('Windows 真实文件系统发布与保护', () => {
  it('单会话完整发布、清单一致，源库字节、消息、Evidence、FTS 和运行数据库数量不变', async () => {
    const f = exportFixture(); f.add('消息'); f.evidence('消息')
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const bytes = readFileSync(f.databasePath), before = sourceFingerprint(f.db)
    const result = await exportMarkdown(f.databasePath, f.output, f.request, '测试版本')
    expect(result.status).toBe('created')
    expect(readdirSync(result.directory!).sort()).toEqual(['export.json', '聊天.md'])
    const markdown = readFileSync(join(result.directory!, '聊天.md')), metadata = JSON.parse(readFileSync(join(result.directory!, 'export.json'), 'utf8'))
    expect(metadata.markdown).toMatchObject({ bytes: markdown.length, sha256: sha256(markdown) })
    expect(metadata.selection.message_count).toBe(1)
    expect(readFileSync(f.databasePath)).toEqual(bytes); expect(sourceFingerprint(f.db)).toEqual(before)
    expect(readdirSync(f.data).filter(name => name.endsWith('.db'))).toEqual(['private-radar.db'])
  })
  it('重复完整导出跳过；用户改写 Markdown 后创建 v2 并保留原文件', async () => {
    const f = exportFixture(); f.add('消息')
    const first = await exportMarkdown(f.databasePath, f.output, f.request, '初始版本')
    expect((await exportMarkdown(f.databasePath, f.output, f.request, '其他版本')).status).toBe('unchanged')
    const path = join(first.directory!, '聊天.md'); writeFileSync(path, '用户自己修改的 Markdown')
    const next = await exportMarkdown(f.databasePath, f.output, f.request, '测试版本')
    expect(next.status).toBe('created'); expect(next.directory).toBe(first.directory + '--v2')
    expect(readFileSync(path, 'utf8')).toBe('用户自己修改的 Markdown')
  })
  it('缺失或损坏元数据保留旧文件；同名跨会话及修改标签不混淆身份', async () => {
    const f = exportFixture(); f.add('消息')
    const first = await exportMarkdown(f.databasePath, f.output, f.request, '测试版本')
    writeFileSync(join(first.directory!, 'export.json'), '{损坏')
    const second = await exportMarkdown(f.databasePath, f.output, f.request, '测试版本')
    expect(second.directory).toBe(first.directory + '--v2')
    f.db.prepare("INSERT INTO conversations(id,platform,name,created_at,user_conversation_label) VALUES('另一会话','wechat','来源群','合成','用户项目组')").run()
    f.db.prepare("UPDATE messages SET conversation_id='另一会话'").run()
    const other = await exportMarkdown(f.databasePath, f.output, { ...f.request, conversation_id: '另一会话' }, '测试版本')
    expect(other.directory).not.toBe(second.directory)
    expect(readFileSync(join(first.directory!, 'export.json'), 'utf8')).toBe('{损坏')
    setConversationLabel(f.db, '另一会话', null)
    const cleared = await exportMarkdown(f.databasePath, f.output, { ...f.request, conversation_id: '另一会话' }, '测试版本')
    expect(basename(cleared.directory!)).toMatch(/^来源群--/)
  })
  it.each([false, true])('发布目标被抢占时不可替换，目录含用户内容 %s 仍保留并转到新版本', async containsFile => {
    const f = exportFixture(); f.add('消息')
    let race = true, firstTarget = ''
    const result = await exportMarkdown(f.databasePath, f.output, f.request, '测试版本', { beforePublish: async (_stage, destination) => {
      if (race) { race = false; firstTarget = destination; mkdirSync(destination); if (containsFile) writeFileSync(join(destination, '用户文件.md'), '不能覆盖') }
    } })
    expect(result.directory).toBe(firstTarget + '--v2')
    if (containsFile) expect(readFileSync(join(firstTarget, '用户文件.md'), 'utf8')).toBe('不能覆盖')
    else expect(readdirSync(firstTarget)).toEqual([])
  })
  it('写入后中断和取消清理自有 staging，不产生半份最终导出', async () => {
    const f = exportFixture(); f.add('消息')
    await expect(exportMarkdown(f.databasePath, f.output, f.request, '测试版本', { beforePublish: async () => { throw new Error('模拟写入中断') } })).rejects.toThrow('模拟写入中断')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    const controller = new AbortController()
    await expect(exportMarkdown(f.databasePath, f.output, f.request, '测试版本', { signal: controller.signal, beforePublish: async () => { controller.abort() } })).rejects.toThrow('EXPORT_CANCELLED')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
  })
  it('第二个文件写入一半失败、发布前内容被截断，均不留下最终损坏文件或破坏原笔记', async () => {
    const f = exportFixture(); f.add('消息')
    const note = join(f.output, '原笔记.md'); writeFileSync(note, '用户原有内容')
    await expect(exportMarkdown(f.databasePath, f.output, f.request, '测试版本', { writeStagedFile: async (file, bytes) => {
      writeFileSync(file, basename(file) === 'export.json' ? bytes.subarray(0, 12) : bytes, { flag: 'wx' })
      if (basename(file) === 'export.json') throw new Error('模拟磁盘写满')
    } })).rejects.toThrow('模拟磁盘写满')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    await expect(exportMarkdown(f.databasePath, f.output, f.request, '测试版本', { beforePublish: async stage => { writeFileSync(join(stage, '聊天.md'), '被截断') } })).rejects.toThrow('EXPORT_IO_ERROR')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    expect(readFileSync(note, 'utf8')).toBe('用户原有内容')
  })
  it('空范围无正式文件，数据目录、网络路径、越界和链接目录被拒绝', async () => {
    const f = exportFixture(); f.add('消息')
    const empty = await exportMarkdown(f.databasePath, f.output, { ...f.request, range: { type: 'date_range', start_date: '2099-01-01', end_date: '2099-01-01' } }, '测试版本')
    expect(empty.status).toBe('empty'); expect(readdirSync(f.output)).toEqual([])
    await expect(exportMarkdown(f.databasePath, f.data, f.request, '测试版本')).rejects.toThrow('EXPORT_PATH_UNSAFE')
    for (const bad of ['\\\\server\\share', 'C:\\test\\..\\escape', 'C:\\test:ads']) await expect(exportMarkdown(f.databasePath, bad, f.request, '测试版本')).rejects.toThrow()
    const redirected = join(f.root, 'redirected'); symlinkSync(f.output, redirected, 'junction')
    await expect(exportMarkdown(f.databasePath, redirected, f.request, '测试版本')).rejects.toThrow()
    expect(readdirSync(f.output)).toEqual([])
  })
})
