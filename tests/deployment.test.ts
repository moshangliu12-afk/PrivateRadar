import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acknowledgeConnectorTrust,
  connectorSetupState,
  deployWorkBuddySkill,
  detectWorkBuddyInstalled,
  inspectWorkBuddyConnection,
  isWorkBuddyConnectorRegistered,
  prepareWorkBuddyConnector,
  runtimeDataDirectory,
  OFFICIAL_MANAGED_SKILL_SHA256,
  OFFICIAL_CURRENT_SKILL_SHA256,
  WORKBUDDY_SKILL_VERSION,
  validateConnectorInstallation,
  writeOperationalLog
} from '../src/main/deployment'

const canonicalSkill = readFileSync(join(process.cwd(), 'integrations', 'workbuddy', 'connector', 'skills', 'ingest-chat', 'SKILL.md'), 'utf8')
const officialOldSkill = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'workbuddy-official-alpha4-skill2.md'), 'utf8')
const officialAlpha15Skill = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'workbuddy-official-alpha15-skill3.md'), 'utf8')
const officialAlpha16Skill = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'workbuddy-official-alpha16-skill1.md'), 'utf8')

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function fixture(): { root: string; payload: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), 'privateradar-deployment-'))
  directories.push(root)
  const payload = join(root, 'payload')
  const data = join(root, 'AppData', 'PrivateRadar')
  mkdirSync(join(payload, 'dist'), { recursive: true })
  mkdirSync(join(payload, 'skills', 'ingest-chat'), { recursive: true })
  writeFileSync(join(payload, 'connector-meta.json'), '{"source":"privateradar-workbuddy"}\n')
  writeFileSync(join(payload, 'icon.svg'), '<svg/>\n')
  writeFileSync(join(payload, 'dist', 'server.mjs'), 'export {}\n')
  writeFileSync(join(payload, 'skills', 'ingest-chat', 'SKILL.md'), canonicalSkill)
  return { root, payload, data }
}

describe('Windows 安装与 WorkBuddy 连接组件', () => {
  it('正式运行使用 Electron userData，只有测试显式传入时才隔离', () => {
    const electronUserData = 'C:\\Users\\tester\\AppData\\Roaming\\PrivateRadar'
    const isolated = 'C:\\qa\\private-radar'
    expect(runtimeDataDirectory(electronUserData, '')).toBe(electronUserData)
    expect(runtimeDataDirectory(electronUserData, isolated)).toBe(isolated)
  })

  it('在固定用户数据目录生成自包含连接组件', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    const config = JSON.parse(readFileSync(join(result.connectorPath, 'mcp.json'), 'utf8'))
    const server = config.mcpServers['privateradar-workbuddy']
    expect(result).toMatchObject({ prepared: true, requiresTrust: true, trustReason: 'first_install' })
    expect(result).toMatchObject({ registered: true, registrationChanged: true })
    expect(result.registrationPath).toBe(join(userHome, '.workbuddy', 'mcp.json'))
    expect(server.command).toBe('node')
    expect(server.runtime).toEqual({ type: 'node', version: '24' })
    expect(server.cwd).toBe(result.connectorPath)
    expect(server.args[0]).toBe(join(result.connectorPath, 'dist', 'server.mjs'))
    expect(server.args).toContain(join(data, 'private-radar.db'))
    expect(JSON.stringify(config)).not.toContain('Documents\\Codex')
    expect(result.skillDeployment).toMatchObject({ status: 'installed' })
    expect(result.skillDeployment.sourcePath).toBe(join(result.connectorPath, 'skills', 'ingest-chat', 'SKILL.md'))
    expect(readFileSync(result.skillDeployment.targetPath, 'utf8')).toBe(canonicalSkill)
  })

  it('官方旧 Skill 安全升级到 alpha.18-skill.1', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const target = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, officialOldSkill)
    const oldHash = createHash('sha256').update(officialOldSkill).digest('hex')
    expect(oldHash).toBe('6a23f75db154d0d84adfd6616baf52737a851a2837ceae5f85d450e3ad3a616c')
    expect(OFFICIAL_MANAGED_SKILL_SHA256.has(oldHash)).toBe(true)

    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.14.1', new Date(), userHome)
    expect(result.skillDeployment).toMatchObject({ status: 'upgraded', previousSha256: oldHash })
    expect(readFileSync(target, 'utf8')).toBe(canonicalSkill)
    expect(readFileSync(target, 'utf8')).toContain(`version: ${WORKBUDDY_SKILL_VERSION}`)
  })

  it('正式 alpha.16-skill.1 原字节升级到新单卡来源契约，不按版本号猜测官方身份', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const target = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
    const oldHash = createHash('sha256').update(officialAlpha16Skill).digest('hex')
    expect(oldHash).toBe('1de8b841995b914a1fd9729442f635ca6169429254e07d1d45fed67fa1bf661e')
    expect(OFFICIAL_MANAGED_SKILL_SHA256.has(oldHash)).toBe(true)
    expect(oldHash).not.toBe(OFFICIAL_CURRENT_SKILL_SHA256)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, officialAlpha16Skill)

    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.18', new Date(), userHome)
    expect(result.skillDeployment).toMatchObject({ status: 'upgraded', previousSha256: oldHash,
      sourceSha256: OFFICIAL_CURRENT_SKILL_SHA256 })
    expect(readFileSync(target, 'utf8')).toBe(canonicalSkill)
    expect(readFileSync(target, 'utf8')).toContain('version: 0.2.0-alpha.18-skill.1')
  })

  it('已安装正确 alpha.18-skill.1 时保持不变', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.18', new Date(), userHome)
    const repeated = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.18', new Date(), userHome)
    expect(repeated.skillDeployment.status).toBe('unchanged')
    expect(readFileSync(repeated.skillDeployment.targetPath, 'utf8')).toBe(canonicalSkill)
  })

  it('正式 alpha.15-skill.3 原字节可安全升级到 alpha.18-skill.1，当前源哈希受固定契约保护', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const target = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, officialAlpha15Skill)
    const oldHash = createHash('sha256').update(officialAlpha15Skill).digest('hex')
    expect(oldHash).toBe('1cedc0cac81aa74869874f50c02c5b6c9d0a7e6d66f44ab8ac004054c3e90f0e')
    expect(OFFICIAL_MANAGED_SKILL_SHA256.has(oldHash)).toBe(true)
    expect(createHash('sha256').update(canonicalSkill).digest('hex')).toBe(OFFICIAL_CURRENT_SKILL_SHA256)
    expect(OFFICIAL_MANAGED_SKILL_SHA256.has(OFFICIAL_CURRENT_SKILL_SHA256)).toBe(true)
    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.18', new Date(), userHome)
    expect(result.skillDeployment).toMatchObject({ status: 'upgraded', previousSha256: oldHash,
      sourceSha256: OFFICIAL_CURRENT_SKILL_SHA256 })
    expect(readFileSync(target, 'utf8')).toBe(canonicalSkill)
    expect(readFileSync(target, 'utf8')).toContain('Collection ID 只显式转交')
  })

  it('开发态官方归集 Skill 仅按既定精确哈希安全升级到候选版本', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const target = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
    // 只还原开发检查点版本头，固定旧哈希保证正文也与该检查点字节一致。
    const developmentSkill = officialAlpha16Skill.replace('version: 0.2.0-alpha.16-skill.1', 'version: 0.2.0-alpha.15-skill.3')
    const developmentHash = createHash('sha256').update(developmentSkill).digest('hex')
    expect(developmentHash).toBe('b8a6c458a002b6d50fbe0b13f7df02ba3ac29d932b6493c949d99e38a17ca47e')
    expect(OFFICIAL_MANAGED_SKILL_SHA256.has(developmentHash)).toBe(true)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, developmentSkill)

    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.18', new Date(), userHome)
    expect(result.skillDeployment).toMatchObject({ status: 'upgraded', previousSha256: developmentHash,
      sourceSha256: OFFICIAL_CURRENT_SKILL_SHA256 })
    expect(readFileSync(target, 'utf8')).toBe(canonicalSkill)
    expect(readFileSync(target, 'utf8')).toContain('version: 0.2.0-alpha.18-skill.1')
  })

  it('即使复制官方版本号和正文，未知自定义补充也不能被官方白名单覆盖', () => {
    const { root, payload } = fixture()
    const userHome = join(root, 'user')
    const target = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
    mkdirSync(join(target, '..'), { recursive: true })
    const customized = `${officialAlpha16Skill}\n用户自定义补充规则，必须保留。\n`
    writeFileSync(target, customized)
    expect(OFFICIAL_MANAGED_SKILL_SHA256.has(createHash('sha256').update(customized).digest('hex'))).toBe(false)
    expect(deployWorkBuddySkill(payload, userHome).status).toBe('preserved_custom')
    expect(readFileSync(target, 'utf8')).toBe(customized)
  })

  it('官方来源载荷哈希错误时拒绝部署，不改写已安装官方 Skill', () => {
    const { root, payload } = fixture()
    const userHome = join(root, 'user')
    const target = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, officialAlpha15Skill)
    writeFileSync(join(payload, 'skills', 'ingest-chat', 'SKILL.md'), `${canonicalSkill}\n不受管来源内容\n`)
    expect(() => deployWorkBuddySkill(payload, userHome)).toThrow('内容哈希不符合受保护契约')
    expect(readFileSync(target, 'utf8')).toBe(officialAlpha15Skill)
  })

  it('未知哈希或用户自定义 Skill 保留原文件并返回明确状态', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const target = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
    const customized = `---\nversion: ${WORKBUDDY_SKILL_VERSION}\n---\n# 用户自定义内容\n`
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, customized)

    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.15', new Date(), userHome)
    expect(result.skillDeployment.status).toBe('preserved_custom')
    expect(readFileSync(target, 'utf8')).toBe(customized)
  })

  it('Skill 原子写入失败时旧文件保持完整', () => {
    const { root, payload } = fixture()
    const userHome = join(root, 'user')
    const target = join(userHome, '.workbuddy', 'skills', 'privateradar-ingest-chat', 'SKILL.md')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, officialOldSkill)

    expect(() => deployWorkBuddySkill(payload, userHome, {
      atomicRename: () => { throw new Error('模拟原子替换失败') }
    })).toThrow('模拟原子替换失败')
    expect(readFileSync(target, 'utf8')).toBe(officialOldSkill)
  })

  it('会话投影移除 cwd 后仍使用绝对 MCP 服务入口', () => {
    const { root, payload, data } = fixture()
    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.3', new Date(), join(root, 'user'))
    const config = JSON.parse(readFileSync(result.registrationPath, 'utf8'))
    const projected = { ...config.mcpServers['privateradar-workbuddy'] }
    delete projected.cwd
    delete projected.runtime

    expect(projected.command).toBe('node')
    expect(projected.args[0]).toBe(join(result.connectorPath, 'dist', 'server.mjs'))
    expect(projected.args[0]).not.toBe('dist/server.mjs')
  })

  it('普通应用升级不改变连接配置也不重新要求信任', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const first = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    const firstConfig = readFileSync(join(first.connectorPath, 'mcp.json'), 'utf8')
    acknowledgeConnectorTrust(data)
    const upgraded = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.2', new Date(), userHome)
    expect(readFileSync(join(upgraded.connectorPath, 'mcp.json'), 'utf8')).toBe(firstConfig)
    expect(upgraded).toMatchObject({ requiresTrust: false, trustReason: 'none' })
    expect(upgraded.registrationChanged).toBe(false)
  })

  it('连接配置哈希真正变化时要求重新信任', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    acknowledgeConnectorTrust(data)
    const statePath = join(data, 'workbuddy', 'privateradar-workbuddy', 'install-state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    writeFileSync(statePath, `${JSON.stringify({ ...state, configHash: 'old-configuration' })}\n`)
    const changed = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.2', new Date(), userHome)
    expect(changed).toMatchObject({ requiresTrust: true, trustReason: 'configuration_changed' })
  })

  it('通过 WorkBuddy 用户目录检测已安装状态', () => {
    const { root } = fixture()
    const home = join(root, 'user')
    mkdirSync(join(home, '.workbuddy'), { recursive: true })
    expect(detectWorkBuddyInstalled(home, join(root, 'local'), join(root, 'programs'))).toBe(true)
    expect(detectWorkBuddyInstalled(join(root, 'empty'), join(root, 'local'), join(root, 'programs'))).toBe(false)
  })

  it('正式日志不保留密钥或令牌', () => {
    const { root } = fixture()
    const logs = join(root, 'logs')
    writeOperationalLog(logs, 'START_sk-secret-value', 'token=private-value')
    const content = readFileSync(join(logs, 'privateradar.log'), 'utf8')
    expect(content).not.toContain('sk-secret-value')
    expect(content).not.toContain('private-value')
    expect(content).toContain('REDACTED')
  })

  it('安装状态不会记录聊天正文', () => {
    const { root, payload, data } = fixture()
    prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), join(root, 'user'))
    const state = connectorSetupState(data)
    expect(Object.keys(state ?? {}).sort()).toEqual(['appVersion', 'configHash', 'connectorId', 'preparedAt', 'trustReason'].sort())
  })

  it('源文件缺失时不会误报准备成功', () => {
    const { root, payload, data } = fixture()
    rmSync(join(payload, 'dist', 'server.mjs'))
    expect(() => prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), join(root, 'user'))).toThrow('连接组件文件不完整')
  })

  it('目标文件损坏时最终完整性校验失败', () => {
    const { root, payload, data } = fixture()
    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), join(root, 'user'))
    writeFileSync(join(result.connectorPath, 'mcp.json'), '')
    expect(() => validateConnectorInstallation(result.connectorPath)).toThrow('连接组件文件不完整：mcp.json')
  })

  it('按官方用户级配置注册正式服务且保留其他服务', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const configPath = join(userHome, '.workbuddy', 'mcp.json')
    mkdirSync(join(userHome, '.workbuddy'), { recursive: true })
    const legacy = { type: 'stdio', command: 'legacy', disabled: true }
    writeFileSync(configPath, `${JSON.stringify({ mcpServers: { 'privateradar-local-spike': legacy } }, null, 2)}\n`)

    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.mcpServers['privateradar-local-spike']).toEqual(legacy)
    expect(config.mcpServers['privateradar-workbuddy'].cwd).toBe(result.connectorPath)
    expect(config.mcpServers['privateradar-workbuddy'].args).toContain(join(data, 'private-radar.db'))
    expect(isWorkBuddyConnectorRegistered(data, userHome)).toBe(true)
    expect(readFileSync(`${configPath}.privateradar-backup`, 'utf8')).toContain('privateradar-local-spike')
  })

  it('重复配置不重写正式注册且不依赖旧 Spike', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const first = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    const second = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    expect(first.registrationChanged).toBe(true)
    expect(second.registrationChanged).toBe(false)
    const config = JSON.parse(readFileSync(second.registrationPath, 'utf8'))
    expect(Object.keys(config.mcpServers)).toEqual(['privateradar-workbuddy'])
  })

  it('接受 WorkBuddy 信任后补充的 disabled false 且不反复改写', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const first = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    const config = JSON.parse(readFileSync(first.registrationPath, 'utf8'))
    config.mcpServers['privateradar-workbuddy'].disabled = false
    writeFileSync(first.registrationPath, `${JSON.stringify(config, null, 2)}\n`)

    expect(isWorkBuddyConnectorRegistered(data, userHome)).toBe(true)
    const repeated = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    expect(repeated.registrationChanged).toBe(false)
    expect(JSON.parse(readFileSync(first.registrationPath, 'utf8')).mcpServers['privateradar-workbuddy'].disabled).toBe(false)
  })

  it('WorkBuddy 用户配置损坏时拒绝覆盖且不报告注册成功', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const configPath = join(userHome, '.workbuddy', 'mcp.json')
    mkdirSync(join(userHome, '.workbuddy'), { recursive: true })
    writeFileSync(configPath, '{broken')
    expect(() => prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)).toThrow('WorkBuddy 用户配置格式无效')
    expect(readFileSync(configPath, 'utf8')).toBe('{broken')
  })

  it('正式配置已启用且存在信任记录时判定已连接', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    writeFileSync(join(userHome, '.workbuddy', 'mcp-approvals.json'), JSON.stringify({
      'approval-hash::privateradar-workbuddy': Date.now()
    }))
    expect(inspectWorkBuddyConnection(data, userHome)).toEqual({ connected: true, message: 'WorkBuddy 已连接。' })
  })

  it('正式配置关闭或未信任时返回明确原因', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    expect(inspectWorkBuddyConnection(data, userHome)).toMatchObject({ connected: false, message: expect.stringContaining('尚未') })
    const config = JSON.parse(readFileSync(result.registrationPath, 'utf8'))
    config.mcpServers['privateradar-workbuddy'].disabled = true
    writeFileSync(result.registrationPath, JSON.stringify(config))
    expect(inspectWorkBuddyConnection(data, userHome)).toEqual({ connected: false, message: 'PrivateRadar 在 WorkBuddy 中已关闭，请先启用。' })
  })

  it('路径错误或只有旧 Spike 不会误报正式连接', () => {
    const { root, payload, data } = fixture()
    const userHome = join(root, 'user')
    const result = prepareWorkBuddyConnector(payload, data, '0.2.0-alpha.1', new Date(), userHome)
    const approvalPath = join(userHome, '.workbuddy', 'mcp-approvals.json')
    writeFileSync(approvalPath, JSON.stringify({ 'approval-hash::privateradar-workbuddy': Date.now() }))
    const config = JSON.parse(readFileSync(result.registrationPath, 'utf8'))
    config.mcpServers['privateradar-workbuddy'].cwd = 'C:\\开发目录\\错误路径'
    writeFileSync(result.registrationPath, JSON.stringify(config))
    expect(inspectWorkBuddyConnection(data, userHome)).toMatchObject({ connected: false, message: expect.stringContaining('路径') })

    writeFileSync(result.registrationPath, JSON.stringify({ mcpServers: { 'privateradar-local-spike': { disabled: false } } }))
    writeFileSync(approvalPath, JSON.stringify({ 'old-hash::privateradar-local-spike': Date.now() }))
    expect(inspectWorkBuddyConnection(data, userHome)).toEqual({ connected: false, message: 'WorkBuddy 中尚未注册 PrivateRadar。' })
  })
})
