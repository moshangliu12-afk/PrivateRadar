import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeMacWorkBuddy, type ProbeCommand, type ProbeContext } from '../src/main/macos-workbuddy-probe/core'
import { registerMacWorkBuddyProbeIpc } from '../src/main/macos-workbuddy-probe/desktop'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

let root: string, home: string, apps: string, context: ProbeContext
const secret = '绝不能泄露的聊天正文和令牌'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const command = vi.fn<ProbeCommand>(async (executable, args, input) => {
  if (executable === '/usr/bin/plutil') return input!.toString()
  if (executable === '/usr/bin/sw_vers') return '15.7.1\n'
  if (executable === '/usr/bin/which') return '/opt/homebrew/bin/node\n'
  if (executable === '/usr/bin/env') return 'v24.14.0\n'
  if (executable === '/usr/bin/codesign') return JSON.stringify({ 'com.apple.security.app-sandbox': true, 'com.apple.security.application-groups': ['TEAM.cn.workbuddy.shared'] })
  if (executable === '/usr/sbin/diskutil') return JSON.stringify({ FilesystemType: 'apfs', CaseSensitive: false, VolumeName: secret, OwnerName: '真实姓名' })
  throw new Error(secret)
})
async function file(path: string, value: string | object): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}
async function app(base = apps): Promise<void> {
  await file(join(base, 'WorkBuddy.app', 'Contents', 'Info.plist'), { CFBundleIdentifier: 'cn.workbuddy.desktop', CFBundleShortVersionString: '1.2.3', CFBundleVersion: '123', CFBundleExecutable: 'WorkBuddy', PrivateField: secret })
}
const probe = () => probeMacWorkBuddy(context, command)
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pr-m2a-')))
  home = join(root, '用户小张😀'); apps = join(root, 'Applications')
  await fs.mkdir(home); await fs.mkdir(apps)
  context = { platform: 'darwin', home, userData: join(home, 'Library', 'Application Support', 'PrivateRadar'), appVersion: '0.2.0-alpha.26', isPackaged: true, electronVersion: '44.10.0', nodeVersion: '24.14.0', systemApplications: apps }
  command.mockClear()
})
afterEach(async () => { vi.restoreAllMocks(); if (root) { expect(dirname(resolve(root))).toBe(await fs.realpath(tmpdir())); expect(root.split(/[\\/]/).at(-1)).toMatch(/^pr-m2a-/); await fs.rm(root, { recursive: true, force: true }) } })

describe('macOS WorkBuddy 有界只读探测', () => {
  it('没有 WorkBuddy 时生成可操作的脱敏报告，不猜测容器', async () => {
    const { report } = await probe()
    expect(report.report_schema).toBe('macos-workbuddy-probe-v1')
    expect(report.workbuddy_app.every(item => item.exists === false)).toBe(true)
    expect(report.workbuddy_roots).toHaveLength(2)
    expect(report.workbuddy_roots.every(item => !item.exists)).toBe(true)
    expect(report.capability).toEqual({ read_only: true, connector_registration: 'not_tested', stdio_mcp: 'not_tested', tcc: 'not_inferred', real_mac_workbuddy_validated: false })
  })
  it.each(['system', 'user'])('只读读取 %s 应用元数据，容器来自真实 bundle 和组声明', async kind => {
    await app(kind === 'system' ? apps : join(home, 'Applications'))
    const { report } = await probe()
    const found = report.workbuddy_app.find(item => item.exists)!
    expect(found.bundle_identifier).toBe('cn.workbuddy.desktop')
    expect(found.version).toBe('1.2.3'); expect(found.build).toBe('123'); expect(found.executable).toBe('WorkBuddy')
    expect(found.sandbox).toBe(true); expect(found.group_container_count).toBe(1)
    expect(found.logical_root).toBe(kind === 'system' ? '/Applications/WorkBuddy.app' : '<HOME>/Applications/WorkBuddy.app')
    expect(report.workbuddy_roots.some(item => item.logical_root.includes('Containers/cn.workbuddy.desktop'))).toBe(true)
    expect(report.workbuddy_roots.some(item => item.logical_root.includes('Group Containers/TEAM.cn.workbuddy.shared'))).toBe(true)
    expect(JSON.stringify(report)).not.toContain(secret)
  })
  it('缺少 bundle id 时不探测任何 Container 或 Group Container', async () => {
    await file(join(apps, 'WorkBuddy.app', 'Contents', 'Info.plist'), {})
    const { report } = await probe()
    expect(report.workbuddy_roots).toHaveLength(2)
    expect(command.mock.calls.some(call => call[0] === '/usr/bin/codesign')).toBe(false)
  })
  it('发现当前用户数据根，查询权限与文件系统时从不写探针文件', async () => {
    await fs.mkdir(join(home, '.workbuddy'))
    const write = vi.spyOn(fs, 'writeFile'), mkdir = vi.spyOn(fs, 'mkdir')
    const before = await fs.readdir(join(home, '.workbuddy'))
    const { report } = await probe()
    expect(report.workbuddy_roots[0]).toMatchObject({ exists: true, type: 'directory', readable: true, traversal: 'allowed', logical_root: '<HOME>/.workbuddy', canonical_root: '<HOME>/.workbuddy' })
    expect(report.filesystem[0]).toMatchObject({ filesystem_type: 'apfs', case_sensitive: false })
    expect(await fs.readdir(join(home, '.workbuddy'))).toEqual(before)
    expect(write).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled()
  })
  it('识别用户与 wch 层级，文件名和标识脱敏，从不打开聊天文件', async () => {
    const card = join(home, '.workbuddy', 'app', 'users', '机密用户ID', 'wechat-chat-history', 'wch-秘密群名')
    await file(join(card, '秘密会话.json'), secret)
    await file(join(card, '来源.txt'), secret)
    const open = vi.spyOn(fs, 'open')
    const { report } = await probe()
    const layout = report.chat_history_layout[0]
    expect(layout.user_count).toBe(1)
    expect(layout.users).toEqual([{ user_directory_hash: hash('机密用户ID'), history_exists: true, wch_count: 1, wch_hashes: [hash('wch-秘密群名')] }])
    expect(layout.files).toBe(2); expect(layout.extension_counts).toEqual({ json: 1, txt: 1 })
    expect(layout.sample_relative_paths).toHaveLength(2)
    expect(open).not.toHaveBeenCalled()
    for (const text of [home, '机密用户ID', '秘密群名', '秘密会话', secret]) expect(JSON.stringify(report)).not.toContain(text)
  })
  it('识别 legacy 历史目录，仅统计元数据', async () => {
    await file(join(home, '.workbuddy', 'app', 'tmp', 'chat-history', '旧聊天.html'), secret)
    const { report } = await probe()
    expect(report.chat_history_layout[0]).toMatchObject({ legacy_exists: true, files: 1, extension_counts: { html: 1 } })
    expect(JSON.stringify(report)).not.toContain(secret)
  })
  it('根 symlink 只报告链接与 realpath，不遍历目标', async () => {
    const target = join(home, '外部目标'); await file(join(target, 'mcp.json'), secret)
    await fs.symlink(target, join(home, '.workbuddy'), process.platform === 'win32' ? 'junction' : 'dir')
    const open = vi.spyOn(fs, 'open')
    const { report } = await probe()
    expect(report.workbuddy_roots[0]).toMatchObject({ exists: true, type: 'symlink', is_symbolic_link: true, traversal: 'blocked', realpath_status: 'resolved' })
    expect(report.chat_history_layout).toHaveLength(0); expect(open).not.toHaveBeenCalled()
  })
  it('后代链接不跟随，不读目标配置或聊天正文', async () => {
    const card = join(home, '.workbuddy', 'app', 'users', '用户', 'wechat-chat-history', 'wch-1')
    const target = join(home, '私人目标'); await file(join(target, '秘密.txt'), secret); await fs.mkdir(card, { recursive: true })
    await fs.symlink(target, join(card, '外链'), process.platform === 'win32' ? 'junction' : 'dir')
    const { report } = await probe()
    expect(report.chat_history_layout[0]).toMatchObject({ symlinks: 1, files: 0 })
    expect(JSON.stringify(report)).not.toContain(secret)
  })
  it('父路径链接阻断探测，错误不携带私有路径', async () => {
    const target = join(home, '私有目录'); await fs.mkdir(target)
    await fs.symlink(target, join(home, 'Library'), process.platform === 'win32' ? 'junction' : 'dir')
    const { report } = await probe()
    expect(report.workbuddy_roots[1]).toMatchObject({ parent_symlink: true, traversal: 'blocked' })
    expect(JSON.stringify(report)).not.toContain('私有目录')
  })
  it('损坏的 mcp.json 保留存在性，标记无效，不导出解析错误正文', async () => {
    await file(join(home, '.workbuddy', 'mcp.json'), '{' + secret)
    const { report } = await probe()
    expect(report.mcp[0]).toMatchObject({ exists: true, json_valid: false })
    expect(JSON.stringify(report)).not.toContain(secret)
  })
  it('其他 MCP 的令牌、API Key、参数、env 和私有路径不能泄露', async () => {
    await file(join(home, '.workbuddy', 'mcp.json'), { mcpServers: {
      secretServer: { command: home + '/秘密命令', args: ['--token', secret], env: { API_KEY: secret } },
      'privateradar-workbuddy': { command: home + '/node', args: [secret], cwd: home, env: { TOKEN: secret } }
    } })
    const { report } = await probe()
    expect(report.mcp[0]).toMatchObject({ json_valid: true, server_count: 2, privateradar_present: true, private_radar_launch: { command_class: 'current_user_absolute', args_count: 1, cwd_class: 'absolute', env_key_count: 1 } })
    for (const value of [secret, home, 'secretServer', 'API_KEY', 'TOKEN', '秘密命令']) expect(JSON.stringify(report)).not.toContain(value)
  })
  it('approvals 仅输出已存在的 PrivateRadar 条目，不自动信任', async () => {
    const path = join(home, '.workbuddy', 'mcp-approvals.json')
    await file(path, { approved: [{ name: 'privateradar-workbuddy', token: secret }] })
    const before = await fs.readFile(path)
    const { report } = await probe()
    expect(report.mcp[0]).toMatchObject({ approvals_exists: true, approvals_json_valid: true, privateradar_approval_present: true })
    expect(await fs.readFile(path)).toEqual(before); expect(JSON.stringify(report)).not.toContain(secret)
  })
  it('skills 仅列目录统计，识别既有 Skill，不读其他内容', async () => {
    await file(join(home, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md'), secret)
    await file(join(home, '.workbuddy', 'skills', '秘密插件', 'SKILL.md'), secret)
    const { report } = await probe()
    expect(report.skills[0]).toMatchObject({ exists: true, entry_count: 2, private_radar_present: true })
    expect(JSON.stringify(report)).not.toContain('秘密插件'); expect(JSON.stringify(report)).not.toContain(secret)
  })
  it('Node found：固定 env node --version，没有执行 MCP 或配置中的 command', async () => {
    const { report } = await probe()
    expect(report.runtime).toMatchObject({ env_node_resolves: true, executable_path_class: 'homebrew_absolute', node_version: 'v24.14.0' })
    expect(command).toHaveBeenCalledWith('/usr/bin/env', ['node', '--version'])
    expect(command.mock.calls.every(call => ['/usr/bin/plutil', '/usr/bin/sw_vers', '/usr/bin/which', '/usr/bin/env', '/usr/bin/codesign', '/usr/sbin/diskutil'].includes(call[0]))).toBe(true)
  })
  it('Node missing：不安装或下载 runtime', async () => {
    const missing: ProbeCommand = async executable => { if (executable === '/usr/bin/sw_vers') return '15.7'; throw new Error(secret) }
    const { report } = await probeMacWorkBuddy(context, missing)
    expect(report.runtime).toMatchObject({ env_node_resolves: false, node_version: null })
    expect(JSON.stringify(report)).not.toContain(secret)
  })
  it('不可读目录保留事实，权限检查失败不创建文件', async () => {
    await fs.mkdir(join(home, '.workbuddy'))
    const access = fs.access
    vi.spyOn(fs, 'access').mockImplementation(async (path, mode) => {
      if (path === join(home, '.workbuddy') && mode === constants.R_OK) throw Object.assign(new Error(secret), { code: 'EACCES' })
      return access(path, mode)
    })
    const { report } = await probe()
    expect(report.workbuddy_roots[0]).toMatchObject({ exists: true, readable: false, traversal: 'not_applicable' })
  })
  it('Unicode Home 与应用 userData 完整脱敏，外部路径仅输出 hash', async () => {
    const { report } = await probeMacWorkBuddy({ ...context, userData: join(root, '其他用户', '私有数据') }, command)
    expect(report.private_radar.user_data_path).toMatch(/^<OUTSIDE_HOME:[a-f0-9]{64}>$/)
    expect(JSON.stringify(report)).not.toContain('用户小张'); expect(JSON.stringify(report)).not.toContain('其他用户')
  })
  it('目录数量有上限，限制结果可识别，不扩展全盘扫描', async () => {
    const users = join(home, '.workbuddy', 'app', 'users'); await fs.mkdir(users, { recursive: true })
    for (let i = 0; i < 130; i++) await fs.mkdir(join(users, String(i)))
    const { report } = await probe()
    expect(report.chat_history_layout[0].truncated).toBe(true)
    expect(report.errors).toContainEqual({ scope: 'chat_history_layout', code: 'LIMIT_REACHED' })
  })
  it('Windows 拒绝核心调用，零文件访问', async () => {
    const lstat = vi.spyOn(fs, 'lstat')
    await expect(probeMacWorkBuddy({ ...context, platform: 'win32' }, command)).rejects.toThrow('仅供 macOS')
    expect(lstat).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled()
  })
})

describe('报告 IPC 与写入边界', () => {
  function desktop(platform = 'darwin') {
    const handlers = new Map<string, () => Promise<any>>()
    let path: string | null = join(home, '报告.json')
    const choose = vi.fn(async () => path)
    registerMacWorkBuddyProbeIpc({ handle: (key, handler) => handlers.set(key, handler as () => Promise<any>) }, { context: { ...context, platform }, chooseReportPath: choose, probe: () => probe() })
    return { handlers, choose, setPath: (value: string | null) => { path = value }, run: () => handlers.get('macos-workbuddy-probe:run')!(), save: () => handlers.get('macos-workbuddy-probe:export')!() }
  }
  it('Windows 不注册探测或导出 IPC', () => { expect(desktop('win32').handlers.size).toBe(0) })
  it('探测前不可导出，取消不写文件，选择本地路径后导出主进程报告', async () => {
    const d = desktop(); expect((await d.save()).status).toBe('failed'); expect(d.choose).not.toHaveBeenCalled()
    const report = await d.run()
    d.setPath(null); expect((await d.save()).status).toBe('cancelled')
    d.setPath(join(home, '报告.json')); expect((await d.save()).status).toBe('saved')
    expect(JSON.parse(await fs.readFile(join(home, '报告.json'), 'utf8'))).toEqual(report)
    expect(JSON.stringify(report)).not.toContain(home)
  })
  it('不覆盖已有报告，不接受 WorkBuddy 内任何报告写入', async () => {
    const d = desktop(); await fs.mkdir(join(home, '.workbuddy')); await d.run()
    await file(join(home, '报告.json'), secret)
    expect((await d.save()).status).toBe('failed'); expect(await fs.readFile(join(home, '报告.json'), 'utf8')).toBe(secret)
    d.setPath(join(home, '.workbuddy', '报告.json')); expect((await d.save()).status).toBe('failed')
    expect(await fs.readdir(join(home, '.workbuddy'))).toEqual([])
  })
  it('报告保存路径含父目录 symlink 时拒绝', async () => {
    const d = desktop(); await d.run()
    const actual = join(home, '真实目录'); await fs.mkdir(actual)
    await fs.symlink(actual, join(home, '链接'), process.platform === 'win32' ? 'junction' : 'dir')
    d.setPath(join(home, '链接', '报告.json')); expect((await d.save()).status).toBe('failed')
    expect(await fs.readdir(actual)).toEqual([])
  })
})
