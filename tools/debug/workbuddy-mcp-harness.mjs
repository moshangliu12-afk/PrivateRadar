import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const outputRoot = resolve(process.argv[2] ?? join(tmpdir(), 'privateradar-workbuddy-spike'))
mkdirSync(outputRoot, { recursive: true })
const runDir = mkdtempSync(join(outputRoot, 'local-mcp-'))
const databasePath = join(runDir, 'private-radar.db')
const serverPath = resolve('integrations/workbuddy/connector/dist/server.mjs')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--database', databasePath],
  cwd: process.cwd(),
  stderr: 'pipe'
})
const client = new Client({ name: 'privateradar-debug-harness', version: '0.2.0' })

const messages = [
  {
    platform: 'wechat',
    conversation_name: 'AI开发群',
    sender_name: '张三',
    timestamp: '2026-09-13T09:00:00+08:00',
    content: 'Claude Code 今天发布新功能。',
    source_message_id: 'harness-001'
  },
  {
    platform: 'wechat',
    conversation_name: 'AI开发群',
    sender_name: '李四',
    timestamp: '2026-09-13T09:01:00+08:00',
    content: '我刚刚也测试了新版。',
    source_message_id: 'harness-002'
  },
  {
    platform: 'wechat',
    conversation_name: 'AI开发群',
    sender_name: '王五',
    timestamp: '2026-09-13T09:02:00+08:00',
    content: 'GitHub 地址是 https://github.com/example/claude-code-demo',
    source_message_id: 'harness-003'
  },
  {
    platform: 'wechat',
    conversation_name: 'AI开发群',
    sender_name: '赵六',
    timestamp: '2026-09-13T09:03:00+08:00',
    content: '稍后整理测试结论。'
  },
  {
    platform: 'wechat',
    conversation_name: 'AI开发群',
    sender_name: '坏数据'
  }
]

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const first = await client.callTool({ name: 'privateradar_ingest_messages', arguments: { messages } })
  const second = await client.callTool({ name: 'privateradar_ingest_messages', arguments: { messages } })
  await client.close()

  const db = new DatabaseSync(databasePath)
  const stored = db.prepare('SELECT COUNT(*) AS count FROM messages').get()
  const fts = db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'GitHub'").get()
  const standard = db.prepare(`
    SELECT platform, conversation_name, sender_name, timestamp, content, links_json, source_message_id, fingerprint
    FROM messages ORDER BY timestamp
  `).all()
  db.close()

  process.stdout.write(`${JSON.stringify({
    databasePath,
    tools: tools.tools.map((tool) => tool.name),
    first: first.structuredContent,
    second: second.structuredContent,
    storedCount: stored.count,
    ftsCount: fts.count,
    standardMessages: standard
  }, null, 2)}\n`)
} catch (error) {
  await client.close().catch(() => undefined)
  throw error
}
