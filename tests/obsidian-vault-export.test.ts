import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, symlinkSync, linkSync, chmodSync } from 'node:fs'
import { basename, join } from 'node:path'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'
import { exportObsidianVault, VAULT_MANIFEST, type VaultManifest } from '../src/main/export/obsidian-export'
import { validateObsidianVault, VaultWriter } from '../src/main/export/obsidian-vault-writer'
import { groupObsidianDays, obsidianSourceDigest, renderObsidianMarkdown, yamlScalar } from '../src/main/export/obsidian-markdown'
import { buildCanonicalExportSnapshot } from '../src/main/export/chat-selection'
import { safeConversationFilename } from '../src/main/export/markdown-export'
import { sha256 } from '../src/main/export/chat-markdown'

afterEach(cleanupExportFixtures)
function setup() {
  const f = exportFixture()
  const request = { conversation_ids: [f.request.conversation_id], range: f.request.range }
  const manifestPath = join(f.output, 'PrivateRadar', VAULT_MANIFEST)
  const manifest = (): VaultManifest => JSON.parse(readFileSync(manifestPath, 'utf8'))
  const file = () => join(f.output, 'PrivateRadar', manifest().files[0].relative_path)
  const run = (options: Parameters<typeof exportObsidianVault>[3] = {}) => exportObsidianVault(f.databasePath, f.output, request, options)
  return { ...f, request, manifestPath, manifest, file, run }
}
describe('受控标量与现有导出渲染复用', () => {
  it.each(['a: b # 注释', '"双引号"与\'单引号\'', 'C:\\目录\\聊天', '第一行\n第二行\r\n第三行',
    '中文 😀 🧑‍💻', 'null', 'true', 'false', '00123', '1.5', '---\nkey: value', '\u0085\u2028\u2029\u0001'])('字符串始终安全引用：%j', value => {
    const scalar = yamlScalar(value)
    expect(scalar.startsWith('"') && scalar.endsWith('"')).toBe(true)
    expect(JSON.parse(scalar)).toBe(value)
    expect(scalar).not.toMatch(/[\r\n\u0085\u2028\u2029]/)
  })
  it('空值和整数保持真实类型', () => {
    expect(yamlScalar(null)).toBe('null'); expect(yamlScalar(0)).toBe('0')
    expect(() => yamlScalar(-1)).toThrow()
  })
  it.each(['CON', 'PRN.txt', 'AUX', 'NUL', 'COM1', 'LPT9', 'COM¹', '..\\目录/<>:"|?* .'])('复用 Windows 安全文件名：%s', name => {
    expect(safeConversationFilename(name)).not.toMatch(/[<>:"/\\|?*]|[. ]$/)
    expect(safeConversationFilename(name)).not.toMatch(/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i)
  })
  it('捕获的本地日期、未知时间、来源名称、空平台和正文保持原语义', async () => {
    const f = setup()
    f.db.prepare("UPDATE conversations SET platform='',name='来源: #群',user_conversation_label=NULL").run()
    const fence = String.fromCharCode(96).repeat(3)
    const body = '中文 😀\n' + fence + 'js\nconst x = 1\n' + fence + '\n' + '长消息'.repeat(10000)
    f.add('正文', body, '2026-10-01T23:30:00.000Z')
    f.add('未知', '未知时间内容', null)
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, { conversation_id: '导出会话', range: f.request.range })
    const days = groupObsidianDays(snapshot)
    const known = days.find(day => day.date !== null)!
    const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date('2026-10-01T23:30:00.000Z')).map(part => [part.type, part.value]))
    expect(known.date).toBe(fields.year + '-' + fields.month + '-' + fields.day)
    expect(days.at(-1)?.date).toBe(null)
    const md = renderObsidianMarkdown(snapshot, known).toString('utf8')
    expect(md).toContain('source_conversation: "来源: #群"')
    expect(md).toContain('user_conversation_label: null')
    expect(md).toContain('platform: null')
    expect(md).toContain(body)
    expect(md).toContain(String.fromCharCode(96).repeat(4) + 'text\n' + body)
    expect(md).not.toContain('privateradar://')
    const second = await buildCanonicalExportSnapshot(f.databasePath, { conversation_id: '导出会话', range: f.request.range })
    expect(obsidianSourceDigest(snapshot, known)).toBe(obsidianSourceDigest(second, groupObsidianDays(second)[0]))
    expect(obsidianSourceDigest(snapshot, known)).not.toBe(obsidianSourceDigest(snapshot, { ...known, messages: [...known.messages].reverse().concat(known.messages) }))
  })
})
describe.skipIf(process.platform !== 'win32')('Windows 本地 Vault 真实安全文件链', () => {
  it('首次创建、无变化跳过、新消息更新、摘要与实际文件哈希正确', async () => {
    const f = setup(); f.add('消息一')
    const before = sourceFingerprint(f.db)
    expect(await f.run()).toMatchObject({ created: 1, updated: 0, skipped: 0, failed: 0 })
    const first = f.manifest(), file = f.file(), bytes = readFileSync(file)
    expect(first.files[0].file_hash).toBe(sha256(bytes))
    expect(first.files[0].relative_path).toMatch(/\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/)
    expect(first.conversations[0].directory).toMatch(/^用户项目组--[a-f0-9]{16}$/)
    const rawManifest = readFileSync(f.manifestPath, 'utf8')
    expect(rawManifest).not.toContain(f.output); expect(rawManifest).not.toMatch(/[A-Z]:\\/i)
    expect(await f.run()).toMatchObject({ created: 0, updated: 0, skipped: 1, failed: 0 })
    expect(readFileSync(file)).toEqual(bytes)
    expect(readFileSync(f.manifestPath, 'utf8')).toBe(rawManifest)
    expect(sourceFingerprint(f.db)).toEqual(before)
    f.add('消息二', '新增消息', '2026-10-01T01:05:00.000Z', 1)
    expect(await f.run()).toMatchObject({ created: 0, updated: 1, skipped: 0, failed: 0 })
    expect(f.file()).toBe(file)
    expect(readFileSync(file, 'utf8')).toContain('新增消息')
    expect(f.manifest().files[0].file_hash).toBe(sha256(readFileSync(file)))
  }, 30000)
  it('多日期与未知时间拆分，修改旧日消息只更新对应文件', async () => {
    const f = setup(); f.add('旧日'); f.add('新日', '第二天', '2026-10-03T01:00:00.000Z'); f.add('未知', '无可靠时间', null)
    expect(await f.run()).toMatchObject({ created: 3, failed: 0 })
    expect(f.manifest().files.some(file => file.relative_path.endsWith('/unknown-time.md'))).toBe(true)
    f.db.prepare("UPDATE messages SET content='旧日已变更' WHERE id='旧日'").run()
    expect(await f.run()).toMatchObject({ updated: 1, skipped: 2, failed: 0 })
  }, 30000)
  it('手改文件始终保留，新版本被登记，下一次不重复创建', async () => {
    const f = setup(); f.add('消息'); await f.run()
    const original = f.file(), originalPath = f.manifest().files[0].relative_path
    writeFileSync(original, '用户手写内容😀')
    f.add('新增', '源变化', '2026-10-01T01:01:00.000Z')
    expect(await f.run()).toMatchObject({ created: 1, updated: 0, preserved: 1, failed: 0, userModifiedFilePreserved: true })
    expect(readFileSync(original, 'utf8')).toBe('用户手写内容😀')
    expect(f.file()).not.toBe(original)
    expect(f.manifest().files[0].relative_path).toContain('--privateradar-update-')
    expect(f.manifest().files[0].preserved_paths).toContain(originalPath)
    expect(await f.run()).toMatchObject({ skipped: 1, created: 0, preserved: 0, failed: 0 })
  }, 30000)
  it('源未变化而导出文件被手改也不误判为跳过', async () => {
    const f = setup(); f.add('消息'); await f.run()
    const old = f.file(); writeFileSync(old, '手改')
    expect(await f.run()).toMatchObject({ preserved: 1, skipped: 0, failed: 0 })
    expect(readFileSync(old, 'utf8')).toBe('手改')
  }, 30000)
  it('Label 修改通过 manifest 找回原目录，来源名称保留', async () => {
    const f = setup(); f.add('消息'); await f.run()
    const folder = f.manifest().conversations[0].directory
    f.db.prepare("UPDATE conversations SET user_conversation_label='新名称: #组'").run()
    expect(await f.run()).toMatchObject({ updated: 1, failed: 0 })
    expect(f.manifest().conversations[0].directory).toBe(folder)
    expect(readFileSync(f.file(), 'utf8')).toContain('conversation: "新名称: #组"')
    expect(readFileSync(f.file(), 'utf8')).toContain('source_conversation: "来源群"')
  }, 30000)
  it('未知会话回退并生成稳定身份目录', async () => {
    const f = setup(); f.add('消息'); f.db.prepare("UPDATE conversations SET name='',user_conversation_label=NULL").run()
    expect(await f.run()).toMatchObject({ created: 1, failed: 0 })
    expect(f.manifest().conversations[0].directory).toMatch(/^未知会话--/)
  })
  it('同名多会话批量导出不冲突', async () => {
    const f = setup()
    f.db.prepare("INSERT INTO conversations(id,platform,name,created_at,user_conversation_label) VALUES('第二会话','wechat','来源群','2026-10-01','用户项目组')").run()
    f.add('第二消息'); f.db.prepare("UPDATE messages SET conversation_id='第二会话' WHERE id='第二消息'").run(); f.add('第一消息')
    const result = await exportObsidianVault(f.databasePath, f.output, { ...f.request, conversation_ids: ['导出会话', '第二会话'] })
    expect(result).toMatchObject({ conversationCount: 2, created: 2, failed: 0 })
    expect(new Set(f.manifest().conversations.map(item => item.directory)).size).toBe(2)
  })
  it.each(['missing', 'corrupt', 'traversal'] as const)('manifest %s 安全恢复，不覆盖旧 Markdown', async mode => {
    const f = setup(); f.add('消息'); await f.run()
    const original = f.file(), originalBytes = readFileSync(original)
    if (mode === 'missing') unlinkSync(f.manifestPath)
    if (mode === 'corrupt') writeFileSync(f.manifestPath, '{损坏的清单')
    if (mode === 'traversal') {
      const m = f.manifest(); m.files[0].relative_path = '../../越界.md'; writeFileSync(f.manifestPath, JSON.stringify(m))
    }
    const corruptBytes = mode === 'missing' ? null : readFileSync(f.manifestPath)
    expect(await f.run()).toMatchObject({ preserved: 1, created: 1, manifestRecovered: true, failed: 0 })
    expect(readFileSync(original)).toEqual(originalBytes)
    expect(f.file()).not.toBe(original)
    if (corruptBytes) {
      const dir = join(f.output, 'PrivateRadar/.privateradar')
      const backup = readdirSync(dir).find(name => name.startsWith('export-manifest.corrupt-'))!
      expect(readFileSync(join(dir, backup))).toEqual(corruptBytes)
    }
    expect(await f.run()).toMatchObject({ skipped: 1, failed: 0 })
  }, 30000)
  it('未知时间在日期范围内沿用现有排除语义，未选择的日期保持不变', async () => {
    const f = setup(); f.add('消息'); f.add('未知', '未知时间', null); await f.run()
    const known = f.manifest().files.find(item => item.date !== null)!
    const range = { type: 'date_range' as const, start_date: known.date!, end_date: known.date! }
    expect(await exportObsidianVault(f.databasePath, f.output, { ...f.request, range })).toMatchObject({ skipped: 1, failed: 0 })
    expect(f.manifest().files).toHaveLength(2)
  })
  it('目标被删除时安全重建；已无消息的旧日期更新为零条', async () => {
    const f = setup(); f.add('消息'); await f.run()
    unlinkSync(f.file())
    expect(await f.run()).toMatchObject({ created: 1, failed: 0 })
    f.db.prepare("DELETE FROM messages WHERE id='消息'").run()
    expect(await f.run()).toMatchObject({ updated: 1, failed: 0 })
    expect(f.manifest().files[0].message_count).toBe(0)
  }, 30000)
  it('目录、网络、设备、驱动器切换、原数据目录和遍历均被拒绝，无回退目录', async () => {
    const f = setup()
    for (const path of [join(f.root, '不存在'), '\\\\server\\share', '\\\\?\\C:\\vault', 'C:\\vault\\..\\escape',
      'C:\\vault:ads', 'C:\\CON', f.data]) await expect(validateObsidianVault(path, f.databasePath)).rejects.toThrow()
    expect(existsSync(join(f.data, 'PrivateRadar'))).toBe(false)
    const file = join(f.root, '不是目录'); writeFileSync(file, '用户文件')
    await expect(validateObsidianVault(file, f.databasePath)).rejects.toThrow()
  }, 30000)
  it('Junction 和硬链接无法让输出或读取逃逸', async () => {
    const f = setup(); f.add('消息')
    const link = join(f.root, '链接'); symlinkSync(f.output, link, 'junction')
    await expect(validateObsidianVault(link, f.databasePath)).rejects.toThrow()
    await f.run()
    const file = f.file(), outside = join(f.root, '用户文件.md')
    writeFileSync(outside, '不能改'); unlinkSync(file); linkSync(outside, file)
    const result = await f.run()
    expect(result.failed).toBe(1); expect(readFileSync(outside, 'utf8')).toBe('不能改')
  })
  it('真实 Vault 写入锁防跨任务并发，释放后可复用', async () => {
    const f = setup(), writer = await VaultWriter.open(f.output, f.databasePath)
    try { await expect(validateObsidianVault(f.output, f.databasePath)).rejects.toThrow('EXPORT_BUSY') }
    finally { await writer.close() }
    expect(await validateObsidianVault(f.output, f.databasePath)).toBe(f.output)
  }, 30000)
  it('发布前出现的用户文件和更新前的竞态手改均不被覆盖', async () => {
    const f = setup(); f.add('消息')
    let raced = false, occupied = ''
    expect(await f.run({ beforePublish: async (_stage, target) => {
      if (!raced && target.endsWith('.md')) { raced = true; occupied = target; writeFileSync(target, '抢先创建') }
    } })).toMatchObject({ preserved: 1, failed: 0 })
    expect(readFileSync(occupied, 'utf8')).toBe('抢先创建')
    const active = f.file(); f.add('新增', '新内容', '2026-10-01T01:05:00.000Z')
    raced = false
    expect(await f.run({ beforePublish: async (_stage, target) => {
      if (!raced && target === active) { raced = true; writeFileSync(target, '竞态手改') }
    } })).toMatchObject({ preserved: 1, updated: 0, failed: 0 })
    expect(readFileSync(active, 'utf8')).toBe('竞态手改')
  }, 30000)
  it('取消、临时文件半写和发布前截断不留下半成品，原笔记不受影响', async () => {
    const f = setup(); f.add('消息')
    const controller = new AbortController()
    expect(await f.run({ signal: controller.signal, beforePublish: async (_stage, target) => {
      if (target.endsWith('.md')) controller.abort()
    } })).toMatchObject({ status: 'cancelled', created: 0 })
    expect(f.manifest().files).toHaveLength(0)
    const result = await f.run({ writeStagedFile: async (stage, bytes) => {
      if (bytes.toString('utf8').startsWith('---')) { writeFileSync(stage, bytes.subarray(0, 8), { flag: 'wx' }); throw new Error('模拟磁盘写满') }
      writeFileSync(stage, bytes, { flag: 'wx' })
    } })
    expect(result).toMatchObject({ failed: 1, created: 0 })
    expect(f.manifest().files).toHaveLength(0)
    expect(await f.run({ beforePublish: async (stage, target) => { if (target.endsWith('.md')) writeFileSync(stage, '截断') } })).toMatchObject({ failed: 1, created: 0 })
    expect(readdirSync(join(f.output, 'PrivateRadar/.privateradar/staging'))).toEqual([])
  }, 30000)
  it('原库、消息来源、证据和表结构保持不变，不创建第二数据库', async () => {
    const f = setup(); f.add('消息'); f.evidence('消息')
    const before = sourceFingerprint(f.db), schema = f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()
    await f.run()
    expect(sourceFingerprint(f.db)).toEqual(before)
    expect(f.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(schema)
    expect(readdirSync(f.data)).toContain('private-radar.db')
    expect(basename(f.databasePath)).toBe('private-radar.db')
  })
  it('Vault 管理目录不可写时拒绝导出，不回退其他路径', async () => {
    const f = setup(); f.add('消息')
    await validateObsidianVault(f.output, f.databasePath)
    const lock = join(f.output, 'PrivateRadar/.privateradar/export.lock')
    chmodSync(lock, 0o444)
    try { await expect(f.run()).rejects.toThrow('EXPORT_BUSY') }
    finally { chmodSync(lock, 0o666) }
    expect(existsSync(f.manifestPath)).toBe(false)
    expect(await f.run()).toMatchObject({ created: 1, failed: 0 })
  }, 30000)
  it('部分日期完成后取消，已完成文件登记一致，继续导出可跳过并补齐', async () => {
    const f = setup(); f.add('首日'); f.add('次日', '第二天', '2026-10-03T01:00:00.000Z')
    const controller = new AbortController(); let days = 0
    expect(await f.run({ signal: controller.signal, beforePublish: async (_stage, target) => {
      if (target.endsWith('.md') && ++days === 2) controller.abort()
    } })).toMatchObject({ status: 'cancelled', conversationCount: 1, created: 1, failed: 0 })
    expect(f.manifest().files).toHaveLength(1)
    const saved = f.manifest().files[0]
    expect(sha256(readFileSync(join(f.output, 'PrivateRadar', saved.relative_path)))).toBe(saved.file_hash)
    expect(await f.run()).toMatchObject({ status: 'completed', created: 1, skipped: 1, failed: 0 })
    expect(f.manifest().files).toHaveLength(2)
    expect(readdirSync(join(f.output, 'PrivateRadar/.privateradar/staging'))).toEqual([])
  }, 30000)
  it('连续多日期发布和中文 emoji 路径均逐文件核验名称及摘要', async () => {
    const f = setup()
    f.db.prepare("UPDATE conversations SET user_conversation_label='中文😀项目讨论'").run()
    for (let day = 1; day <= 16; day++) f.add('消息-' + day, '正文😀-' + day, '2026-10-' + String(day).padStart(2, '0') + 'T12:00:00.000Z', day)
    expect(await f.run()).toMatchObject({ created: 16, failed: 0 })
    for (const file of f.manifest().files) {
      const target = join(f.output, 'PrivateRadar', file.relative_path)
      expect(existsSync(target)).toBe(true)
      expect(sha256(readFileSync(target))).toBe(file.file_hash)
    }
    expect(await f.run()).toMatchObject({ skipped: 16, created: 0, failed: 0 })
  }, 30000)
})
