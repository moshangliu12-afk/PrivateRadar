import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { arch, machine, release } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MacWorkBuddyProbeReport, ProbeLayout, ProbePathFact } from '../../shared/macos-workbuddy-probe'

export interface ProbeContext {
  platform: string
  home: string
  userData: string
  appVersion: string
  isPackaged: boolean
  electronVersion: string
  nodeVersion: string
  systemApplications?: string
}
export type ProbeCommand = (command: string, args: string[], input?: string | Buffer) => Promise<string>
export interface ProbeSession { report: MacWorkBuddyProbeReport; protectedPaths: string[] }

// 只运行固定的只读系统命令；不经 shell，不继承运行时注入选项，不保留原始错误文本。
export const runProbeCommand: ProbeCommand = (command, args, input) => new Promise((accept, reject) => {
  const child = execFile(command, args, {
    timeout: 3000, maxBuffer: 512 * 1024, encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME, LANG: 'en_US.UTF-8' }
  }, (error, stdout) => error ? reject(Object.assign(new Error('只读系统查询失败'), { code: 'SYSTEM_QUERY_FAILED' })) : accept(stdout))
  child.stdin?.end(input)
})

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const samePath = (a: string, b: string): boolean => a.normalize('NFC') === b.normalize('NFC')
const within = (root: string, value: string): boolean => {
  const r = relative(root, value)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const limitedString = (value: unknown, expression: RegExp): string | null => typeof value === 'string' && value.length <= 160 && expression.test(value) ? value : null
const identifier = (value: unknown): string | null => limitedString(value, /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/)
const version = (value: unknown): string | null => limitedString(value, /^v?\d+(?:\.\d+){0,4}(?:[-+][A-Za-z0-9.-]+)?$/)

/** 探测只读取明确候选及有限层级；未知路径、别名与链接均不扩展扫描。 */
export async function probeMacWorkBuddy(context: ProbeContext, command: ProbeCommand = runProbeCommand): Promise<ProbeSession> {
  if (context.platform !== 'darwin') throw new Error('此检测仅供 macOS 使用')
  const home = resolve(context.home)
  const apps = resolve(context.systemApplications ?? '/Applications')
  const protectedPaths = [join(home, '.workbuddy'), join(home, 'Library', 'Application Support', 'WorkBuddy')]
  const redact = (path: string): string => {
    const full = resolve(path).normalize('NFC'), normalizedHome = home.normalize('NFC'), normalizedApps = apps.normalize('NFC')
    if (within(normalizedHome, full)) return `<HOME>${relative(normalizedHome, full) ? '/' + relative(normalizedHome, full).split(sep).join('/') : ''}`
    if (within(normalizedApps, full)) return `/Applications${relative(normalizedApps, full) ? '/' + relative(normalizedApps, full).split(sep).join('/') : ''}`
    return `<OUTSIDE_HOME:${hash(full)}>`
  }
  // 只导出白名单元数据，文件名、配置值、错误消息均不进入报告。
  const report: MacWorkBuddyProbeReport = {
    report_schema: 'macos-workbuddy-probe-v1', generated_at: new Date().toISOString(),
    private_radar: { version: context.appVersion, is_packaged: context.isPackaged, electron_version: context.electronVersion, node_version: context.nodeVersion, user_data_path: redact(context.userData) },
    system: { macos_version: null, darwin_version: release(), cpu_architecture: machine(), process_arch: arch() },
    workbuddy_app: [], workbuddy_roots: [], chat_history_layout: [], mcp: [], skills: [],
    runtime: { env_node_resolves: false, executable_path_class: 'missing_or_unavailable', node_version: null, bundled_node_candidates: [] },
    filesystem: [], capability: { read_only: true, connector_registration: 'not_tested', stdio_mcp: 'not_tested', tcc: 'not_inferred', real_mac_workbuddy_validated: false },
    privacy_redactions: ['HOME_REPLACED', 'OUTSIDE_HOME_PATHS_HASHED', 'USER_AND_WCH_NAMES_HASHED', 'FILENAMES_HASHED', 'NO_CHAT_CONTENT', 'NO_CONFIG_VALUES', 'NO_RAW_ERRORS'], errors: []
  }
  const error = (scope: string, reason: unknown): void => {
    const code = object(reason)?.code
    const safe = typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'SYSTEM_QUERY_FAILED', 'PATH_CHANGED', 'LIMIT_REACHED', 'UNSAFE_PATH', 'INVALID_JSON'].includes(code) ? code : 'UNAVAILABLE'
    if (safe !== 'ENOENT' && report.errors.length < 60) report.errors.push({ scope, code: safe })
  }
  const fail = (code: string): never => { throw Object.assign(new Error('受限探测未继续'), { code }) }
  const deadline = Date.now() + 45000
  let remaining = 2400
  const budget = (): void => { if (--remaining < 0 || Date.now() > deadline) fail('LIMIT_REACHED') }
  const safeParents = async (path: string): Promise<void> => {
    let parent = dirname(path)
    const parents: string[] = []
    while (dirname(parent) !== parent) {
      parents.push(parent)
      parent = dirname(parent)
    }
    // 自外向内检查，不能让深层 ENOENT 掩盖上层链接。
    for (const current of parents.reverse()) {
      budget()
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) fail('UNSAFE_PATH')
      if (!stat.isDirectory()) fail('ENOTDIR')
    }
  }
  const inspect = async (path: string): Promise<ProbePathFact> => {
    const fact: ProbePathFact = { logical_root: redact(path), canonical_root: null, exists: null, type: 'unknown', is_directory: false, is_symbolic_link: false, parent_symlink: null, realpath_status: 'not_checked', readable: null, writable: null, traversal: 'blocked' }
    try {
      await safeParents(path)
      fact.parent_symlink = false
      budget()
      const stat = await fs.lstat(path)
      fact.exists = true; fact.is_symbolic_link = stat.isSymbolicLink(); fact.is_directory = stat.isDirectory()
      fact.type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'
      const canonical = await fs.realpath(path)
      fact.canonical_root = redact(canonical); fact.realpath_status = 'resolved'
      if (fact.is_symbolic_link || !samePath(canonical, resolve(path))) return fact
      for (const [key, mode] of [['readable', constants.R_OK], ['writable', constants.W_OK]] as const) {
        try { await fs.access(path, mode); fact[key] = true } catch { fact[key] = false }
      }
      fact.traversal = fact.is_directory && fact.readable ? 'allowed' : 'not_applicable'
    } catch (reason) {
      const code = object(reason)?.code
      if (code === 'ENOENT') { fact.exists = false; fact.realpath_status = 'missing' }
      else { fact.realpath_status = typeof code === 'string' && ['EACCES', 'EPERM', 'UNSAFE_PATH'].includes(code) ? code : 'unavailable'; error('path_metadata', reason) }
      if (code === 'UNSAFE_PATH') fact.parent_symlink = true
    }
    return fact
  }
  const check = async (path: string, directory: boolean): Promise<void> => {
    budget(); await safeParents(path)
    const stat = await fs.lstat(path)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || !samePath(await fs.realpath(path), resolve(path))) fail('UNSAFE_PATH')
  }
  const entries = async (path: string): Promise<{ name: string; directory: boolean; file: boolean; symlink: boolean }[]> => {
    await check(path, true)
    const result: { name: string; directory: boolean; file: boolean; symlink: boolean }[] = []
    const handle = await fs.opendir(path)
    try {
      for (;;) {
        budget()
        const entry = await handle.read()
        if (!entry) break
        if (result.length === 128) fail('LIMIT_REACHED')
        result.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile(), symlink: entry.isSymbolicLink() })
      }
      await check(path, true)
    } finally { await handle.close() }
    return result
  }
  const readMetadata = async (path: string): Promise<Buffer> => {
    await check(path, false)
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 256 * 1024) fail('LIMIT_REACHED')
      // 有界读取防止文件在 stat 后增长；聊天文件从不调用此函数。
      const bytes = Buffer.alloc(256 * 1024 + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 256 * 1024) fail('LIMIT_REACHED')
      await check(path, false)
      const after = await fs.lstat(path)
      if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('PATH_CHANGED')
      return bytes.subarray(0, bytesRead)
    } finally { await handle.close() }
  }
  const plist = async (contents: string | Buffer): Promise<Record<string, unknown>> => object(JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], contents))) ?? {}
  try { report.system.macos_version = version((await command('/usr/bin/sw_vers', ['-productVersion'])).trim()) } catch (reason) { error('system', reason) }
  const roots = new Set(protectedPaths)
  for (const appPath of [join(apps, 'WorkBuddy.app'), join(home, 'Applications', 'WorkBuddy.app')]) {
    protectedPaths.push(appPath)
    const fact = await inspect(appPath)
    const appFact: MacWorkBuddyProbeReport['workbuddy_app'][number] = { ...fact, bundle_identifier: null, version: null, build: null, executable: null, sandbox: null, group_container_count: 0 }
    report.workbuddy_app.push(appFact)
    if (fact.traversal !== 'allowed') continue
    try {
      const info = await plist(await readMetadata(join(appPath, 'Contents', 'Info.plist')))
      const id = identifier(info.CFBundleIdentifier)
      appFact.bundle_identifier = id; appFact.version = version(info.CFBundleShortVersionString); appFact.build = version(info.CFBundleVersion)
      appFact.executable = limitedString(info.CFBundleExecutable, /^[A-Za-z0-9_-]+$/)
      if (id) {
        roots.add(join(home, 'Library', 'Application Support', id))
        roots.add(join(home, 'Library', 'Containers', id, 'Data', '.workbuddy'))
        roots.add(join(home, 'Library', 'Containers', id, 'Data', 'Library', 'Application Support', 'WorkBuddy'))
        protectedPaths.push(join(home, 'Library', 'Containers', id))
        // 容器只在读取到真实 bundle id 后检查；组容器只取已签名应用自身声明的组。
        const container = join(home, 'Library', 'Containers', id)
        roots.add(container)
        try {
          const entitlements = await plist(await command('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath]))
          appFact.sandbox = typeof entitlements['com.apple.security.app-sandbox'] === 'boolean' ? entitlements['com.apple.security.app-sandbox'] as boolean : false
          const groups = entitlements['com.apple.security.application-groups']
          if (Array.isArray(groups)) for (const group of groups.slice(0, 8)) {
            const valid = identifier(group)
            if (valid) { const directory = join(home, 'Library', 'Group Containers', valid); roots.add(directory); protectedPaths.push(directory); appFact.group_container_count++ }
          }
        } catch (reason) { error('workbuddy_entitlements', reason) }
      }
      for (const path of ['Contents/Resources/node/bin/node', 'Contents/Frameworks/node/bin/node']) {
        const candidate = join(appPath, path)
        const node = await inspect(candidate)
        report.runtime.bundled_node_candidates.push({ app: fact.logical_root, relative_path: path, exists: node.type === 'file' })
      }
    } catch (reason) { error('workbuddy_app_metadata', reason) }
  }
  const summarize = async (root: string): Promise<ProbeLayout> => {
    const layout: ProbeLayout = { root: redact(root), app_exists: false, users_exists: false, user_count: 0, users: [], legacy_exists: false, directories: 0, files: 0, symlinks: 0, extension_counts: {}, sample_relative_paths: [], truncated: false }
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth === 0) { layout.truncated = true; return }
      for (const entry of await entries(directory)) {
        const path = join(directory, entry.name)
        if (entry.symlink) layout.symlinks++
        else if (entry.directory) { layout.directories++; await walk(path, depth - 1) }
        else if (entry.file) {
          layout.files++
          const suffix = /\.(json|txt|md|html|htm|csv|zip|png|jpg|jpeg|pdf)$/i.exec(entry.name)?.[1].toLowerCase() ?? 'other'
          layout.extension_counts[suffix] = (layout.extension_counts[suffix] ?? 0) + 1
          if (layout.sample_relative_paths.length < 6) layout.sample_relative_paths.push(relative(root, path).split(sep).map(part => `<HASH:${hash(part)}>`).join('/'))
        }
      }
    }
    try {
      layout.app_exists = (await inspect(join(root, 'app'))).traversal === 'allowed'
      const usersPath = join(root, 'app', 'users')
      layout.users_exists = (await inspect(usersPath)).traversal === 'allowed'
      if (layout.users_exists) for (const user of await entries(usersPath)) {
        if (user.symlink) { layout.symlinks++; continue }
        if (!user.directory) continue
        layout.user_count++
        const history = join(usersPath, user.name, 'wechat-chat-history')
        const historyFact = await inspect(history)
        const item = { user_directory_hash: hash(user.name), history_exists: historyFact.traversal === 'allowed', wch_count: 0, wch_hashes: [] as string[] }
        layout.users.push(item)
        if (historyFact.is_symbolic_link) layout.symlinks++
        if (item.history_exists) for (const card of await entries(history)) {
          if (card.symlink) { layout.symlinks++; continue }
          if (card.directory && /^wch-.+/.test(card.name)) { item.wch_count++; item.wch_hashes.push(hash(card.name)); await walk(join(history, card.name), 4) }
        }
      }
      const legacy = join(root, 'app', 'tmp', 'chat-history')
      const legacyFact = await inspect(legacy)
      layout.legacy_exists = legacyFact.traversal === 'allowed'
      if (legacyFact.is_symbolic_link) layout.symlinks++
      if (layout.legacy_exists) await walk(legacy, 4)
    } catch (reason) { layout.truncated = true; error('chat_history_layout', reason) }
    return layout
  }
  for (const root of roots) {
    protectedPaths.push(root)
    const fact = await inspect(root)
    report.workbuddy_roots.push(fact)
    if (fact.traversal !== 'allowed') continue
    report.chat_history_layout.push(await summarize(root))
    const configPath = join(root, 'mcp.json'), approvalPath = join(root, 'mcp-approvals.json')
    const configFact = await inspect(configPath), approvalFact = await inspect(approvalPath)
    const mcp: MacWorkBuddyProbeReport['mcp'][number] = { root: redact(root), exists: configFact.exists, json_valid: null, server_count: null, privateradar_present: null, approvals_exists: approvalFact.exists, approvals_json_valid: null, privateradar_approval_present: null, private_radar_launch: null }
    report.mcp.push(mcp)
    if (configFact.type === 'file') try {
      const data: unknown = JSON.parse((await readMetadata(configPath)).toString('utf8')), record = object(data)
      mcp.json_valid = true
      const servers = object(record?.mcpServers)
      if (servers) {
        mcp.server_count = Object.keys(servers).length; mcp.privateradar_present = own(servers, 'privateradar-workbuddy')
        const server = object(servers['privateradar-workbuddy'])
        if (server) mcp.private_radar_launch = { command_class: classifyCommand(server.command, home), args_count: Array.isArray(server.args) ? server.args.length : 0, cwd_class: typeof server.cwd === 'string' ? (isAbsolute(server.cwd) ? 'absolute' : 'relative') : 'unset', env_key_count: Object.keys(object(server.env) ?? {}).length }
      }
    } catch (reason) { mcp.json_valid = reason instanceof SyntaxError ? false : null; error('mcp_metadata', reason instanceof SyntaxError ? { code: 'INVALID_JSON' } : reason) }
    if (approvalFact.type === 'file') try {
      const data: unknown = JSON.parse((await readMetadata(approvalPath)).toString('utf8'))
      mcp.approvals_json_valid = true
      const hasPrivateRadar = (value: unknown, depth: number): boolean => depth > 0 && (value === 'privateradar-workbuddy' || (Array.isArray(value) ? value.slice(0, 128).some(item => hasPrivateRadar(item, depth - 1)) : object(value) !== null && Object.entries(value as object).slice(0, 128).some(([key, item]) => key === 'privateradar-workbuddy' || hasPrivateRadar(item, depth - 1))))
      mcp.privateradar_approval_present = hasPrivateRadar(data, 5)
    } catch (reason) { mcp.approvals_json_valid = reason instanceof SyntaxError ? false : null; error('mcp_approvals', reason instanceof SyntaxError ? { code: 'INVALID_JSON' } : reason) }
    const skillsPath = join(root, 'skills'), skillsFact = await inspect(skillsPath)
    const skill = { root: redact(root), exists: skillsFact.exists, entry_count: 0, private_radar_present: false, truncated: false }
    report.skills.push(skill)
    if (skillsFact.traversal === 'allowed') try {
      const list = await entries(skillsPath); skill.entry_count = list.length
      skill.private_radar_present = list.some(entry => !entry.symlink && entry.directory && entry.name === 'privateradar-ingest-chat')
    } catch (reason) { skill.truncated = true; error('skills', reason) }
    const filesystem: MacWorkBuddyProbeReport['filesystem'][number] = { root: fact.logical_root, statfs_type: null, filesystem_type: null, case_sensitive: null, unicode_nfc: root === root.normalize('NFC'), unicode_nfd: root === root.normalize('NFD'), alias_resolution: 'not_attempted' }
    report.filesystem.push(filesystem)
    try { await check(root, true); filesystem.statfs_type = (await fs.statfs(root)).type } catch (reason) { error('filesystem', reason) }
    try {
      const disk = await plist(await command('/usr/sbin/diskutil', ['info', '-plist', root]))
      filesystem.filesystem_type = limitedString(disk.FilesystemType, /^[A-Za-z0-9_-]+$/)
      // 只在系统明确给出布尔事实时填写，不通过创建文件推测大小写敏感性。
      filesystem.case_sensitive = typeof disk.CaseSensitive === 'boolean' ? disk.CaseSensitive : null
    } catch (reason) { error('filesystem_query', reason) }
  }
  try {
    const nodePath = (await command('/usr/bin/which', ['node'])).trim()
    if (!isAbsolute(nodePath) || nodePath.includes('\n')) fail('UNSAFE_PATH')
    const found = version((await command('/usr/bin/env', ['node', '--version'])).trim())
    report.runtime.env_node_resolves = found !== null
    report.runtime.executable_path_class = classifyCommand(nodePath, home)
    report.runtime.node_version = found
  } catch (reason) { error('runtime_node', reason) }
  return { report, protectedPaths }
}

function classifyCommand(value: unknown, home: string): string {
  if (typeof value !== 'string' || !value) return 'unset'
  if (!isAbsolute(value)) return value === 'node' ? 'path_node' : 'relative_or_other'
  if (within(home, value)) return 'current_user_absolute'
  if (value.startsWith('/usr/bin/')) return 'system_absolute'
  if (value.startsWith('/opt/homebrew/')) return 'homebrew_absolute'
  if (value.startsWith('/usr/local/')) return 'local_absolute'
  return 'other_absolute'
}
