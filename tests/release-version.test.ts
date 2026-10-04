import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import product from '../package.json'
import lockfile from '../package-lock.json'
import metadata from '../integrations/workbuddy/connector/connector-meta.json'
import { initializeDatabase } from '../src/main/schema'
import { getFirstUseStatus } from '../src/main/first-use'
import { createWorkBuddyMcpServer } from '../src/main/integrations/workbuddy/tool'

vi.mock('../src/main/deployment', () => ({
  acknowledgeConnectorTrust: vi.fn(),
  connectorSetupState: () => null,
  detectWorkBuddyInstalled: () => false,
  inspectWorkBuddyConnection: () => ({ connected: false, message: '隔离测试未连接' }),
  isWorkBuddyConnectorRegistered: () => false
}))

// 桌面 alpha.15.2 携带性能优化载荷；Connector 与 MCP 升至 alpha.15.1，Skill 内容未变。
// 各组件保护明确的独立版本，不要求所有组件版本相等，也不接受任意版本。
const productVersion = '0.2.0-alpha.15.2'
const connectorVersion = '0.2.0-alpha.15.1'
const mcpVersion = '0.2.0-alpha.15.1'
const skillVersion = '0.2.0-alpha.15-skill.3'
const readSource = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('alpha.15.2 性能优化发布的独立组件版本契约', () => {
  it('产品与 lockfile 顶层和根包版本一致', () => {
    expect(product.version).toBe(productVersion)
    expect(lockfile.version).toBe(productVersion)
    expect(lockfile.packages[''].version).toBe(productVersion)
  })

  it('Connector 元数据明确为 alpha.15.1，不与桌面版本混同', () => {
    expect(metadata.version).toBe(connectorVersion)
  })

  it('内存 MCP 握手明确为 alpha.15.1 且只公开正式双工具', async () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    const server = createWorkBuddyMcpServer(db, undefined, { databasePath: ':memory:' })
    const client = new Client({ name: '版本隔离测试', version: productVersion })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      expect(client.getServerVersion()?.version).toBe(mcpVersion)
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'privateradar_ingest_current_context_batch',
        'privateradar_ingest_messages'
      ])
    } finally {
      await client.close()
      await server.close()
      db.close()
    }
  })

  it('两份 Skill 字节同步并保持 skill.3 而非产品版本', () => {
    const connector = readFileSync(new URL('../integrations/workbuddy/connector/skills/ingest-chat/SKILL.md', import.meta.url))
    const packaged = readFileSync(new URL('../integrations/workbuddy/skill-package/privateradar-ingest-chat/SKILL.md', import.meta.url))
    expect(connector.equals(packaged)).toBe(true)
    expect(createHash('sha256').update(connector).digest('hex'))
      .toBe('1cedc0cac81aa74869874f50c02c5b6c9d0a7e6d66f44ab8ac004054c3e90f0e')
    expect(connector.toString('utf8')).toMatch(new RegExp(`^version: ${skillVersion.replaceAll('.', '\\.')}$`, 'm'))
  })

  it('first-use 未传版本时读取产品版本且不访问正式部署目录', () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    try {
      expect(getFirstUseStatus(db, ':memory:').appVersion).toBe(product.version)
    } finally {
      db.close()
    }
  })

  it('first-use 仍优先使用显式传入的运行应用版本', () => {
    const db = new DatabaseSync(':memory:')
    initializeDatabase(db)
    try {
      expect(getFirstUseStatus(db, ':memory:', new Date(), '0.2.0-alpha.14.1').appVersion).toBe('0.2.0-alpha.14.1')
    } finally {
      db.close()
    }
  })

  it('设置页版本仍来自 app.getVersion 经状态接口传递', () => {
    expect(readSource('../src/main/index.ts')).toContain("ipcMain.handle('experience:get-status', () => getFirstUseStatus(db, databasePath, new Date(), app.getVersion()))")
    expect(readSource('../src/renderer/src/App.tsx')).toContain('{status.appVersion}')
  })

  it('安装包命名由产品版本推导但不制作安装包', () => {
    expect(product.build.win.artifactName).toBe('PrivateRadar-Setup-${version}-x64.${ext}')
    const artifact = product.build.win.artifactName.replace('${version}', product.version).replace('${ext}', 'exe')
    expect(artifact).toBe('PrivateRadar-Setup-0.2.0-alpha.15.2-x64.exe')
  })
})
