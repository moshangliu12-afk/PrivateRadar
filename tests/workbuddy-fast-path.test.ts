import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const skill = readFileSync(join(root, 'integrations', 'workbuddy', 'connector', 'skills', 'ingest-chat', 'SKILL.md'), 'utf8')
const packagedSkill = readFileSync(join(root, 'integrations', 'workbuddy', 'skill-package', 'privateradar-ingest-chat', 'SKILL.md'), 'utf8')
const adapterReadme = readFileSync(join(root, 'src', 'main', 'integrations', 'workbuddy', 'README.md'), 'utf8')
const metadata = JSON.parse(readFileSync(join(root, 'integrations', 'workbuddy', 'connector', 'connector-meta.json'), 'utf8')) as {
  source: string
  version: string
}
const mcpConfig = readFileSync(join(root, 'integrations', 'workbuddy', 'connector', 'mcp.json'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  build: { files: string[]; extraResources: Array<{ from: string; filter: string[] }> }
}

describe('WorkBuddy 微信导入最短路径', () => {
  it('Connector 内嵌 Skill 是 canonical source，两份内容字节级同步', () => {
    expect(packagedSkill).toBe(skill)
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 使用 alpha.16-skill.1 的单卡和双卡正式契约', (_label, content) => {
    expect(content).toContain('version: 0.2.0-alpha.16-skill.1')
    expect(content).toContain('privateradar_ingest_messages')
    expect(content).toContain('privateradar_ingest_current_context_batch')
    expect(content).toContain('只调用一次')
    expect(content).toContain('本次 current input 真实提供的全部 raw context blocks')
    expect(content).toContain('不按 raw context 数量判断附件数')
    for (const field of ['file', 'extracted_dir_path', 'message_count', 'transcript',
      'first_sender', 'first_message_at', 'truncated']) expect(content).toContain(`\`${field}\``)
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 明确禁止旧批量入口、路径猜测、记忆副作用与失败重试', (_label, content) => {
    const legacyLines = content.split(/\r?\n/).filter((line) => line.includes('privateradar_ingest_batch'))
    expect(legacyLines).toEqual(['- 禁止调用 `privateradar_ingest_batch`。'])
    expect(content).toContain('禁止把双卡片拆成两次 `privateradar_ingest_messages`')
    expect(content).toContain('禁止自行生成双卡片 `messages` 数组')
    expect(content).toContain('禁止自行去重 raw contexts')
    expect(content).toContain('禁止读取 `聊天记录.txt`')
    for (const command of ['ls', 'dir', 'glob', 'find']) expect(content).toContain(`\`${command}\``)
    expect(content).toContain('扫描 `chat-history`')
    expect(content).toContain('newest file')
    expect(content).toContain('newest directory')
    expect(content).toContain('filename → path guess')
    expect(content).toContain('mtime guess')
    expect(content).toContain('timestamp guess')
    expect(content).toContain('历史附件、历史对话或日志')
    expect(content).toContain('猜测 ZIP path')
    expect(content).toContain('`MEMORY.md`')
    expect(content).toContain('WorkBuddy memory')
    expect(content).toContain('daily memory')
    expect(content).toContain('禁止自动 retry batch')
    expect(content).toContain('第一次批量调用失败后')
    expect(content).toContain('立即停止，只报告 Tool 返回的真实错误')
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 保持可靠时间与缺失元数据语义', (_label, content) => {
    expect(content).toContain('timestamp_source: source_native')
    expect(content).toContain('timestamp_source: user_supplied')
    expect(content).toContain('imported_at')
    expect(content).toContain('当前时间')
    expect(content).toContain('没有可靠逐条时间时')
    expect(content).toContain('system interpretation')
    expect(content).toContain('不能称为原文提供的时区')
    expect(content).toContain('禁止根据正文、人名、机构、地点、文件名或聊天主题补造')
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 只转交当前明确的完整归集身份，不猜测、不回溯、不降级单卡', (_label, content) => {
    expect(content).toContain('本轮当前用户输入明确提供 `Collection <完整 UUID>`')
    expect(content).toContain('本次规范输入明确给出 `collection_id`')
    expect(content).toContain('原样传给 `privateradar_ingest_current_context_batch.collection_id`')
    expect(content).toContain('用户本轮没有显式提供时，省略 `collection_id`')
    expect(content).toContain('禁止从旧聊天轮次寻找 Collection ID')
    expect(content).toContain('禁止从最近一次导入复用')
    expect(content).toContain('禁止从名称、群名、时间、正文或 PrivateRadar 当前页面状态猜测')
    expect(content).toContain('禁止修复、截断或补全 UUID')
    expect(content).toContain('COLLECTION_NOT_SUPPORTED_FOR_SINGLE_IMPORT')
    expect(content).toContain('不得降级成普通导入，不得自动转换成双卡链')
    expect(content).toContain('恰好两个 logical attachments，不支持 N 卡')
  })

  it('正式 README 说明确定性格式并同时给出有时间和缺时间 payload', () => {
    expect(adapterReadme).toContain('调用 Tool 前必须先检查')
    expect(adapterReadme).toContain('2026-09-20T12:02:00+08:00')
    expect(adapterReadme).toContain('没有可靠逐条时间时')
    expect(adapterReadme).toContain('YYYY-MM-DD HH:mm[:ss]')
    expect(adapterReadme).toContain('不正式承诺中文自然语言日期、Unix 数字时间或其他模糊格式')
  })

  it('升级只改变内容版本，不改变正式 Connector ID 或启动配置', () => {
    expect(metadata).toMatchObject({ source: 'privateradar-workbuddy', version: '0.2.0-alpha.18' })
    expect(mcpConfig).toContain('privateradar-workbuddy')
    expect(mcpConfig).toContain('dist/server.mjs')
    expect(mcpConfig).not.toContain('privateradar-local-spike')
  })

  it('installer 只打包应用与 Connector 正式负载，不包含测试、历史 Skill ZIP 或验收数据', () => {
    const includedFiles = packageJson.build.files.filter((pattern) => !pattern.startsWith('!'))
    expect(includedFiles).toEqual(['out/**/*', 'package.json'])
    expect(packageJson.build.extraResources).toEqual([{
      from: 'integrations/workbuddy/connector',
      to: 'workbuddy-connector',
      filter: ['connector-meta.json', 'mcp.json', 'icon.svg', 'skills/**/*', 'dist/server.mjs']
    }])
    expect(JSON.stringify({ ...packageJson.build, files: includedFiles })).not.toMatch(/tests|fixtures|acceptance|\.zip|private-radar\.db|backup|rollback/i)
  })
})
