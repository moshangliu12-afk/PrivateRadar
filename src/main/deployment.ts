import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const CONNECTOR_ID = 'privateradar-workbuddy'
export const WORKBUDDY_SKILL_VERSION = '0.2.0-alpha.16-skill.1'
// 候选载荷和历史官方内容均以完整精确哈希保护，不覆盖用户自定义内容。
export const OFFICIAL_CURRENT_SKILL_SHA256 = '1de8b841995b914a1fd9729442f635ca6169429254e07d1d45fed67fa1bf661e'
export const OFFICIAL_MANAGED_SKILL_SHA256 = new Set([
  '6a23f75db154d0d84adfd6616baf52737a851a2837ceae5f85d450e3ad3a616c',
  '639a747f93323b5547a68393a754980abcb33e6ed7e4acef9c95c32bfc5a67cf',
  '1cedc0cac81aa74869874f50c02c5b6c9d0a7e6d66f44ab8ac004054c3e90f0e',
  'b8a6c458a002b6d50fbe0b13f7df02ba3ac29d932b6493c949d99e38a17ca47e',
  OFFICIAL_CURRENT_SKILL_SHA256
])
const REQUIRED_CONNECTOR_FILES = [
  'connector-meta.json',
  'icon.svg',
  'mcp.json',
  'install-state.json',
  join('dist', 'server.mjs'),
  join('skills', 'ingest-chat', 'SKILL.md')
] as const

export interface ConnectorSetupResult {
  connectorPath: string
  prepared: boolean
  registered: boolean
  registrationPath: string
  registrationChanged: boolean
  requiresTrust: boolean
  trustReason: 'first_install' | 'configuration_changed' | 'none'
  skillDeployment: WorkBuddySkillDeploymentResult
}

export interface WorkBuddySkillDeploymentResult {
  status: 'installed' | 'upgraded' | 'unchanged' | 'preserved_custom'
  sourcePath: string
  targetPath: string
  sourceSha256: string
  previousSha256: string | null
}

export interface WorkBuddySkillDeploymentOptions {
  managedHashes?: ReadonlySet<string>
  atomicRename?: (oldPath: string, newPath: string) => void
}

interface McpConfiguration {
  [key: string]: unknown
  mcpServers: Record<string, Record<string, unknown>>
}

export interface ConnectorSetupState {
  connectorId: string
  configHash: string
  appVersion: string
  preparedAt: string
  trustReason: ConnectorSetupResult['trustReason']
}

export interface WorkBuddyConnectionInspection {
  connected: boolean
  message: string
}

export function runtimeDataDirectory(electronUserData: string, testOverride = process.env.PRIVATE_RADAR_DATA_DIR): string {
  return resolve(testOverride || electronUserData)
}

export function prepareWorkBuddyConnector(
  payloadRoot: string,
  dataDirectory: string,
  appVersion: string,
  now = new Date(),
  userHome = homedir()
): ConnectorSetupResult {
  const connectorPath = join(dataDirectory, 'workbuddy', CONNECTOR_ID)
  const databasePath = join(dataDirectory, 'private-radar.db')
  const logPath = join(dataDirectory, 'logs', 'workbuddy-connector.log')
  const statePath = join(connectorPath, 'install-state.json')
  const config = connectorConfiguration(connectorPath, databasePath, logPath)
  const configText = `${JSON.stringify(config, null, 2)}\n`
  const configHash = createHash('sha256').update(configText).digest('hex')
  const previous = readSetupState(statePath)
  const trustReason = !previous
    ? 'first_install'
    : previous.configHash === configHash ? previous.trustReason : 'configuration_changed'

  mkdirSync(connectorPath, { recursive: true })
  mkdirSync(dirname(logPath), { recursive: true })
  copyConnectorPayload(payloadRoot, connectorPath)
  writeIfChanged(join(connectorPath, 'mcp.json'), configText)
  writeFileSync(statePath, `${JSON.stringify({
    connectorId: CONNECTOR_ID,
    configHash,
    appVersion,
    preparedAt: now.toISOString(),
    trustReason
  } satisfies ConnectorSetupState, null, 2)}\n`, 'utf8')

  validateConnectorInstallation(connectorPath, configHash)
  const skillDeployment = deployWorkBuddySkill(connectorPath, userHome)
  const registration = registerWorkBuddyConnector(connectorPath, userHome)

  return {
    connectorPath,
    prepared: true,
    ...registration,
    requiresTrust: trustReason !== 'none',
    trustReason,
    skillDeployment
  }
}

export function deployWorkBuddySkill(
  connectorPath: string,
  userHome = homedir(),
  options: WorkBuddySkillDeploymentOptions = {}
): WorkBuddySkillDeploymentResult {
  const sourcePath = join(connectorPath, 'skills', 'ingest-chat', 'SKILL.md')
  const targetPath = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error('连接组件缺少正式 Skill source')

  const sourceContent = readFileSync(sourcePath, 'utf8')
  if (!new RegExp(`^version:\\s*${escapeRegExp(WORKBUDDY_SKILL_VERSION)}\\s*$`, 'm').test(sourceContent)) {
    throw new Error(`正式 Skill source 版本必须是 ${WORKBUDDY_SKILL_VERSION}`)
  }
  const sourceSha256 = sha256(sourceContent)
  if (sourceSha256 !== OFFICIAL_CURRENT_SKILL_SHA256) throw new Error('正式 Skill source 内容哈希不符合受保护契约')
  const previousContent = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null
  const previousSha256 = previousContent === null ? null : sha256(previousContent)
  const result = (status: WorkBuddySkillDeploymentResult['status']): WorkBuddySkillDeploymentResult => ({
    status, sourcePath, targetPath, sourceSha256, previousSha256
  })

  if (previousSha256 === sourceSha256) return result('unchanged')
  if (previousSha256 !== null && !(options.managedHashes ?? OFFICIAL_MANAGED_SKILL_SHA256).has(previousSha256)) {
    return result('preserved_custom')
  }

  writeTextAtomically(targetPath, sourceContent, options.atomicRename)
  if (!existsSync(targetPath) || sha256(readFileSync(targetPath, 'utf8')) !== sourceSha256) {
    throw new Error('用户级 Skill 写入后校验失败')
  }
  return result(previousSha256 === null ? 'installed' : 'upgraded')
}

export function registerWorkBuddyConnector(
  connectorPath: string,
  userHome = homedir()
): Pick<ConnectorSetupResult, 'registered' | 'registrationPath' | 'registrationChanged'> {
  const registrationPath = join(userHome, '.workbuddy', 'mcp.json')
  const packagedConfig = readMcpConfiguration(join(connectorPath, 'mcp.json'), '连接组件配置')
  const server = packagedConfig.mcpServers[CONNECTOR_ID]
  if (!server) throw new Error('连接组件缺少正式 WorkBuddy 配置')

  mkdirSync(dirname(registrationPath), { recursive: true })
  const current = existsSync(registrationPath)
    ? readMcpConfiguration(registrationPath, 'WorkBuddy 用户配置')
    : { mcpServers: {} }
  const unchanged = sameMcpServer(current.mcpServers[CONNECTOR_ID], server)
  if (!unchanged) {
    const next: McpConfiguration = {
      ...current,
      mcpServers: { ...current.mcpServers, [CONNECTOR_ID]: server }
    }
    if (existsSync(registrationPath)) copyFileSync(registrationPath, `${registrationPath}.privateradar-backup`)
    writeJsonAtomically(registrationPath, next)
  }
  validateWorkBuddyRegistration(connectorPath, registrationPath)
  return { registered: true, registrationPath, registrationChanged: !unchanged }
}

export function validateWorkBuddyRegistration(connectorPath: string, registrationPath: string): void {
  const packaged = readMcpConfiguration(join(connectorPath, 'mcp.json'), '连接组件配置')
  const registered = readMcpConfiguration(registrationPath, 'WorkBuddy 用户配置')
  if (!sameMcpServer(registered.mcpServers[CONNECTOR_ID], packaged.mcpServers[CONNECTOR_ID])) {
    throw new Error('PrivateRadar 未能正确注册到 WorkBuddy')
  }
}

export function isWorkBuddyConnectorRegistered(dataDirectory: string, userHome = homedir()): boolean {
  const connectorPath = join(dataDirectory, 'workbuddy', CONNECTOR_ID)
  const registrationPath = join(userHome, '.workbuddy', 'mcp.json')
  try {
    validateConnectorInstallation(connectorPath)
    validateWorkBuddyRegistration(connectorPath, registrationPath)
    return true
  } catch {
    return false
  }
}

export function inspectWorkBuddyConnection(dataDirectory: string, userHome = homedir()): WorkBuddyConnectionInspection {
  const connectorPath = join(dataDirectory, 'workbuddy', CONNECTOR_ID)
  const registrationPath = join(userHome, '.workbuddy', 'mcp.json')
  const approvalPath = join(userHome, '.workbuddy', 'mcp-approvals.json')
  if (!existsSync(registrationPath)) return { connected: false, message: 'WorkBuddy 尚未配置 PrivateRadar。' }
  let registered: McpConfiguration
  try {
    registered = readMcpConfiguration(registrationPath, 'WorkBuddy 用户配置')
  } catch {
    return { connected: false, message: 'WorkBuddy 配置无法读取，请在 WorkBuddy 中检查配置。' }
  }
  const server = registered.mcpServers[CONNECTOR_ID]
  if (!server) return { connected: false, message: 'WorkBuddy 中尚未注册 PrivateRadar。' }
  if (server.disabled === true) return { connected: false, message: 'PrivateRadar 在 WorkBuddy 中已关闭，请先启用。' }
  try {
    validateConnectorInstallation(connectorPath)
    validateWorkBuddyRegistration(connectorPath, registrationPath)
  } catch {
    return { connected: false, message: 'WorkBuddy 中的 PrivateRadar 路径或运行文件不正确，请重新配置。' }
  }
  if (!hasWorkBuddyApproval(approvalPath)) {
    return { connected: false, message: 'PrivateRadar 已配置，但尚未在 WorkBuddy 中完成信任。' }
  }
  return { connected: true, message: 'WorkBuddy 已连接。' }
}

export function validateConnectorInstallation(connectorPath: string, expectedConfigHash?: string): void {
  for (const relativePath of REQUIRED_CONNECTOR_FILES) {
    const path = join(connectorPath, relativePath)
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new Error(`连接组件文件不完整：${relativePath}`)
    }
  }

  const metadata = JSON.parse(readFileSync(join(connectorPath, 'connector-meta.json'), 'utf8')) as { source?: unknown }
  if (metadata.source !== CONNECTOR_ID) throw new Error('连接组件标识不正确')

  const configText = readFileSync(join(connectorPath, 'mcp.json'), 'utf8')
  const config = JSON.parse(configText) as { mcpServers?: Record<string, { cwd?: unknown; args?: unknown }> }
  const server = config.mcpServers?.[CONNECTOR_ID]
  const expectedServerPath = resolve(connectorPath, 'dist', 'server.mjs')
  if (!server || server.cwd !== resolve(connectorPath) || !Array.isArray(server.args) || server.args[0] !== expectedServerPath) {
    throw new Error('连接组件启动路径不正确')
  }
  const state = readSetupState(join(connectorPath, 'install-state.json'))
  const actualHash = createHash('sha256').update(configText).digest('hex')
  if (!state || state.configHash !== actualHash || (expectedConfigHash && actualHash !== expectedConfigHash)) {
    throw new Error('连接组件配置校验失败')
  }
}

export function connectorSetupState(dataDirectory: string): ConnectorSetupState | null {
  return readSetupState(join(dataDirectory, 'workbuddy', CONNECTOR_ID, 'install-state.json'))
}

export function acknowledgeConnectorTrust(dataDirectory: string): void {
  const statePath = join(dataDirectory, 'workbuddy', CONNECTOR_ID, 'install-state.json')
  const state = readSetupState(statePath)
  if (!state || state.trustReason === 'none') return
  writeFileSync(statePath, `${JSON.stringify({ ...state, trustReason: 'none' } satisfies ConnectorSetupState, null, 2)}\n`, 'utf8')
}

export function detectWorkBuddyInstalled(
  userHome = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  programFiles = process.env.ProgramFiles
): boolean {
  const candidates = [
    join(userHome, '.workbuddy'),
    localAppData ? join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe') : '',
    localAppData ? join(localAppData, 'WorkBuddy', 'WorkBuddy.exe') : '',
    programFiles ? join(programFiles, 'WorkBuddy', 'WorkBuddy.exe') : ''
  ].filter(Boolean)
  return candidates.some((path) => existsSync(path))
}

export function writeOperationalLog(logDirectory: string, event: string, errorType?: string): void {
  try {
    mkdirSync(logDirectory, { recursive: true })
    const safeEvent = sanitizeLogValue(event)
    const safeError = errorType ? ` error=${sanitizeLogValue(errorType)}` : ''
    appendFileSync(join(logDirectory, 'privateradar.log'), `${new Date().toISOString()} event=${safeEvent}${safeError}\n`, 'utf8')
  } catch {
    // 日志不得影响应用主流程。
  }
}

function connectorConfiguration(connectorPath: string, databasePath: string, logPath: string): object {
  // WorkBuddy 5.5.5 会在创建对话会话时重新投影 MCP 配置，并移除 cwd。
  // 服务入口必须是绝对路径，不能依赖会话工作目录解析。
  const serverPath = resolve(connectorPath, 'dist', 'server.mjs')
  return {
    mcpServers: {
      [CONNECTOR_ID]: {
        type: 'stdio',
        command: 'node',
        args: [serverPath, '--database', resolve(databasePath), '--log-path', resolve(logPath)],
        cwd: resolve(connectorPath),
        runtime: { type: 'node', version: '24' },
        timeout: 30000
      }
    }
  }
}

function copyConnectorPayload(payloadRoot: string, connectorPath: string): void {
  for (const name of ['connector-meta.json', 'icon.svg']) {
    const source = join(payloadRoot, name)
    if (!existsSync(source)) throw new Error(`连接组件缺少 ${name}`)
    copyFileSync(source, join(connectorPath, name))
  }
  for (const name of ['dist', 'skills']) {
    const source = join(payloadRoot, name)
    if (!existsSync(source)) throw new Error(`连接组件缺少 ${name}`)
    copyDirectory(source, join(connectorPath, name))
  }
}

/**
 * 不使用 Node 24 在部分 Windows 环境会返回 EIO 的 cpSync 目录复制。
 * 此函数只复制连接组件文件，既不改配置文本，也不影响 WorkBuddy 信任哈希。
 */
function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) copyDirectory(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
  }
}

function readSetupState(path: string): ConnectorSetupState | null {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConnectorSetupState>
    if (value.connectorId !== CONNECTOR_ID || typeof value.configHash !== 'string' || typeof value.appVersion !== 'string' || typeof value.preparedAt !== 'string') return null
    if (!['first_install', 'configuration_changed', 'none'].includes(value.trustReason ?? '')) return null
    return value as ConnectorSetupState
  } catch {
    return null
  }
}

function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  writeFileSync(path, content, 'utf8')
}

function readMcpConfiguration(path: string, label: string): McpConfiguration {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(value) || !isRecord(value.mcpServers)) throw new Error('结构无效')
    return value as McpConfiguration
  } catch {
    throw new Error(`${label}格式无效，未进行任何修改`)
  }
}

function writeJsonAtomically(path: string, value: McpConfiguration): void {
  const temporaryPath = `${path}.privateradar-tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  readMcpConfiguration(temporaryPath, '临时 WorkBuddy 配置')
  renameSync(temporaryPath, path)
}

function writeTextAtomically(
  path: string,
  content: string,
  atomicRename: (oldPath: string, newPath: string) => void = renameSync
): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${basename(path)}.privateradar-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' })
    if (sha256(readFileSync(temporaryPath, 'utf8')) !== sha256(content)) {
      throw new Error('临时 Skill 写入校验失败')
    }
    atomicRename(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasWorkBuddyApproval(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isRecord(value) && Object.keys(value).some((key) => key.endsWith(`::${CONNECTOR_ID}`))
  } catch {
    return false
  }
}

function sameMcpServer(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined): boolean {
  if (!left || !right) return false
  const normalized = (value: Record<string, unknown>): Record<string, unknown> => ({
    ...value,
    disabled: value.disabled === true
  })
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right))
}

function sanitizeLogValue(value: string): string {
  return value
    .replace(/sk-[a-zA-Z0-9_-]+/g, 'REDACTED')
    .replace(/(?:api[_-]?key|token)[=:][^\s]+/gi, 'credential=REDACTED')
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 120)
}
