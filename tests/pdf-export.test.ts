import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createPdfHtml, createPdfExportFiles, assertPdfBytes, pdfText } from '../src/main/export/chat-pdf'
import { buildCanonicalExportSnapshot } from '../src/main/export/chat-selection'
import { exportChat, exportPdfConversations, registerMarkdownExportIpc } from '../src/main/export/markdown-export'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'

// 仅用于安全发布单元测试；PDF 结构与排版另由真实 Electron 及 PDF 解析器验证。
const stubPdfBytes = () => Buffer.from('%PDF-1.7\n' + '单元测试占位'.repeat(12) + '\n%%EOF\n')
afterEach(cleanupExportFixtures)
describe('PDF 模板与公共快照复用', () => {
  it('动态值统一转义为文本，正文中的脚本、图片、事件和样式无法进入标签', async () => {
    const f = exportFixture()
    const body = '<script>fetch("https://example.invalid/private")</script>\n<img src=x onerror=alert(1)>\n</div><style>@page{size:10000px}</style>\n\'"&'
    f.add('原文', body)
    f.db.prepare('UPDATE conversations SET name=?,user_conversation_label=?').run('<来源群>', '用户 <标签> "😀"')
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, f.request)
    const html = createPdfHtml(snapshot)
    expect(html).toContain('用户 &lt;标签&gt; &quot;😀&quot;')
    expect(html).toContain('&lt;script&gt;fetch(&quot;https://example.invalid/private&quot;)')
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img ')
    expect(html).toContain(pdfText(body))
    expect(pdfText('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(html).toContain("script-src &#39;none&#39;")
    expect(html).not.toContain('@import')
  })
  it('显示名称、来源名称、自定义名称和平台分别保留，不猜空平台', async () => {
    const f = exportFixture(); f.add('消息')
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, f.request), html = createPdfHtml(snapshot)
    expect(html).toContain('<h1>用户项目组</h1>')
    expect(html).toContain('来源会话名称：来源群')
    expect(html).toContain('用户自定义名称：用户项目组')
    expect(html).toContain('来源平台：wechat')
    f.db.prepare("UPDATE conversations SET name='',platform='',user_conversation_label=NULL").run()
    const unknown = createPdfHtml(await buildCanonicalExportSnapshot(f.databasePath, f.request))
    expect(unknown).toContain('<h1>未知会话</h1>')
    expect(unknown).not.toContain('来源平台：')
    expect(unknown).not.toContain('来源会话名称：')
    expect(unknown).not.toContain('用户自定义名称：')
  })
  it('沿用本地日期、时间、姓名、顺序及真实缺失回退，不以导出时间冒充', async () => {
    const f = exportFixture(); f.add('晚', '较晚正文', '2026-10-02T01:00:00.000Z'); f.add('早', '较早正文'); f.add('未知', '无时间正文', null)
    f.db.prepare("UPDATE messages SET sender_name=NULL,sender_name_source='unknown' WHERE id='未知'").run()
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, f.request), html = createPdfHtml(snapshot)
    expect(html.indexOf('较早正文')).toBeLessThan(html.indexOf('较晚正文'))
    expect(html.indexOf('较晚正文')).toBeLessThan(html.indexOf('无时间正文'))
    for (const message of snapshot.messages) {
      expect(html).toContain('<h3>' + (message.local_time ?? '时间未提供') + ' · ' + (message.sender_name ?? '发送人未提供') + '</h3>')
      expect(html).toContain('<h2>' + (message.local_date ?? '时间未提供') + '</h2>')
    }
    expect(html).toContain('<h3>时间未提供 · 发送人未提供</h3>')
    expect(html).toContain('消息时区：' + snapshot.selection.timezone)
  })
  it.each(['中文 😀 e\u0301', 'English 123 45.6', '第一行\n第二行\n  缩进\t内容', '长消息'.repeat(12000),
    String.fromCharCode(96).repeat(3) + 'js\nconst x = "<>&";\n' + String.fromCharCode(96).repeat(3),
    'https://example.invalid/' + 'long-url-'.repeat(1000)])('原文保留换行、缩进、Unicode 及长文本：%#', async body => {
    const f = exportFixture(); f.add('内容', body)
    const html = createPdfHtml(await buildCanonicalExportSnapshot(f.databasePath, f.request))
    expect(html).toContain('<div class="message-body">' + pdfText(body) + '</div>')
    expect(html).toContain('white-space:pre-wrap')
    expect(html).toContain('overflow-wrap:anywhere')
    expect(html).toContain('break-inside:auto')
  })
  it('元数据和摘要按格式隔离，输出不含私有来源路径，取消和错误不伪造 PDF', async () => {
    const f = exportFixture(); f.add('消息'); f.evidence('消息')
    const first = await buildCanonicalExportSnapshot(f.databasePath, f.request)
    const renderer = vi.fn(async () => stubPdfBytes())
    const output = await createPdfExportFiles(first, '测试版本', '会话.pdf', renderer)
    const next = await createPdfExportFiles(await buildCanonicalExportSnapshot(f.databasePath, f.request), '测试版本', '会话.pdf', renderer)
    expect(output.selectionDigest).toBe(next.selectionDigest)
    const metadata = JSON.parse(output.manifest.toString('utf8'))
    expect(metadata).toMatchObject({ export_format: 'pdf', export_version: 'pdf-v1', output: { path: '会话.pdf' } })
    expect(metadata.messages[0]).not.toHaveProperty('content')
    expect(output.manifest.toString()).not.toContain('不得导出原路径')
    await expect(createPdfExportFiles(first, '测试版本', '会话.pdf', async () => Buffer.from('错误内容'))).rejects.toThrow('EXPORT_IO_ERROR')
  })
  it.each([Buffer.alloc(0), Buffer.from('%PDF-1.7\n缺少结尾'), Buffer.from('不是PDF' + 'x'.repeat(80)), null])('拒绝无效打印结果 %#', value => {
    expect(() => assertPdfBytes(value as Buffer)).toThrow('EXPORT_IO_ERROR')
  })
})
describe.skipIf(process.platform !== 'win32')('PDF 复用 Windows 安全输出管线', () => {
  it('单会话、安全文件名、有效结果校验、重复复用及用户修改后无覆盖新版本', async () => {
    const f = exportFixture(); f.add('消息')
    f.db.prepare('UPDATE conversations SET user_conversation_label=?').run('CON<>:"/\\|?* .')
    const state = sourceFingerprint(f.db), renderer = vi.fn(async () => stubPdfBytes())
    const first = await exportChat(f.databasePath, f.output, f.request, '测试版本', { format: 'pdf', renderPdf: renderer })
    const files = readdirSync(first.directory!), filename = files.find(name => name.endsWith('.pdf'))!
    expect(files).toHaveLength(2)
    expect(filename).not.toMatch(/[<>:"/\\|?*]/)
    expect(filename).not.toMatch(/^(CON|PRN|AUX|NUL)(?:\.|$)/i)
    expect(readFileSync(join(first.directory!, filename)).subarray(0, 5).toString()).toBe('%PDF-')
    expect(await exportChat(f.databasePath, f.output, f.request, '测试版本', { format: 'pdf', renderPdf: renderer })).toMatchObject({ status: 'unchanged', directory: first.directory })
    writeFileSync(join(first.directory!, filename), '用户已有 PDF 字节')
    const next = await exportChat(f.databasePath, f.output, f.request, '测试版本', { format: 'pdf', renderPdf: renderer })
    expect(next.directory).toBe(first.directory + '--v2')
    expect(readFileSync(join(first.directory!, filename), 'utf8')).toBe('用户已有 PDF 字节')
    expect(sourceFingerprint(f.db)).toEqual(state)
  }, 30000)
  it('多会话分别生成 PDF，失败数量明确，其他会话仍完成，异常不泄漏正文路径', async () => {
    const f = exportFixture(); f.add('一')
    f.db.prepare("INSERT INTO conversations(id,platform,name,created_at) VALUES('第二会话','local-file','同名会话','合成')").run()
    f.add('二'); f.db.prepare("UPDATE messages SET conversation_id='第二会话' WHERE id='二'").run()
    const request = { ...f.request, format: 'pdf' as const, conversation_ids: ['导出会话', '第二会话'] }
    const renderer = vi.fn(async () => stubPdfBytes())
    const first = await exportPdfConversations(f.databasePath, f.output, request, '测试版本', { renderPdf: renderer })
    expect(first).toMatchObject({ status: 'created', pdf: { requested: 2, succeeded: 2, created: 2, failed: 0, remaining: 0 } })
    expect(readdirSync(first.directory!)).toHaveLength(2)
    const next = await exportPdfConversations(f.databasePath, f.output,
      { ...request, conversation_ids: ['导出会话', '不存在'] }, '测试版本', { renderPdf: renderer })
    expect(next).toMatchObject({ status: 'partial', pdf: { succeeded: 1, unchanged: 1, failed: 1 } })
    expect(next.pdf?.errors[0].code).toBe('CONVERSATION_NOT_FOUND')
    expect(JSON.stringify(next.pdf)).not.toContain(f.databasePath)
  }, 30000)
  it('渲染失败、空范围和缺失渲染能力都有明确结果，未创建半份文件', async () => {
    const f = exportFixture(); f.add('消息')
    const error = await exportPdfConversations(f.databasePath, f.output, { ...f.request, format: 'pdf' }, '测试版本',
      { renderPdf: async () => { throw new Error('私有路径和正文不应透出') } })
    expect(error).toMatchObject({ status: 'failed', pdf: { succeeded: 0, failed: 1 } })
    expect(JSON.stringify(error)).not.toContain('私有路径和正文不应透出')
    expect(readdirSync(f.output)).toEqual([])
    await expect(exportChat(f.databasePath, f.output, f.request, '测试版本', { format: 'pdf' })).rejects.toThrow('EXPORT_UNSUPPORTED')
    const empty = await exportPdfConversations(f.databasePath, f.output, { ...f.request, range: { type: 'date_range', start_date: '2099-01-01', end_date: '2099-01-02' } }, '测试版本', { renderPdf: async () => stubPdfBytes() })
    expect(empty).toMatchObject({ status: 'empty', pdf: { empty: 1, failed: 0, succeeded: 0 } })
  })
  it('取消与暂存半写失败沿用安全清理，保留用户笔记', async () => {
    const f = exportFixture(); f.add('消息'); const note = join(f.output, '原笔记.pdf'); writeFileSync(note, '原文件')
    const controller = new AbortController()
    await expect(exportChat(f.databasePath, f.output, f.request, '测试版本', { format: 'pdf', renderPdf: async () => stubPdfBytes(),
      signal: controller.signal, beforePublish: async () => { controller.abort() } })).rejects.toThrow('EXPORT_CANCELLED')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    await expect(exportChat(f.databasePath, f.output, f.request, '测试版本', { format: 'pdf', renderPdf: async () => stubPdfBytes(),
      writeStagedFile: async (file, bytes) => { writeFileSync(file, bytes.subarray(0, 10), { flag: 'wx' }); throw new Error('模拟磁盘写满') } })).rejects.toThrow('模拟磁盘写满')
    expect(readdirSync(join(f.output, 'PrivateRadar'))).toEqual([])
    expect(readFileSync(note, 'utf8')).toBe('原文件')
  }, 30000)
  it('目标被抢占时创建下一版本，不替换用户目标', async () => {
    const f = exportFixture(); f.add('消息'); let occupied = '', raced = false
    const result = await exportChat(f.databasePath, f.output, f.request, '测试版本', { format: 'pdf', renderPdf: async () => stubPdfBytes(),
      beforePublish: async (_stage, target) => { if (!raced) { raced = true; occupied = target; mkdirSync(target); writeFileSync(join(target, '用户文件.pdf'), '保留') } } })
    expect(result.directory).toBe(occupied + '--v2')
    expect(readFileSync(join(occupied, '用户文件.pdf'), 'utf8')).toBe('保留')
  })
  it('本地输出、来源库隔离和路径穿越防护仍生效', async () => {
    const f = exportFixture(); f.add('消息')
    for (const path of [f.data, 'C:\\bad\\..\\escape', '\\\\server\\share', 'C:\\bad:ads']) {
      await expect(exportChat(f.databasePath, path, f.request, '测试版本', { format: 'pdf', renderPdf: async () => stubPdfBytes() })).rejects.toThrow()
    }
    expect(existsSync(join(f.data, 'PrivateRadar'))).toBe(false)
  }, 30000)
  it('输出目录不可写时失败，单一原库及消息、证据和表结构不变', async () => {
    const f = exportFixture(); f.add('消息'); f.evidence('消息')
    const state = sourceFingerprint(f.db), schema = f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    // 真实只读目标文件使目录创建失败，不调整真实 ACL 或安全设置。
    const blocked = join(f.output, 'PrivateRadar'); writeFileSync(blocked, '保留原文件'); chmodSync(blocked, 0o444)
    try {
      await expect(exportChat(f.databasePath, f.output, f.request, '测试版本', { format: 'pdf', renderPdf: async () => stubPdfBytes() })).rejects.toThrow()
    } finally { chmodSync(blocked, 0o666) }
    expect(readFileSync(blocked, 'utf8')).toBe('保留原文件')
    expect(sourceFingerprint(f.db)).toEqual(state)
    expect(f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(schema)
    expect(readdirSync(f.data).filter(name => name.endsWith('.db'))).toEqual(['private-radar.db'])
  })
  it('桌面入口复用目录选择、单任务取消和批量请求，路径参数不由界面提供', async () => {
    const f = exportFixture(); f.add('消息')
    const handlers = new Map<string, (event: unknown, ...args: any[]) => any>()
    const renderer = vi.fn(async () => stubPdfBytes())
    registerMarkdownExportIpc({ handle: (name, fn) => handlers.set(name, fn) }, f.db, f.databasePath, '测试版本',
      { chooseDirectory: async () => f.output, openDirectory: async () => '', renderPdf: renderer })
    await handlers.get('markdown-export:choose-directory')!(null)
    const start = handlers.get('markdown-export:start')!
    const request = { ...f.request, format: 'pdf', conversation_ids: ['导出会话'] }
    const first = start(null, request)
    expect(await start(null, request)).toMatchObject({ ok: false, error: { code: 'EXPORT_BUSY' } })
    await handlers.get('markdown-export:cancel')!(null)
    expect(await first).toMatchObject({ ok: true, value: { status: 'cancelled', pdf: { remaining: 1 } } })
    const completed = await start(null, { ...request, directory: 'C:\\不应使用', databasePath: 'C:\\不应使用.db' })
    expect(completed).toMatchObject({ ok: true, value: { pdf: { succeeded: 1, failed: 0 } } })
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }, 30000)
  it('批量完成第一个会话后取消，已完成结果保留且剩余数量准确', async () => {
    const f = exportFixture(); f.add('一')
    f.db.prepare("INSERT INTO conversations(id,platform,name,created_at) VALUES('第二会话','local-file','第二会话','合成')").run()
    f.add('二'); f.db.prepare("UPDATE messages SET conversation_id='第二会话' WHERE id='二'").run()
    const state = sourceFingerprint(f.db), controller = new AbortController(); let calls = 0
    const result = await exportPdfConversations(f.databasePath, f.output,
      { ...f.request, conversation_ids: ['导出会话', '第二会话'], format: 'pdf' }, '测试版本', {
        signal: controller.signal, renderPdf: async () => { if (++calls === 2) controller.abort(); return stubPdfBytes() }
      })
    expect(result).toMatchObject({ status: 'cancelled', pdf: { requested: 2, succeeded: 1, created: 1, failed: 0, remaining: 1 } })
    expect(readdirSync(result.directory!)).toHaveLength(1)
    expect(sourceFingerprint(f.db)).toEqual(state)
  }, 30000)
  it.each([[], ['导出会话', '导出会话'], ['另一会话'], ['导出会话', 1], Array(51).fill('导出会话')].map(ids => ({ ids })))('拒绝无效批量选择 %#', async ({ ids }) => {
    const f = exportFixture()
    await expect(exportPdfConversations(f.databasePath, f.output, { ...f.request, conversation_ids: ids as string[] }, '测试版本',
      { renderPdf: async () => stubPdfBytes() })).rejects.toThrow('INVALID_SELECTION')
  })
})
