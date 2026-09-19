import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const databasePath = resolve(process.argv[2])
const serverPath = resolve(process.argv[3] ?? 'integrations/workbuddy/connector/dist/server.mjs')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--database', databasePath],
  stderr: 'pipe'
})
const client = new Client({ name: 'privateradar-first-use-qa', version: '0.2.0' })
await client.connect(transport)
const result = await client.callTool({
  name: 'privateradar_ingest_messages',
  arguments: {
    import_mode: 'quick',
    source_batch_id: '真实界面验收-1',
    batch_metadata: { conversation_name: '首次体验测试群', conversation_name_source: 'user_supplied' },
    messages: [
      { content: 'PrivateIndex 可以在本地索引聊天记录。', source_position: 0 },
      { content: '项目地址：https://github.com/example/private-index', source_position: 1 },
      { content: 'Claude Code 新版的开发体验不错。', source_position: 2 }
    ]
  }
})
process.stdout.write(`${JSON.stringify(result.structuredContent)}\n`)
await client.close()
