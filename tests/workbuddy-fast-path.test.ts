import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const skill = readFileSync(join(root, 'integrations', 'workbuddy', 'connector', 'skills', 'ingest-chat', 'SKILL.md'), 'utf8')
const metadata = JSON.parse(readFileSync(join(root, 'integrations', 'workbuddy', 'connector', 'connector-meta.json'), 'utf8')) as {
  source: string
  version: string
}
const mcpConfig = readFileSync(join(root, 'integrations', 'workbuddy', 'connector', 'mcp.json'), 'utf8')

describe('WorkBuddy 微信导入最短路径', () => {
  it('Skill 明确默认快速导入、未知字段省略且禁止脚本兜底', () => {
    expect(skill).toContain('快速导入是默认模式')
    expect(skill).toContain('若群名缺失，只问一次')
    expect(skill).toContain('直接省略对应字段')
    expect(skill).toContain('禁止寻找或使用脚本、Harness、stdio、JSON-RPC')
    expect(skill).toContain('Tool 成功后只回复一到两句')
  })

  it('升级只改变内容版本，不改变正式 Connector ID 或启动配置', () => {
    expect(metadata).toMatchObject({ source: 'privateradar-workbuddy', version: '0.2.0-alpha.4' })
    expect(mcpConfig).toContain('privateradar-workbuddy')
    expect(mcpConfig).toContain('dist/server.mjs')
    expect(mcpConfig).not.toContain('privateradar-local-spike')
  })
})
