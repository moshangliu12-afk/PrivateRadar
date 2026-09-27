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

describe('WorkBuddy 微信导入最短路径', () => {
  it('Skill 明确默认快速导入、缺失群名不阻塞且禁止脚本兜底', () => {
    expect(skill).toContain('快速导入是默认模式')
    expect(skill).toContain('群名缺失时省略')
    expect(skill).toContain('直接省略对应字段')
    expect(skill).toContain('禁止寻找或使用脚本、Harness、stdio、JSON-RPC')
    expect(skill).toContain('Tool 成功后只回复整次导入')
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 明确单附件、双附件和超量边界', (_label, content) => {
    expect(content).toContain('privateradar_ingest_messages')
    expect(content).toContain('privateradar_ingest_batch')
    expect(content).toContain('超过两个')
    expect(content).toContain('当前 alpha.15 批量入口只支持同次两个聊天附件')
    expect(content).toContain('群名缺失')
    expect(content).toContain('不合并')
    expect(content).toContain('chat-history')
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 禁止路径缺失时发现文件及导入后写记忆', (_label, content) => {
    expect(content).toContain('当前附件真实路径不可用')
    expect(content).toContain('当前附件真实路径不可用，未执行导入。')
    expect(content).toContain('停止导入')
    expect(content).toMatch(/(?:禁止|不得)列举或扫描 `chat-history`/)
    expect(content).toContain('搜索相似文件名')
    expect(content).toContain('寻找最新 ZIP')
    expect(content).toContain('按时间戳推断路径')
    expect(content).toContain('读取历史附件补救')
    expect(content).toContain('附件元数据')
    expect(content).toContain('`chipId` / `attachment_id`')
    expect(content).toContain('正式授权的当前附件路径解析能力')
    expect(content).toContain('不得自行使用标识找文件')
    expect(content).toContain('`join(chatHistoryRoot, displayFilename)`')
    expect(content).toContain('`MEMORY.md`')
    expect(content).toContain('WorkBuddy memory')
    expect(content).toContain('当日记忆文件')
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 要求先检查逐条时间且不伪造', (_label, content) => {
    expect(content).toContain('调用前的逐条时间检查（必须）')
    expect(content).toContain('快速导入表示少交互、快速完成，不表示忽略材料中已经存在的时间')
    expect(content).toContain('timestamp_source: source_native')
    expect(content).toContain('timestamp_source: user_supplied')
    expect(content).toContain('快速模式不以追问用户补时间为前置条件')
    expect(content).toContain('approximate_date')
    expect(content).toContain('imported_at')
    expect(content).toContain('当前时间')
    expect(content).toContain('人工生成等间隔时间')
    expect(content).toContain('2026-09-20T12:02:00+08:00')
    expect(content).toContain('没有可靠逐条时间')
  })

  it('正式 README 说明确定性格式并同时给出有时间和缺时间 payload', () => {
    expect(adapterReadme).toContain('调用 Tool 前必须先检查')
    expect(adapterReadme).toContain('2026-09-20T12:02:00+08:00')
    expect(adapterReadme).toContain('没有可靠逐条时间时')
    expect(adapterReadme).toContain('YYYY-MM-DD HH:mm[:ss]')
    expect(adapterReadme).toContain('不正式承诺中文自然语言日期、Unix 数字时间或其他模糊格式')
  })

  it('升级只改变内容版本，不改变正式 Connector ID 或启动配置', () => {
    expect(metadata).toMatchObject({ source: 'privateradar-workbuddy', version: '0.2.0-alpha.4' })
    expect(mcpConfig).toContain('privateradar-workbuddy')
    expect(mcpConfig).toContain('dist/server.mjs')
    expect(mcpConfig).not.toContain('privateradar-local-spike')
  })
})
