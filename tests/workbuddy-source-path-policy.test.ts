import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs/promises'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep, win32 } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'
import { assertWorkBuddyCanonicalStructure, classifyWorkBuddyPathMismatch, diagnoseWorkBuddyPathMismatch, normalizeWorkBuddyFinalPathDisplay,
  resolveTrustedWorkBuddyRoot, workBuddySourcePathPolicy, type TrustedWorkBuddyRoot } from '../src/main/integrations/workbuddy/source-path-policy'
import { WindowsPathLease } from '../src/main/batch-import/windows-path-lease'
import * as directoryEvidence from '../src/main/batch-import/directory-evidence'
import { workBuddyBatchResultSchema } from '../src/main/integrations/workbuddy/validation'
import { verifyBatchEvidence } from '../src/main/batch-import/evidence'
import * as radar from '../src/main/keyword-radar/recovery'
import * as commitment from '../src/main/commitment/recovery'

const currentHome = vi.hoisted(() => ({ value: '' }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/main/batch-import/directory-evidence', async original => ({ ...await original<typeof directoryEvidence>() }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => currentHome.value }))
vi.mock('../src/main/keyword-radar/recovery', async original => ({ ...await original<typeof radar>() }))
vi.mock('../src/main/commitment/recovery', async original => ({ ...await original<typeof commitment>() }))

const userHome = 'C:\\Users\\TestUser'
const app = win32.join(userHome, '.workbuddy', 'app')
const legacy = win32.join(app, 'tmp', 'chat-history')
const users = win32.join(app, 'users')

describe('新旧 WorkBuddy 来源根的纯路径规则', () => {
  it.each(['测试用户', '刘汉', '用户é', '用户e\u0301'])('合法 Unicode 主目录不依赖 ASCII：%s', user => {
    const home = win32.join('C:\\Users', user)
    for (const suffix of ['tmp\\chat-history', 'users\\synthetic-user\\wechat-chat-history']) {
      const root = win32.join(home, '.workbuddy', 'app', suffix)
      expect(workBuddySourcePathPolicy(win32.join(root, 'wch-test'), home).root).toBe(root)
    }
  })
  it.each([
    [win32.join(legacy, 'wch-abc'), legacy],
    [win32.join(legacy, 'wch-abc', 'nested', 'file'), legacy],
    [win32.join(users, 'abc123', 'wechat-chat-history', 'wch-001'), win32.join(users, 'abc123', 'wechat-chat-history')],
    [win32.join(users, 'd2a535ca123456', 'wechat-chat-history', 'wch-002'), win32.join(users, 'd2a535ca123456', 'wechat-chat-history')],
    [win32.join(users, 'abc123', 'wechat-chat-history', 'wch-xyz'), win32.join(users, 'abc123', 'wechat-chat-history')],
    [win32.join(users, '中文 用户', 'wechat-chat-history', 'wch-附件', 'nested') + '\\', win32.join(users, '中文 用户', 'wechat-chat-history')],
    [win32.join(users, 'abc123', 'wechat-chat-history', 'wch-001').replaceAll('\\', '/'), win32.join(users, 'abc123', 'wechat-chat-history')],
    ['c:' + win32.join(legacy, 'wch-abc').slice(2), legacy]
  ])('仅选择明确来源对应的根：%s', (source, root) => {
    const policy = workBuddySourcePathPolicy(source, userHome)
    expect(policy.root).toBe(root)
    expect(policy.logicalRoot).toBe(win32.join(userHome, '.workbuddy'))
  })

  it.each([
    legacy, users, win32.join(users, 'abc123', 'wechat-chat-history'),
    win32.join(app, 'tmp', 'chat-history-evil', 'wch'),
    legacy + '\\..\\other',
    win32.join(users, 'abc123', 'other-folder', 'wch'),
    win32.join(users, 'abc123', 'wechat-chat-history-evil', 'wch'),
    win32.join(users, 'abc123', 'wechat-chat-history') + '\\..\\..\\other',
    users + '\\..\\tmp\\chat-history\\wch',
    users + '\\.\\wechat-chat-history\\wch',
    users + '\\\\wechat-chat-history\\wch',
    users + '\\abc123\\.\\wechat-chat-history\\wch',
    win32.join(users, 'abc123', 'nested', 'wechat-chat-history', 'wch'),
    win32.join(users, 'abc123.', 'wechat-chat-history', 'wch'),
    win32.join(users, 'abc123 ', 'wechat-chat-history', 'wch'),
    win32.join(users, 'nul', 'wechat-chat-history', 'wch'),
    win32.join(users, 'abc:stream', 'wechat-chat-history', 'wch'),
    'C:\\Temp\\wechat-chat-history\\wch',
    'C:\\Users\\AnotherUser\\.workbuddy\\app\\users\\abc123\\wechat-chat-history\\wch',
    'C:\\OtherLocation\\wechat-chat-history\\wch',
    '\\\\server\\share\\.workbuddy\\app\\users\\abc123\\wechat-chat-history\\wch',
    '\\\\?\\C:\\Users\\TestUser\\.workbuddy\\app\\users\\abc123\\wechat-chat-history\\wch',
    'C:relative', 'relative/path',
    'F:\\Somewhere\\wch-test', 'D:\\WorkBuddyData\\.workbuddy\\app\\users\\synthetic\\wechat-chat-history\\wch-test',
    win32.join(userHome, '.workbuddy-evil', 'app', 'users', 'synthetic', 'wechat-chat-history', 'wch-test'),
    win32.join(users, 'synthetic', 'wechat-chat-history', 'wch-'),
    win32.join(users, 'synthetic', 'wechat-chat-history', 'other-folder')
  ])('拒绝越界、前缀碰撞或非法用户组件：%s', source => {
    expect(() => workBuddySourcePathPolicy(source, userHome)).toThrow()
  })
})

describe('拒绝原因诊断不会把表示差异当作重解析证据', () => {
  it.each([
    ['C:\\Users\\测试用户\\附件', '\\\\?\\C:/Users/测试用户/附件/', 'FINAL_PATH_REPRESENTATION_MISMATCH'],
    ['C:\\Users\\用户\\附件', 'c:\\Users\\用户\\附件', 'CASE_ALIAS_MISMATCH'],
    ['C:\\Users\\用户é\\附件', 'C:\\Users\\用户e\u0301\\附件', 'UNICODE_NORMALIZATION_MISMATCH'],
    ['C:\\Users\\刘汉\\附件', 'F:\\合成数据\\附件', 'FINAL_PATH_MISMATCH'],
    ['C:\\SYNTH~1\\附件', 'C:\\合成长名\\附件', 'FINAL_PATH_MISMATCH']
  ] as const)('分别识别表示、大小写、规范化和真实路径差异：%s', (expected, actual, code) => {
    expect(classifyWorkBuddyPathMismatch(expected, actual)).toBe(code)
  })

  it('显示归一化保留跨盘差异，不把 UNC 或设备空间转换为允许的 DOS 来源', () => {
    expect(normalizeWorkBuddyFinalPathDisplay('\\\\?\\F:\\合成数据\\附件\\')).toBe('F:\\合成数据\\附件')
    expect(normalizeWorkBuddyFinalPathDisplay('\\\\?\\UNC\\server\\share')).toBe('\\\\?\\UNC\\server\\share')
    expect(() => workBuddySourcePathPolicy('\\\\?\\C:\\Users\\TestUser\\附件', userHome)).toThrow(/ROOT_COMPONENT_INVALID/)
  })

  it('非法组件和目录穿越具有不同错误码', () => {
    expect(() => workBuddySourcePathPolicy(users + '\\..\\tmp\\chat-history\\wch', userHome)).toThrow(/PATH_TRAVERSAL_DETECTED/)
    expect(() => workBuddySourcePathPolicy(win32.join(users, 'nul', 'wechat-chat-history', 'wch-test'), userHome)).toThrow(/INVALID_USER_ID/)
  })
})

const fixtures: Array<{ directory: string; parent: string; db: DatabaseSync }> = []
const extraDirectories: Array<{ directory: string; parent: string }> = []
function removeOwnedDirectory(directory: string, parent: string) {
  const absolute = resolve(directory)
  if (dirname(absolute) !== resolve(parent) || !basename(absolute).startsWith('privateradar-path-')) throw new Error('隔离目录清理目标越界')
  rmSync(absolute, { recursive: true, force: true })
}
afterEach(async () => {
  // 让现有提交后派生队列完成，再关闭本测试拥有的隔离数据库。
  for (let index = 0; index < 20; index++) await new Promise<void>(done => setImmediate(done))
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    f.db.close()
    removeOwnedDirectory(f.directory, f.parent)
  }
  for (const extra of extraDirectories.splice(0)) removeOwnedDirectory(extra.directory, extra.parent)
})

function fixture(username = 'user', parent = tmpdir()) {
  const directory = mkdtempSync(join(parent, 'privateradar-path-policy-'))
  const home = join(directory, username)
  // 跨盘用例只把逻辑来源放在 C 盘；证据与数据库仍放在本测试拥有的可读写临时目录。
  let storage = directory
  if (resolve(parent) !== resolve(tmpdir())) {
    storage = mkdtempSync(join(tmpdir(), 'privateradar-path-storage-'))
    extraDirectories.push({ directory: storage, parent: tmpdir() })
  }
  const data = join(storage, 'data')
  mkdirSync(data)
  const databasePath = join(data, 'private-radar.db'), db = new DatabaseSync(databasePath)
  fixtures.push({ directory, parent, db })
  initializeDatabase(db)
  currentHome.value = home
  const app = join(home, '.workbuddy', 'app')
  const roots = { legacy: join(app, 'tmp', 'chat-history'), newer: join(app, 'users', 'synthetic-user', 'wechat-chat-history') }
  function card(root: string, label = '甲', directoryName = `wch-合成附件${label}`) {
    const extracted_dir_path = join(root, directoryName)
    mkdirSync(extracted_dir_path, { recursive: true })
    // 附件文本故意不能解析，证明正文始终来自本次内联上下文。
    writeFileSync(join(extracted_dir_path, '虚构证据.txt'), `虚构附件材料${label}`)
    const transcript = `·虚构发送人${label}\n2026年10月25日 10:00\nMAC_PR_PATH_${label}\n\n·虚构发送人乙\n2026年10月25日 10:01\n我会整理测试文件\n`
    return { extracted_dir_path, file: `虚构附件${label}.zip`, message_count: 2, transcript }
  }
  return { directory, home, app, roots, data, databasePath, db, card }
}
type Fixture = ReturnType<typeof fixture>
function migrateRoot(f: Fixture, physical = join(f.directory, 'WorkBuddy', 'Data', '.workbuddy')) {
  mkdirSync(f.home, { recursive: true })
  mkdirSync(physical, { recursive: true })
  symlinkSync(physical, join(f.home, '.workbuddy'), 'junction')
  return physical
}
function assertZeroWrite(f: Fixture, before: number) {
  expect(f.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
  for (const table of ['messages', 'messages_fts', 'batch_import_sessions', 'batch_import_items', 'import_jobs',
    'batch_item_message_sources', 'commitment_extractor_runs', 'commitment_candidates']) {
    expect(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0)
  }
  expect(existsSync(join(f.data, 'evidence'))).toBe(false)
}
async function call(f: Fixture, contexts: Array<ReturnType<Fixture['card']>>, collectionId?: string) {
  // 不传测试根，覆盖正式入口使用当前主目录自动选择新旧布局的行为。
  const server = createWorkBuddyMcpServer(f.db, undefined, { databasePath: f.databasePath })
  const client = new Client({ name: 'synthetic-path-policy', version: '0.1.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b); await client.connect(a)
  try {
    return await client.callTool({ name: 'privateradar_ingest_current_context_batch', arguments: {
      mode: 'current_context', contexts, ...(collectionId ? { collection_id: collectionId } : {})
    } })
  } finally { await client.close(); await server.close() }
}

describe.skipIf(process.platform !== 'win32')('正式 MCP 工具的新旧目录及零写入边界', () => {
  it.each([
    ['测试用户', 'legacy'], ['测试用户', 'newer'], ['刘汉', 'newer'],
    ['用户é', 'newer'], ['用户e\u0301', 'newer'], ['合法盘符表示', 'newer']
  ] as const)('%s 的 %s 布局使用真实文件系统与原生安全后端通过', async (username, layout) => {
    const f = fixture(username), card = f.card(f.roots[layout])
    if (username === '合法盘符表示') card.extracted_dir_path = card.extracted_dir_path[0].toLowerCase() + card.extracted_dir_path.slice(1)
    const response = await call(f, [card])
    expect(response.isError).not.toBe(true)
    const result = workBuddyBatchResultSchema.parse(response.structuredContent)
    expect(result).toMatchObject({ status: 'success', summary: { imported_total: 2 } })
    expect((await verifyBatchEvidence(f.db, f.databasePath, result.items[0].item_id)).status).toBe('available')
    expect(f.db.prepare('SELECT source_hint FROM batch_import_items WHERE id=?').get(result.items[0].item_id)!.source_hint)
      .toBe(card.extracted_dir_path)
  }, 30000)

  it('元数据拒绝访问时保留最终路径差异和不确定性，不宣称已发现链接', async () => {
    const f = fixture(), card = f.card(f.roots.newer)
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(Object.assign(new Error('合成拒绝访问'), { code: 'EPERM' }))
    const error = await diagnoseWorkBuddyPathMismatch(card.extracted_dir_path, 'F:\\合成数据\\附件', f.home, card.extracted_dir_path)
    expect(error.code).toBe('FINAL_PATH_MISMATCH')
    expect(error.message).toContain('PATH_ACCESS_DENIED')
    expect(error.message).not.toContain(card.extracted_dir_path)
    expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n).toBe(0)
  })

  it('可读普通组件仍不足以把最终路径差异认定为链接或 8.3 别名', async () => {
    const f = fixture(), card = f.card(f.roots.newer)
    const error = await diagnoseWorkBuddyPathMismatch(card.extracted_dir_path, 'F:\\合成数据\\附件', f.home, card.extracted_dir_path)
    expect(error.code).toBe('FINAL_PATH_MISMATCH')
    expect(error.message).toContain('未从可读组件确认链接')
  })

  it('模拟最终路径返回真正规范化等价的另一名称时仍拒绝并保持零写入', async () => {
    const f = fixture(), card = f.card(f.roots.newer, 'e\u0301')
    const original = fs.realpath
    vi.spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
      const result = await original(...args)
      return typeof result === 'string' && String(args[0]) === card.extracted_dir_path ? result.normalize('NFC') : result
    }) as typeof fs.realpath)
    const before = f.db.prepare('SELECT total_changes() AS n').get()!.n
    const response = await call(f, [card])
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain('UNICODE_NORMALIZATION_MISMATCH')
    expect(f.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
    expect(existsSync(join(f.data, 'evidence'))).toBe(false)
  }, 30000)
  it.each(['legacy', 'newer'] as const)('%s 单卡保持真实来源、目录证据、来源关系和全文索引', async layout => {
    const f = fixture(), card = f.card(f.roots[layout])
    // 新路径用例不创建旧根，避免对旧目录存在性的隐含依赖。
    const response = await call(f, [card])
    expect(response.isError).not.toBe(true)
    const result = workBuddyBatchResultSchema.parse(response.structuredContent)
    expect(result).toMatchObject({ status: 'success', summary: { attachments_total: 1, imported_total: 2 } })
    const item = result.items[0], path = join(f.data, 'evidence', item.item_id)
    expect(f.db.prepare('SELECT source_hint,evidence_source_kind FROM batch_import_items WHERE id=?').get(item.item_id))
      .toEqual({ source_hint: card.extracted_dir_path, evidence_source_kind: 'directory' })
    const snapshot = JSON.parse(readFileSync(join(path, 'messages.json'), 'utf8')).input
    expect(snapshot.current_context.extracted_dir_path).toBe(card.extracted_dir_path)
    expect(snapshot.current_context.transcript).toBe(card.transcript)
    expect(readFileSync(join(path, 'source', '虚构证据.txt'), 'utf8')).toBe('虚构附件材料甲')
    expect(f.db.prepare('SELECT source_position FROM batch_item_message_sources ORDER BY source_position').all())
      .toEqual([{ source_position: 0 }, { source_position: 1 }])
    expect(f.db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'MAC_PR_PATH'").get()!.n).toBe(1)
    expect((await verifyBatchEvidence(f.db, f.databasePath, item.item_id)).status).toBe('available')
  }, 30000)

  it('新版双卡分别保存独立证据和来源，支持两个动态用户目录', async () => {
    const f = fixture()
    const cards = [f.card(f.roots.newer), f.card(join(f.app, 'users', 'another-synthetic-user', 'wechat-chat-history'), '乙')]
    const response = await call(f, cards)
    expect(response.isError).not.toBe(true)
    const result = workBuddyBatchResultSchema.parse(response.structuredContent)
    expect(result).toMatchObject({ status: 'success', summary: { attachments_total: 2, imported_total: 4, failed_attachments: 0 } })
    expect(new Set(result.items.map(item => item.source_batch_id)).size).toBe(2)
    for (const [index, item] of result.items.entries()) {
      expect((await verifyBatchEvidence(f.db, f.databasePath, item.item_id)).status).toBe('available')
      expect(f.db.prepare('SELECT source_hint FROM batch_import_items WHERE id=?').get(item.item_id)!.source_hint).toBe(cards[index].extracted_dir_path)
    }
  }, 30000)

  it.each(['其他目录', '前缀碰撞', '父级逃逸', '其他主目录', '不存在', '根自身', '大小写别名',
    'app链接', 'users链接', '用户链接', '历史根链接', '附件链接', '附件祖先链接'])(
    '%s 在创建批次前拒绝，全部数据库写入和证据均为零', async kind => {
      const f = fixture(), good = f.card(f.roots.newer)
      let candidate = good.extracted_dir_path
      if (kind === '其他目录') candidate = f.card(join(f.app, 'users', 'synthetic-user', 'other-folder')).extracted_dir_path
      if (kind === '前缀碰撞') candidate = f.card(f.roots.newer + '-evil').extracted_dir_path
      if (kind === '父级逃逸') candidate = f.roots.newer + '\\..\\..\\other'
      if (kind === '其他主目录') candidate = f.card(join(f.directory, 'other-user', '.workbuddy', 'app', 'users', 'synthetic-user', 'wechat-chat-history')).extracted_dir_path
      if (kind === '不存在') candidate = join(f.roots.newer, '不存在')
      if (kind === '根自身') candidate = f.roots.newer
      if (kind === '大小写别名') candidate = candidate.replace('synthetic-user', 'SYNTHETIC-USER')
      if (['app链接', 'users链接', '用户链接', '历史根链接', '附件链接', '附件祖先链接'].includes(kind)) {
        const outside = join(f.directory, 'outside')
        mkdirSync(outside)
        let alias: string
        if (kind === 'app链接') {
          currentHome.value = join(f.directory, 'linked-home')
          mkdirSync(currentHome.value)
          mkdirSync(join(currentHome.value, '.workbuddy'))
          symlinkSync(f.app, join(currentHome.value, '.workbuddy', 'app'), 'junction')
          candidate = join(currentHome.value, '.workbuddy', 'app', 'users', 'synthetic-user', 'wechat-chat-history', basename(candidate))
        } else if (kind === 'users链接') {
          // 用第二个隔离主目录构造整层链接，不移动任何真实目录。
          currentHome.value = join(f.directory, 'linked-home')
          const linkedApp = join(currentHome.value, '.workbuddy', 'app')
          mkdirSync(linkedApp, { recursive: true })
          symlinkSync(join(f.app, 'users'), join(linkedApp, 'users'), 'junction')
          candidate = join(linkedApp, 'users', 'synthetic-user', 'wechat-chat-history', basename(candidate))
        } else if (kind === '用户链接') {
          alias = join(f.app, 'users', 'alias-user')
          symlinkSync(join(f.app, 'users', 'synthetic-user'), alias, 'junction')
          candidate = join(alias, 'wechat-chat-history', basename(candidate))
        } else if (kind === '历史根链接') {
          alias = join(f.app, 'users', 'alias-user', 'wechat-chat-history')
          mkdirSync(win32.dirname(alias), { recursive: true })
          symlinkSync(f.roots.newer, alias, 'junction')
          candidate = join(alias, basename(candidate))
        } else if (kind === '附件链接') {
          alias = join(f.roots.newer, 'wch-链接附件')
          symlinkSync(outside, alias, 'junction')
          candidate = alias
        } else {
          alias = join(f.roots.newer, 'wch-链接祖先')
          mkdirSync(join(outside, 'child'))
          symlinkSync(outside, alias, 'junction')
          candidate = join(alias, 'child')
        }
      }
      const before = f.db.prepare('SELECT total_changes() AS n').get()!.n
      const radarSchedule = vi.spyOn(radar, 'schedulePendingKeywordRadarRuns')
      const commitmentSchedule = vi.spyOn(commitment, 'schedulePendingCommitmentExtractorRuns')
      // 第一张合法、第二张非法也不得留下已准备的第一张。
      const invalid = { ...good, extracted_dir_path: candidate }
      const response = await call(f, ['app链接', 'users链接'].includes(kind) ? [invalid] : [good, invalid])
      expect(response.isError).toBe(true)
      if (['app链接', 'users链接', '用户链接', '历史根链接', '附件链接', '附件祖先链接'].includes(kind)) {
        expect(JSON.stringify(response.content)).toContain('DESCENDANT_REPARSE_REJECTED')
      }
      if (kind === '大小写别名') expect(JSON.stringify(response.content)).toContain('CASE_ALIAS_MISMATCH')
      expect(f.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before)
      for (const table of ['messages', 'messages_fts', 'batch_import_sessions', 'batch_import_items', 'import_jobs',
        'batch_item_message_sources', 'commitment_extractor_runs', 'commitment_candidates']) {
        expect(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0)
      }
      expect(existsSync(join(f.data, 'evidence'))).toBe(false)
      expect(radarSchedule).not.toHaveBeenCalled()
      expect(commitmentSchedule).not.toHaveBeenCalled()
    }, 30000)

  it('新版来源内的多重硬链接仍由原证据安全后端拒绝', async () => {
    const f = fixture(), card = f.card(f.roots.newer)
    linkSync(join(card.extracted_dir_path, '虚构证据.txt'), join(card.extracted_dir_path, '硬链接.txt'))
    const response = await call(f, [card])
    const result = workBuddyBatchResultSchema.parse(response.structuredContent)
    expect(result.items[0]).toMatchObject({ outcome: 'failed_zero_write', imported: 0, snapshot_relative_path: null })
    expect(result.items[0].error_summary).toMatch(/硬链接/)
    expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n).toBe(0)
  }, 30000)
})

describe('迁移根的相对结构与目录边界', () => {
  it.each(['D', 'F'])('合成 C 盘逻辑根迁移到 %s 盘，支持新旧布局和合成64位目录名', drive => {
    const root: TrustedWorkBuddyRoot = { logicalRoot: 'C:\\Users\\测试用户\\.workbuddy',
      canonicalRoot: `${drive}:\\WorkBuddy\\Data\\.workbuddy`, rootIsReparsePoint: true,
      rootReparseType: 'JUNCTION', status: 'ROOT_REPARSE_ALLOWED' }
    for (const part of ['app\\tmp\\chat-history\\wch-test', `app\\users\\${'ab'.repeat(32)}\\wechat-chat-history\\wch-test`]) {
      const logical = win32.join(root.logicalRoot, part), canonical = win32.join(root.canonicalRoot, part)
      expect(workBuddySourcePathPolicy(logical, win32.dirname(root.logicalRoot)).logicalRoot).toBe(root.logicalRoot)
      expect(() => assertWorkBuddyCanonicalStructure(root, logical, canonical)).not.toThrow()
    }
  })

  it.each([
    ['F:\\Somewhere\\wch-test', 'CANONICAL_OUTSIDE_ROOT'],
    ['F:\\WorkBuddy\\Data\\.workbuddy-evil\\app\\users\\synthetic\\wechat-chat-history\\wch-test', 'CANONICAL_OUTSIDE_ROOT'],
    ['F:\\WorkBuddy\\Data\\.workbuddy\\app\\users\\other\\wechat-chat-history\\wch-test', 'RELATIVE_STRUCTURE_MISMATCH']
  ])('独立拒绝外部、前缀碰撞或内部结构变化：%s', (canonical, code) => {
    const root: TrustedWorkBuddyRoot = { logicalRoot: 'C:\\Users\\测试用户\\.workbuddy',
      canonicalRoot: 'F:\\WorkBuddy\\Data\\.workbuddy', rootIsReparsePoint: true,
      rootReparseType: 'JUNCTION', status: 'ROOT_REPARSE_ALLOWED' }
    const logical = win32.join(root.logicalRoot, 'app', 'users', 'synthetic', 'wechat-chat-history', 'wch-test')
    expect(() => assertWorkBuddyCanonicalStructure(root, logical, canonical)).toThrow(code)
  })
})

const crossVolumeParent = process.env.PRIVATERADAR_P04_CROSS_VOLUME_TEMP_ROOT
describe.skipIf(process.platform !== 'win32')('根级迁移的原生句柄与 Evidence 回归', () => {
  it('普通根通过原生句柄解析，不依赖 Node 的 realpath 结果', async () => {
    const f = fixture(), card = f.card(f.roots.newer)
    vi.spyOn(fs, 'realpath').mockRejectedValue(new Error('合成 Node 路径故障'))
    const root = await resolveTrustedWorkBuddyRoot(f.home)
    expect(root).toEqual({ logicalRoot: join(f.home, '.workbuddy'), canonicalRoot: join(f.home, '.workbuddy'),
      rootIsReparsePoint: false, rootReparseType: 'NONE', status: 'ROOT_ORDINARY' })
    expect(card.extracted_dir_path).toContain('wch-')
  }, 30000)

  it.each([['user', 'legacy'], ['user', 'newer'], ['测试用户', 'legacy'], ['测试用户', 'newer']] as const)(
    '%s 根级 Junction 的 %s 来源保持原始路径并保存物理目录证据', async (username, layout) => {
      const f = fixture(username), physical = migrateRoot(f)
      const logicalHistory = layout === 'legacy' ? f.roots.legacy
        : join(f.app, 'users', 'ab'.repeat(32), 'wechat-chat-history')
      const card = f.card(logicalHistory, '迁移', 'wch-test')
      const expected = join(physical, win32.relative(join(f.home, '.workbuddy'), card.extracted_dir_path))
      const save = vi.spyOn(directoryEvidence, 'saveDirectoryEvidence')
      const response = await call(f, [card])
      expect(response.isError).not.toBe(true)
      const result = workBuddyBatchResultSchema.parse(response.structuredContent), item = result.items[0]
      expect(result).toMatchObject({ status: 'success', summary: { imported_total: 2 } })
      expect(save).toHaveBeenCalledWith(f.db, f.databasePath, item.item_id, expected)
      expect(f.db.prepare('SELECT source_hint FROM batch_import_items WHERE id=?').get(item.item_id)!.source_hint).toBe(card.extracted_dir_path)
      const evidence = join(f.data, 'evidence', item.item_id)
      expect(JSON.parse(readFileSync(join(evidence, 'messages.json'), 'utf8')).input.current_context.extracted_dir_path).toBe(card.extracted_dir_path)
      expect(readFileSync(join(evidence, 'source', '虚构证据.txt'), 'utf8')).toBe('虚构附件材料迁移')
      expect((await verifyBatchEvidence(f.db, f.databasePath, item.item_id)).status).toBe('available')
    }, 30000)

  it.skipIf(!crossVolumeParent)('受控 C 盘普通 .workbuddy 根通过原生句柄建立', async () => {
    const f = fixture('测试用户', crossVolumeParent)
    f.card(f.roots.newer, '普通C盘', 'wch-test')
    const root = await resolveTrustedWorkBuddyRoot(f.home)
    expect(win32.parse(root.canonicalRoot).root.toLowerCase()).toBe('c:\\')
    expect(root.rootIsReparsePoint).toBe(false)
  }, 30000)

  it.skipIf(!crossVolumeParent)('受控 C 盘中文逻辑根 Junction 到另一实际本地盘，64位合成用户目录与 wch-test 通过', async () => {
    const f = fixture('测试用户', crossVolumeParent)
    const targetDirectory = mkdtempSync(join(tmpdir(), 'privateradar-path-target-'))
    extraDirectories.push({ directory: targetDirectory, parent: tmpdir() })
    const physical = migrateRoot(f, join(targetDirectory, 'WorkBuddy', 'Data', '.workbuddy'))
    expect(win32.parse(physical).root.toLowerCase()).not.toBe(win32.parse(f.home).root.toLowerCase())
    const card = f.card(join(f.app, 'users', 'ab'.repeat(32), 'wechat-chat-history'), '跨盘', 'wch-test')
    const root = await resolveTrustedWorkBuddyRoot(f.home)
    expect(root).toMatchObject({ canonicalRoot: physical, rootIsReparsePoint: true, rootReparseType: 'JUNCTION', status: 'ROOT_REPARSE_ALLOWED' })
    const response = await call(f, [card])
    expect(response.isError).not.toBe(true)
    const result = workBuddyBatchResultSchema.parse(response.structuredContent)
    expect(result.summary.imported_total, JSON.stringify(result.items)).toBe(2)
    expect((await verifyBatchEvidence(f.db, f.databasePath, result.items[0].item_id)).status).toBe('available')
  }, 30000)

  it.each(['app', 'users', '用户', '历史根', 'wch目录', 'wch后代'])('根迁移之后的 %s Junction 仍拒绝且零写入', async kind => {
    const f = fixture(), physical = migrateRoot(f)
    const components = ['app', 'users', 'ab'.repeat(32), 'wechat-chat-history', 'wch-test']
    const index = ['app', 'users', '用户', '历史根', 'wch目录', 'wch后代'].indexOf(kind)
    if (index === 5) components.push('nested')
    const outside = join(f.directory, 'outside-target'), rest = components.slice(index + 1)
    const card = rest.length ? f.card(join(outside, ...rest.slice(0, -1)), '逃逸', rest.at(-1))
      : f.card(dirname(outside), '逃逸', basename(outside))
    const parent = join(physical, ...components.slice(0, index))
    mkdirSync(parent, { recursive: true })
    symlinkSync(outside, join(parent, components[index]), 'junction')
    card.extracted_dir_path = join(f.home, '.workbuddy', ...components)
    const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n)
    const response = await call(f, [card])
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain('DESCENDANT_REPARSE_REJECTED')
    assertZeroWrite(f, before)
  }, 30000)

  it.each(['外部根', '物理前缀碰撞', '内部结构不同'])('最终路径出现%s时拒绝且零写入', async kind => {
    const f = fixture(), physical = migrateRoot(f), card = f.card(f.roots.newer)
    const original = fs.realpath
    const canonical = kind === '外部根' ? join(f.directory, 'outside', 'wch-test')
      : kind === '物理前缀碰撞' ? join(physical + '-evil', 'app', 'users', 'synthetic-user', 'wechat-chat-history', 'wch-test')
        : join(physical, 'app', 'users', 'other-user', 'wechat-chat-history', basename(card.extracted_dir_path))
    vi.spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) =>
      String(args[0]) === card.extracted_dir_path ? canonical : original(...args)) as typeof fs.realpath)
    const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n)
    const response = await call(f, [card])
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain(kind === '内部结构不同' ? 'RELATIVE_STRUCTURE_MISMATCH' : 'CANONICAL_OUTSIDE_ROOT')
    assertZeroWrite(f, before)
  }, 30000)

  it('根级 Junction 目标不存在时原生解析失败，禁止回退或登记批次', async () => {
    const f = fixture(), card = f.card(join(f.directory, 'template'))
    mkdirSync(f.home)
    symlinkSync(join(f.directory, 'missing-root'), join(f.home, '.workbuddy'), 'junction')
    card.extracted_dir_path = join(f.roots.newer, 'wch-test')
    const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n)
    const response = await call(f, [card])
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain('ROOT_REPARSE_UNRESOLVABLE')
    assertZeroWrite(f, before)
  }, 30000)

  it('Node 元数据隐藏后代链接时，仍由原生物理句柄拒绝重解析点', async () => {
    const f = fixture(), physical = migrateRoot(f), card = f.card(join(f.directory, 'outside'))
    const logical = join(f.roots.newer, 'wch-opaque'), canonical = join(physical, win32.relative(join(f.home, '.workbuddy'), logical))
    mkdirSync(dirname(canonical), { recursive: true })
    symlinkSync(card.extracted_dir_path, canonical, 'junction')
    card.extracted_dir_path = logical
    const originalLstat = fs.lstat, originalRealpath = fs.realpath
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const info = await originalLstat(...args)
      if (![logical, canonical].includes(String(args[0]))) return info
      return new Proxy(info, { get(target, key) {
        if (key === 'isSymbolicLink') return () => false
        if (key === 'isDirectory') return () => true
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }) as typeof fs.lstat)
    vi.spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) =>
      String(args[0]) === logical ? canonical : originalRealpath(...args)) as typeof fs.realpath)
    const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n)
    const response = await call(f, [card])
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain('DESCENDANT_REPARSE_REJECTED')
    assertZeroWrite(f, before)
  }, 30000)

  it('来源校验后根被替换为另一目标，在会话门禁前原生复核拒绝且零写入', async () => {
    const f = fixture(), physical = migrateRoot(f), card = f.card(f.roots.newer)
    const source = join(physical, win32.relative(join(f.home, '.workbuddy'), card.extracted_dir_path))
    const replacement = join(f.directory, 'replacement')
    mkdirSync(replacement)
    const original = WindowsPathLease.prototype.lock
    let replaced = false
    vi.spyOn(WindowsPathLease.prototype, 'lock').mockImplementation(async function (this: WindowsPathLease, ...args) {
      await original.apply(this, args)
      if (!replaced && args[0] === source) {
        replaced = true
        unlinkSync(join(f.home, '.workbuddy'))
        symlinkSync(replacement, join(f.home, '.workbuddy'), 'junction')
      }
    })
    const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n)
    const response = await call(f, [card])
    expect(replaced).toBe(true)
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain('ROOT_CANONICAL_CHANGED')
    assertZeroWrite(f, before)
  }, 30000)

  it('进入 Evidence 前逻辑 Junction 再被替换，仍只复制已固定的原物理来源', async () => {
    const f = fixture(), physical = migrateRoot(f), card = f.card(f.roots.newer, '原始', 'wch-test')
    const source = join(physical, win32.relative(join(f.home, '.workbuddy'), card.extracted_dir_path))
    const replacement = join(f.directory, 'replacement')
    f.card(join(replacement, 'app', 'users', 'synthetic-user', 'wechat-chat-history'), '替换', 'wch-test')
    const original = directoryEvidence.saveDirectoryEvidence
    let replaced = false
    vi.spyOn(directoryEvidence, 'saveDirectoryEvidence').mockImplementation(async (...args) => {
      if (!replaced) {
        replaced = true
        unlinkSync(join(f.home, '.workbuddy'))
        symlinkSync(replacement, join(f.home, '.workbuddy'), 'junction')
        expect(args[3]).toBe(source)
      }
      return original(...args)
    })
    const response = await call(f, [card])
    expect(replaced).toBe(true)
    expect(response.isError).not.toBe(true)
    const result = workBuddyBatchResultSchema.parse(response.structuredContent), item = result.items[0]
    expect(result.summary.imported_total, JSON.stringify(result.items)).toBe(2)
    expect(readFileSync(join(f.data, 'evidence', item.item_id, 'source', '虚构证据.txt'), 'utf8')).toBe('虚构附件材料原始')
    expect(f.db.prepare('SELECT source_hint FROM batch_import_items WHERE id=?').get(item.item_id)!.source_hint).toBe(card.extracted_dir_path)
  }, 30000)

  it('校验后的物理来源被替换为外部 Junction，Evidence 原生复核拒绝且不导入消息', async () => {
    const f = fixture(), physical = migrateRoot(f), card = f.card(f.roots.newer, '原始', 'wch-test')
    const source = join(physical, win32.relative(join(f.home, '.workbuddy'), card.extracted_dir_path))
    const outside = f.card(join(f.directory, 'outside'), '外部', 'wch-test').extracted_dir_path
    const original = directoryEvidence.saveDirectoryEvidence
    let attempted = false
    vi.spyOn(directoryEvidence, 'saveDirectoryEvidence').mockImplementation(async (...args) => {
      if (!attempted) {
        attempted = true
        const destination = join(f.directory, 'renamed-owned-source')
        expect(resolve(source).startsWith(resolve(f.directory) + sep)).toBe(true)
        expect(resolve(destination).startsWith(resolve(f.directory) + sep)).toBe(true)
        // 目录句柄不等于原子锁定所有名称；受控替换后仍必须由使用时的校验拒绝。
        renameSync(source, destination)
        symlinkSync(outside, source, 'junction')
      }
      return original(...args)
    })
    const response = await call(f, [card])
    expect(attempted).toBe(true)
    const result = workBuddyBatchResultSchema.parse(response.structuredContent)
    expect(result.items[0]).toMatchObject({ outcome: 'failed_zero_write', imported: 0, snapshot_relative_path: null })
    expect(result.items[0].error_summary).toMatch(/重解析点|链接/)
    expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()!.n).toBe(0)
  }, 30000)
})
