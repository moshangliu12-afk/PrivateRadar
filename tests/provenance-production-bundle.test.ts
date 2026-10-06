import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { listItemMessageSources, listMessageSources } from '../src/main/batch-import/message-sources'

it('真实生产主进程入口可执行双向来源查询，不注册额外通信入口', () => {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-production-provenance-'))
  const databasePath = join(directory, 'private-radar.db')
  const output = join(directory, 'out')
  const db = new DatabaseSync(databasePath)
  try {
    initializeDatabase(db)
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(7)
    const session = createBatchImportSession(db, 'workbuddy')
    const items = [createBatchImportItem(db, session.id, 0), createBatchImportItem(db, session.id, 1)]
    for (const [ordinal, numbers] of [[0, [1, 2]], [1, [2]]] as const) {
      const item = items[ordinal], sourceBatchId = `workbuddy:item:${item.id}`
      db.prepare('UPDATE batch_import_items SET source_batch_id=? WHERE id=?').run(sourceBatchId, item.id)
      const result = ingestWorkBuddyMessages(db, { messages: numbers.map(number => ({
        content: `隔离消息${number}`, source_message_id: `原生身份${number}`,
        platform: 'wechat', conversation_name: '隔离群', sender_name: '隔离发送人'
      })) }, 0, { batchItemId: item.id, sourceBatchId })
      expect(result.status).toBe('success')
    }
    const a = listItemMessageSources(db, items[0].id)
    const b = listItemMessageSources(db, items[1].id)
    expect(a.map(row => row.source_position)).toEqual([0, 1])
    expect(b.map(row => row.source_position)).toEqual([0])
    expect(a[1].message_id).toBe(b[0].message_id)
    const expected = { a, b, sources: listMessageSources(db, a[1].message_id) }
    // 使用项目原有生产配置和默认裁剪；产物单独保存，不依赖既有输出或源码加载器。
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules/electron-vite/bin/electron-vite.js'),
      'build', '--outDir', output], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 })
    // 仅隔离桌面启动外壳；完整编译产物原样加载，两个查询实现不替换、不提取、不重新编译。
    const program = `
      import { registerHooks } from 'node:module';
      import { DatabaseSync } from 'node:sqlite';
      let communicationCount = 0;
      registerHooks({
        resolve(specifier, context, next) {
          if (specifier === 'electron') return { url: 'isolated:electron', shortCircuit: true };
          // 临时输出不含依赖副本；仍使用项目真实运行依赖，不替换任何查询实现。
          if (specifier === 'zod') return next(specifier, { ...context,
            parentURL: ${JSON.stringify(pathToFileURL(join(process.cwd(), 'package.json')).href)} });
          return next(specifier, context);
        },
        load(url, context, next) {
          if (url !== 'isolated:electron') return next(url, context);
          return { format: 'module', shortCircuit: true, source: \`
            export const app = { setName() {}, whenReady() { return new Promise(() => {}); }, on() {} };
            export const ipcMain = { handle() { globalThis.__communicationCount++; } };
            export const BrowserWindow = class { constructor() { throw new Error('禁止启动窗口'); } };
            export const dialog = {}, Menu = {}, shell = {};
          \` };
        }
      });
      globalThis.__communicationCount = communicationCount;
      const runtime = await import(${JSON.stringify(pathToFileURL(join(output, 'main/index.js')).href)});
      const database = new DatabaseSync(${JSON.stringify(databasePath)}, { readOnly: true });
      try {
        console.log(JSON.stringify({
          a: runtime.listItemMessageSources(database, ${JSON.stringify(items[0].id)}),
          b: runtime.listItemMessageSources(database, ${JSON.stringify(items[1].id)}),
          sources: runtime.listMessageSources(database, ${JSON.stringify(a[1].message_id)}),
          communicationCount: globalThis.__communicationCount,
          exports: Object.keys(runtime).sort()
        }));
      } finally { database.close(); }
    `
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', program], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000
    }))
    expect(result).toEqual({ ...expected, communicationCount: 0,
      exports: ['listItemMessageSources', 'listMessageSources'] })
    expect(Object.keys(result.a[0]).sort()).toEqual(['batch_item_id', 'created_at', 'message_id',
      'source_conversation_name', 'source_conversation_name_source', 'source_position',
      'source_sender_name', 'source_sender_name_source', 'source_timestamp', 'source_timestamp_source'])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 180_000)
