import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { migrateBatchImportSchema } from '../src/main/batch-import/schema'
import { createBatchImportItem, createBatchImportSession, attachImportJobToBatchItem } from '../src/main/batch-import/repository'
import { importChatContent } from '../src/main/import/importer'
import { listItemMessageSources } from '../src/main/batch-import/message-sources'

const fixtures: Array<{db: DatabaseSync; directory: string}> = []
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); rmSync(f.directory, {recursive:true,force:true}) } })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function legacyFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-provenance-migration-'))
  const db = new DatabaseSync(join(directory, 'private-radar.db'))
  fixtures.push({db,directory})
  initializeDatabase(db)
  db.exec('DROP TABLE batch_item_message_sources; PRAGMA user_version = 5')
  const items: Array<{id:string; path:string; sourceBatchId:string}> = []
  for (let round=0;round<6;round++) {
    const session = createBatchImportSession(db,'workbuddy')
    for (let ordinal=0;ordinal<2;ordinal++) {
      const item = createBatchImportItem(db,session.id,ordinal)
      const sourceBatchId = `workbuddy:item:${item.id}`
      const messages = Array.from({length:items.length===11?10:6},(_,position)=>({
        platform:'wechat',conversation_name:'隔离群',sender_name:'隔离发送人',
        timestamp:'2026-10-04T09:00:00+08:00',content:`oldfts 历史 ${items.length}-${position}`,source_position:position
      }))
      const result = importChatContent(db,'历史.json','JSON',JSON.stringify({messages}),{sourceBatchId})
      expect(result.status).toBe('success')
      attachImportJobToBatchItem(db,result.jobId,item.id)
      const path = join(directory,'evidence',item.id,'messages.json')
      mkdirSync(join(path,'..'),{recursive:true})
      const bytes = JSON.stringify({schema_version:1,input:{messages}})
      writeFileSync(path,bytes)
      db.prepare(`UPDATE batch_import_items SET source_batch_id=?,snapshot_relative_path=?,snapshot_sha256=?,
        evidence_status='available',status='success',effective_job_id=? WHERE id=?`)
        .run(sourceBatchId,`evidence/${item.id}/messages.json`,hash(bytes),result.jobId,item.id)
      items.push({id:item.id,path,sourceBatchId})
    }
  }
  const old = Array.from({length:205},(_,index)=>({conversation_name:'旧式群',sender_name:'旧式发送人',timestamp:'2026-10-01 09:00',content:`oldfts 无附件 ${index}`}))
  expect(importChatContent(db,'旧式.json','JSON',JSON.stringify(old)).importedCount).toBe(205)
  return {db,directory,items}
}

function fingerprints(db: DatabaseSync) {
  const tables = db.prepare('PRAGMA table_list').all()
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .filter(row=>row.name!=='batch_item_message_sources').map(row=>{
      const withoutRowid = tables.find(table => table.name === row.name)?.wr === 1
      const rows=db.prepare(`SELECT ${withoutRowid ? '' : 'rowid, '}* FROM "${String(row.name)}"`).all()
        .map(value => JSON.stringify(value,(_key,entry)=>entry instanceof Uint8Array?Buffer.from(entry).toString('hex'):entry)).sort()
      return [String(row.name),hash(JSON.stringify(rows,(_key,value)=>value instanceof Uint8Array?Buffer.from(value).toString('hex'):value))]
    }))
}

function changeSnapshot(f: ReturnType<typeof legacyFixture>, edit: (messages: Array<Record<string,unknown>>) => void) {
  const item=f.items[0]
  const payload=JSON.parse(readFileSync(item.path,'utf8'))
  edit(payload.input.messages)
  const bytes=JSON.stringify(payload)
  writeFileSync(item.path,bytes)
  f.db.prepare('UPDATE batch_import_items SET snapshot_sha256=? WHERE id=?').run(hash(bytes),item.id)
}

describe('结构版本 6 确定性来源回填',()=>{
  it('281 条历史中只回填可核验的 76 条，其余 205 条不伪造 Item 或关系，所有旧表及 FTS 不变',()=>{
    const f=legacyFixture(),before=fingerprints(f.db),evidence=f.items.map(item=>hash(readFileSync(item.path)))
    migrateBatchImportSchema(f.db)
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual({user_version:6})
    expect(f.db.prepare('SELECT count(*) AS n FROM batch_item_message_sources').get()).toEqual({n:76})
    expect(f.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({n:281})
    expect(f.db.prepare('SELECT count(*) AS n FROM messages_fts').get()).toEqual({n:281})
    expect(f.db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'oldfts'").get()).toEqual({n:281})
    expect(fingerprints(f.db)).toEqual(before)
    expect(f.items.map(item=>hash(readFileSync(item.path)))).toEqual(evidence)
    expect(f.items.map(item=>listItemMessageSources(f.db,item.id).length)).toEqual([...Array(11).fill(6),10])
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'})
    migrateBatchImportSchema(f.db)
    expect(f.db.prepare('SELECT count(*) AS n FROM batch_item_message_sources').get()).toEqual({n:76})
  })

  it.each(['多个Item','位置冲突','正文不同','快照哈希不同','快照位置不同','快照缺失','关系冲突'] as const)('%s 时原子回滚，版本仍为 5，旧消息和 FTS 原样保留',kind=>{
    const f=legacyFixture()
    if(kind==='多个Item') f.db.prepare('UPDATE batch_import_items SET source_batch_id=? WHERE id=?').run(f.items[0].sourceBatchId,f.items[1].id)
    if(kind==='位置冲突') f.db.prepare('UPDATE messages SET source_position=0 WHERE source_batch_id=?').run(f.items[0].sourceBatchId)
    if(kind==='正文不同') changeSnapshot(f,messages=>{messages[0].content='不一致正文'})
    if(kind==='快照哈希不同') writeFileSync(f.items[0].path,'{}')
    if(kind==='快照位置不同') changeSnapshot(f,messages=>{messages[0].source_position=8})
    if(kind==='快照缺失') rmSync(f.items[0].path)
    if(kind==='关系冲突') {
      f.db.exec(`CREATE TABLE batch_item_message_sources (
        batch_item_id TEXT NOT NULL REFERENCES batch_import_items(id) ON DELETE RESTRICT,
        source_position INTEGER NOT NULL CHECK(source_position>=0),
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,PRIMARY KEY(batch_item_id,source_position))`)
      const wrong=f.db.prepare('SELECT id FROM messages WHERE source_batch_id=? AND source_position=1').get(f.items[0].sourceBatchId)!
      f.db.prepare('INSERT INTO batch_item_message_sources VALUES (?,0,?,?)').run(f.items[0].id,String(wrong.id),'原记录')
    }
    const before=fingerprints(f.db)
    expect(()=>migrateBatchImportSchema(f.db)).toThrow()
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual({user_version:5})
    expect(fingerprints(f.db)).toEqual(before)
    expect(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='batch_item_message_sources'").get()).toEqual({n:kind==='关系冲突'?1:0})
    if(kind==='关系冲突')expect(f.db.prepare('SELECT count(*) AS n FROM batch_item_message_sources').get()).toEqual({n:1})
  })

  it('新库表结构只有四字段、两个限制删除外键、位置主键和反查索引',()=>{
    const db=new DatabaseSync(':memory:')
    try {
      initializeDatabase(db)
      expect(db.prepare('PRAGMA table_info(batch_item_message_sources)').all().map(row=>[row.name,row.pk])).toEqual([
        ['batch_item_id',1],['source_position',2],['message_id',0],['created_at',0]])
      expect(db.prepare('PRAGMA foreign_key_list(batch_item_message_sources)').all()).toEqual(expect.arrayContaining([
        expect.objectContaining({table:'messages',on_delete:'RESTRICT'}),expect.objectContaining({table:'batch_import_items',on_delete:'RESTRICT'})]))
      expect(db.prepare('PRAGMA index_info(idx_batch_item_message_sources_message)').all().map(row=>row.name)).toEqual(['message_id'])
    } finally {db.close()}
  })

  it('已有错误来源表不能借助幂等建表绕过迁移契约，整体保持版本 5',()=>{
    const f=legacyFixture()
    f.db.exec('CREATE TABLE batch_item_message_sources (batch_item_id TEXT, source_position INTEGER, message_id TEXT, created_at TEXT)')
    const before=fingerprints(f.db)
    expect(()=>migrateBatchImportSchema(f.db)).toThrow('SOURCE_PROVENANCE_MIGRATION_CONFLICT')
    expect(f.db.prepare('PRAGMA user_version').get()).toEqual({user_version:5})
    expect(fingerprints(f.db)).toEqual(before)
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name='idx_batch_item_message_sources_message'").get()).toBeUndefined()
  })
})
