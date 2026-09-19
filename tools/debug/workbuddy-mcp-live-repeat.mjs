import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const databasePath = resolve('../../work/workbuddy-spike/workbuddy-live/private-radar.db')
const serverPath = resolve('integrations/workbuddy/connector/dist/server.mjs')
const messages = [
  { platform: 'wechat', conversation_name: 'AI开发群', sender_name: '张三', timestamp: '2026-09-13T10:00:00+08:00', content: 'Claude Code 今天发布新功能。', source_message_id: 'workbuddy-live-001' },
  { platform: 'wechat', conversation_name: 'AI开发群', sender_name: '李四', timestamp: '2026-09-13T10:01:00+08:00', content: '我刚刚也测试了新版。', source_message_id: 'workbuddy-live-002' },
  { platform: 'wechat', conversation_name: 'AI开发群', sender_name: '王五', timestamp: '2026-09-13T10:02:00+08:00', content: 'GitHub 地址是 https://github.com/example/workbuddy-claude-spike', source_message_id: 'workbuddy-live-003' },
  { platform: 'wechat', conversation_name: 'AI开发群', sender_name: '赵六', timestamp: '2026-09-13T10:03:00+08:00', content: '稍后整理测试结论。', source_message_id: 'workbuddy-live-004' }
]

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--database', databasePath], stderr: 'pipe' })
const client = new Client({ name: 'privateradar-debug-live-repeat', version: '0.2.0' })
await client.connect(transport)
const result = await client.callTool({ name: 'privateradar_ingest_messages', arguments: { messages } })
await client.close()

const db = new DatabaseSync(databasePath, { readOnly: true })
const count = db.prepare('SELECT COUNT(*) AS count FROM messages').get()
const fts = db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH 'workbuddy'").get()
const rows = db.prepare('SELECT conversation_name, sender_name, timestamp, content, links_json, source_message_id FROM messages ORDER BY timestamp').all()
const quickCheck = db.prepare('PRAGMA quick_check').get()
db.close()
process.stdout.write(`${JSON.stringify({ result: result.structuredContent, count: count.count, fts: fts.count, rows, quickCheck }, null, 2)}\n`)
