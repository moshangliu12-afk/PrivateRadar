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

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 使用 alpha.18-skill.1 的单卡和双卡统一原始来源契约', (_label, content) => {
    expect(content).toContain('version: 0.2.0-alpha.18-skill.1')
    expect(content).toContain('单卡与双卡统一入口')
    expect(content).toContain('privateradar_ingest_current_context_batch')
    expect(content).toContain('只调用一次')
    expect(content).toContain('本次当前输入真实提供的全部原始上下文块')
    expect(content).toContain('不按原始上下文数量判断附件数')
    expect(content).toContain('只接受一个或两个逻辑附件')
    expect(content).toContain('不为凑足数组数量复制或删除块')
    for (const field of ['file', 'extracted_dir_path', 'message_count', 'transcript',
      'first_sender', 'first_message_at', 'truncated']) expect(content).toContain(`\`${field}\``)
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 明确禁止旧批量入口、路径猜测、记忆副作用与失败重试', (_label, content) => {
    const legacyLines = content.split(/\r?\n/).filter((line) => line.includes('privateradar_ingest_batch'))
    expect(legacyLines).toEqual(['- 禁止调用 `privateradar_ingest_batch`。'])
    expect(content).toContain('禁止调用 `privateradar_ingest_messages`，禁止仅传规范消息的降级')
    expect(content).toContain('禁止把双卡片拆成两个调用')
    expect(content).toContain('禁止自行生成 `messages` 数组')
    expect(content).toContain('禁止自行去重原始上下文')
    expect(content).toContain('禁止读取 `聊天记录.txt`')
    for (const command of ['ls', 'dir', 'glob', 'find']) expect(content).toContain(`\`${command}\``)
    expect(content).toContain('扫描 `chat-history`')
    expect(content).toContain('禁止寻找最新文件或目录')
    expect(content).toContain('显示文件名、修改时间或聊天时间猜测路径')
    expect(content).toContain('历史附件、历史对话或日志')
    expect(content).toContain('猜测 ZIP 路径')
    expect(content).toContain('`MEMORY.md`')
    expect(content).toContain('WorkBuddy 记忆')
    expect(content).toContain('每日记忆')
    expect(content).toContain('禁止自动重试')
    expect(content).toContain('第一次调用失败后')
    expect(content).toContain('立即停止，只报告工具返回的真实错误')
    expect(content).toContain('禁止回溯旧的单卡消息补造附件项、原始证据、来源关联或承诺候选')
  })

  it.each([['Connector Skill', skill], ['Skill 包', packagedSkill]] as const)('%s 保持可靠时间与缺失元数据语义', (_label, content) => {
    expect(content).toContain('`source_native`')
    expect(content).toContain('`user_supplied`')
    expect(content).toContain('imported_at')
    expect(content).toContain('当前时间')
    expect(content).toContain('没有可靠逐条时间时')
    expect(content).toContain('当前解析器拒绝输入')
    expect(content).toContain('不能省略时间后改走旧单卡入口')
    expect(content).toContain('仅是系统解释')
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
    expect(content).toContain('仅两个逻辑附件支持归集，不支持单卡归集或任意数量卡片')
    expect(content).toContain('不移除归集编号后再次调用')
    expect(content).toContain('当前上下文入口保持快速导入，不增加 `complete`')
  })

  it('适配器文档区分原始来源正式入口与保留的内部旧消息格式', () => {
    expect(adapterReadme).toContain('单卡与双卡统一')
    expect(adapterReadme).toContain('公开旧入口无写入拒绝')
    expect(adapterReadme).toContain('内部兼容的规范消息格式')
    expect(adapterReadme).toContain('不扩展 `complete`')
    expect(adapterReadme).toContain('2026-09-20T12:02:00+08:00')
    expect(adapterReadme).toContain('没有可靠逐条时间时')
    expect(adapterReadme).toContain('YYYY-MM-DD HH:mm[:ss]')
    expect(adapterReadme).toContain('不正式承诺中文自然语言日期、Unix 数字时间或其他模糊格式')
  })

  it('升级只改变内容版本，不改变正式 Connector ID 或启动配置', () => {
    expect(metadata).toMatchObject({ source: 'privateradar-workbuddy', version: '0.2.0-alpha.19' })
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
