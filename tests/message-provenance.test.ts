import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { saveOriginalZip, saveStructuredSnapshot, verifyBatchEvidence } from '../src/main/batch-import/evidence'
import { bindItemMessageSource, listItemMessageSources, listMessageSources } from '../src/main/batch-import/message-sources'
import { executeBatchImportSession } from '../src/main/batch-import/session'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { importSavedBatchItem } from '../src/main/batch-import/import-item'
import { createCollection, completeCollection } from '../src/main/collections/service'
import { getFirstUseStatus } from '../src/main/first-use'
import { understandQuery } from '../src/main/retrieval/query-understanding'
import { hybridSearch } from '../src/main/retrieval/hybrid-search'
import type { WorkBuddyMessageInput } from '../src/main/integrations/workbuddy/validation'

const fixtures: Array<{db:DatabaseSync;directory:string}>=[]
afterEach(()=>{for(const f of fixtures.splice(0)){f.db.close();rmSync(f.directory,{recursive:true,force:true})}})
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'privateradar-message-provenance-')),path=join(directory,'private-radar.db')
  const db=new DatabaseSync(path);fixtures.push({db,directory});initializeDatabase(db)
  const collection=createCollection(db,'来源关系隔离验收')
  const session=createBatchImportSession(db,'workbuddy',collection.id)
  const items=[createBatchImportItem(db,session.id,0),createBatchImportItem(db,session.id,1)]
  const zip=join(directory,'source.zip'),bytes=Buffer.alloc(22);bytes.write('PK\u0005\u0006',0,'binary');writeFileSync(zip,bytes)
  return {db,directory,path,collection,session,items,zip}
}
function messages(numbers:number[],strong=true):WorkBuddyMessageInput[]{return numbers.map(number=>({
  platform:'wechat',conversation_name:'来源群',sender_name:'同一发送人',timestamp:`2026-10-04T09:0${number}:00+08:00`,
  timestamp_source:'source_native',content:`provenancefts 消息${number}`,
  ...(strong?{source_message_id:`可靠消息${number}`}:{})
}))}
async function prepare(f:ReturnType<typeof fixture>,ordinal:number,input:WorkBuddyMessageInput[]){
  await saveOriginalZip(f.db,f.path,f.items[ordinal].id,f.zip)
  await saveStructuredSnapshot(f.db,f.path,f.items[ordinal].id,{messages:input})
}
function count(db:DatabaseSync,table:string){return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)}
function canonicalRows(db:DatabaseSync){return db.prepare('SELECT rowid,* FROM messages ORDER BY id').all()}
function evidenceHash(f:ReturnType<typeof fixture>){return f.items.flatMap(item=>['original.zip','messages.json'].map(name=>createHash('sha256').update(readFileSync(join(f.directory,'evidence',item.id,name))).digest('hex')))}

describe('消息来源出现与 canonical 分离',()=>{
  it('强身份 3+3 部分重叠为四条 canonical、六条来源，两份 Evidence 独立，可双向追溯',async()=>{
    const f=fixture();await prepare(f,0,messages([1,2,3]));await prepare(f,1,messages([2,3,4]))
    const evidenceBefore=evidenceHash(f)
    const result=await executeBatchImportSession(f.db,f.path,f.session.id)
    expect(result).toMatchObject({status:'success',imported_total:4,duplicate_total:2,updated_total:0,attention_required_attachments:0})
    expect(result.items.map(item=>[item.imported,item.duplicate,item.written_messages,item.indexed_messages])).toEqual([[3,0,3,3],[1,2,3,3]])
    expect(count(f.db,'messages')).toBe(4);expect(count(f.db,'messages_fts')).toBe(4);expect(count(f.db,'batch_item_message_sources')).toBe(6)
    const b=listItemMessageSources(f.db,f.items[1].id)
    expect(b.map(row=>row.source_position)).toEqual([0,1,2])
    expect(b.map(row=>f.db.prepare('SELECT content FROM messages WHERE id=?').get(row.message_id)!.content)).toEqual(['provenancefts 消息2','provenancefts 消息3','provenancefts 消息4'])
    expect(listMessageSources(f.db,b[0].message_id).map(row=>row.batch_item_id).sort()).toEqual(f.items.map(item=>item.id).sort())
    expect(evidenceHash(f)).toEqual(evidenceBefore)
    for(const item of f.items)expect((await verifyBatchEvidence(f.db,f.path,item.id)).status).toBe('available')
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    completeCollection(f.db,f.collection.id)
    expect(()=>createBatchImportSession(f.db,'workbuddy',f.collection.id)).toThrow()
    expect(count(f.db,'batch_item_message_sources')).toBe(6)
  })

  it('完全 duplicate Item 仍有全部关系、成功状态、可用 Evidence 和正确完整性状态',async()=>{
    const f=fixture();await prepare(f,0,messages([1,2,3]));await prepare(f,1,messages([1,2,3]))
    const result=await executeBatchImportSession(f.db,f.path,f.session.id)
    expect(result.items[1]).toMatchObject({outcome:'success',imported:0,duplicate:3,written_messages:3,indexed_messages:3})
    expect(count(f.db,'messages')).toBe(3);expect(count(f.db,'messages_fts')).toBe(3);expect(count(f.db,'batch_item_message_sources')).toBe(6)
    const batch=f.db.prepare('SELECT completeness_level FROM message_import_batches WHERE source_batch_id=?').get(`workbuddy:item:${f.items[1].id}`)
    expect(batch).toEqual({completeness_level:'complete'})
    const firstUse=getFirstUseStatus(f.db,f.path)
    expect(firstUse.latestImport).toMatchObject({importedCount:0,duplicateCount:3,conversationStatus:'confirmed',senderStatus:'confirmed',timestampStatus:'confirmed'})
    expect((await verifyBatchEvidence(f.db,f.path,f.items[1].id)).status).toBe('available')
  })

  it('同 Item 两个位置复用一个强身份时，来源数为二而新增消息只有一',async()=>{
    const f=fixture();await prepare(f,0,messages([1,1]));await prepare(f,1,messages([2]))
    const result=await executeBatchImportSession(f.db,f.path,f.session.id)
    expect(result).toMatchObject({status:'success',imported_total:2,duplicate_total:1})
    expect(result.items[0]).toMatchObject({imported:1,duplicate:1,written_messages:2,indexed_messages:2,outcome:'success'})
    const rows=listItemMessageSources(f.db,f.items[0].id)
    expect(rows.map(row=>row.source_position)).toEqual([0,1])
    expect(rows[0].message_id).toBe(rows[1].message_id)
  })

  it('无效输入不建立关系，后续有效输入保留原始位置而不压缩重排',async()=>{
    const f=fixture(),input=[messages([1])[0],{content:'时间无效',timestamp:'无效时间'},messages([2])[0]]
    await prepare(f,0,input)
    const result=await importSavedBatchItem(f.db,f.path,f.items[0].id)
    expect(result).toMatchObject({status:'partial',recognizedCount:2,importedCount:2,invalidCount:1})
    expect(listItemMessageSources(f.db,f.items[0].id).map(row=>row.source_position)).toEqual([0,2])
    expect(count(f.db,'messages_fts')).toBe(2)
  })

  it('同来源既有补充更新语义保留，来源关系幂等不新增消息',()=>{
    const f=fixture(),item=f.items[0],sourceBatchId=`workbuddy:item:${item.id}`
    f.db.prepare('UPDATE batch_import_items SET source_batch_id=? WHERE id=?').run(sourceBatchId,item.id)
    const context={batchItemId:item.id,sourceBatchId},input={content:'同来源补全',source_message_id:'同来源强身份'}
    expect(ingestWorkBuddyMessages(f.db,{messages:[input]},0,context).importedCount).toBe(1)
    const before=listItemMessageSources(f.db,item.id)
    const updated=ingestWorkBuddyMessages(f.db,{messages:[{...input,timestamp:'2026-10-04T09:00:00+08:00',timestamp_source:'source_native'}]},0,context)
    expect(updated).toMatchObject({status:'success',importedCount:0,duplicateCount:0,updatedCount:1})
    expect(listItemMessageSources(f.db,item.id)).toEqual(before)
    expect(count(f.db,'messages')).toBe(1);expect(count(f.db,'messages_fts')).toBe(1)
  })

  it.each(['分钟时间','未知时间','图片占位'] as const)('弱身份%s跨 Item 不自动合并，仍建立独立来源',async kind=>{
    const f=fixture(),input=messages([1,2,3],false)
    if(kind==='未知时间')for(const message of input){delete message.timestamp;message.timestamp_source='unknown'}
    if(kind==='图片占位')for(const message of input)message.content='[图片] 相同占位.jpg'
    await prepare(f,0,input);await prepare(f,1,input)
    const result=await executeBatchImportSession(f.db,f.path,f.session.id)
    expect(result).toMatchObject({status:'success',imported_total:6,duplicate_total:0})
    expect(count(f.db,'messages')).toBe(6);expect(count(f.db,'messages_fts')).toBe(6);expect(count(f.db,'batch_item_message_sources')).toBe(6)
  })

  it('强身份跨 Item 不覆盖原消息、时间、原始来源或 identity，FTS 不重写',async()=>{
    const f=fixture();await prepare(f,0,messages([1]));await prepare(f,1,[{...messages([1])[0],sender_name:'后来的显示名',timestamp:'2026-10-05T00:00:00Z'}])
    await importSavedBatchItem(f.db,f.path,f.items[0].id)
    const before=canonicalRows(f.db),fts=f.db.prepare('SELECT * FROM messages_fts_data ORDER BY id').all()
    const second=await importSavedBatchItem(f.db,f.path,f.items[1].id)
    expect(second).toMatchObject({importedCount:0,duplicateCount:1,updatedCount:0})
    expect(canonicalRows(f.db)).toEqual(before);expect(f.db.prepare('SELECT * FROM messages_fts_data ORDER BY id').all()).toEqual(fts)
  })

  it('同来源同位置同 message 幂等且 created_at 不变，其他 message 冲突绝不改绑',async()=>{
    const f=fixture();await prepare(f,0,messages([1,2]));await importSavedBatchItem(f.db,f.path,f.items[0].id)
    const rows=listItemMessageSources(f.db,f.items[0].id)
    bindItemMessageSource(f.db,f.items[0].id,0,rows[0].message_id,'新时间')
    expect(listItemMessageSources(f.db,f.items[0].id)).toEqual(rows)
    expect(()=>bindItemMessageSource(f.db,f.items[0].id,0,rows[1].message_id,'改绑')).toThrow('SOURCE_RELATION_CONFLICT')
    expect(listItemMessageSources(f.db,f.items[0].id)).toEqual(rows)
    expect(()=>f.db.prepare('DELETE FROM messages WHERE id=?').run(rows[0].message_id)).toThrow()
    expect(()=>f.db.prepare('DELETE FROM batch_import_items WHERE id=?').run(f.items[0].id)).toThrow()
  })

  it('来源写入失败时本 Item 的新消息、FTS、关系一起回滚，已有 Item 保留，失败 Job 不伪报成功',async()=>{
    const f=fixture();await prepare(f,0,messages([1]));await prepare(f,1,messages([2,3]));await importSavedBatchItem(f.db,f.path,f.items[0].id)
    const before=canonicalRows(f.db)
    f.db.exec(`CREATE TRIGGER reject_source BEFORE INSERT ON batch_item_message_sources
      WHEN new.batch_item_id='${f.items[1].id}' AND new.source_position=1 BEGIN SELECT RAISE(ABORT,'来源写入失败'); END`)
    const result=await importSavedBatchItem(f.db,f.path,f.items[1].id)
    expect(result).toMatchObject({status:'failed',importedCount:0,duplicateCount:0})
    expect(canonicalRows(f.db)).toEqual(before);expect(count(f.db,'messages_fts')).toBe(1)
    expect(listItemMessageSources(f.db,f.items[1].id)).toEqual([])
    expect(f.db.prepare('SELECT status,imported_count FROM import_jobs WHERE id=?').get(result.jobId)).toEqual({status:'failed',imported_count:0})
  })

  it('已有关系指向不同 canonical 时，导入事务失败关闭',async()=>{
    const f=fixture();await prepare(f,0,messages([1]));await prepare(f,1,messages([2]));await importSavedBatchItem(f.db,f.path,f.items[0].id)
    const first=listItemMessageSources(f.db,f.items[0].id)[0]
    bindItemMessageSource(f.db,f.items[1].id,0,first.message_id,'既有绑定')
    const result=ingestWorkBuddyMessages(f.db,{messages:messages([2])},0,{batchItemId:f.items[1].id,sourceBatchId:`workbuddy:item:${f.items[1].id}`})
    expect(result.status).toBe('failed');expect(result.errors[0]).toContain('SOURCE_RELATION_CONFLICT')
    expect(count(f.db,'messages')).toBe(1);expect(count(f.db,'messages_fts')).toBe(1)
    expect(listItemMessageSources(f.db,f.items[1].id)[0].message_id).toBe(first.message_id)
  })

  it('强身份正文冲突失败，不覆盖 canonical 或伪造来源',async()=>{
    const f=fixture();await prepare(f,0,messages([1]));await prepare(f,1,[{...messages([1])[0],content:'不同正文'}])
    await importSavedBatchItem(f.db,f.path,f.items[0].id);const before=canonicalRows(f.db)
    const result=await importSavedBatchItem(f.db,f.path,f.items[1].id)
    expect(result.status).toBe('failed');expect(result.errors[0]).toContain('SOURCE_IDENTITY_CONFLICT')
    expect(canonicalRows(f.db)).toEqual(before);expect(listItemMessageSources(f.db,f.items[1].id)).toEqual([])
  })

  it('同 Item 强身份重复但正文不一致时也整体回滚，不把不同正文绑到同一消息',async()=>{
    const f=fixture();await prepare(f,0,[messages([1])[0],{...messages([1])[0],content:'身份相同但正文不同'}])
    const result=await importSavedBatchItem(f.db,f.path,f.items[0].id)
    expect(result.status).toBe('failed');expect(result.errors[0]).toContain('SOURCE_IDENTITY_CONFLICT')
    expect(count(f.db,'messages')).toBe(0);expect(count(f.db,'messages_fts')).toBe(0)
    expect(listItemMessageSources(f.db,f.items[0].id)).toEqual([])
  })

  it('缺一条来源关系的成功 Item 不再被误判为完整成功',async()=>{
    const f=fixture();await prepare(f,0,messages([1,2]));await prepare(f,1,messages([1,2]))
    await executeBatchImportSession(f.db,f.path,f.session.id)
    f.db.prepare('DELETE FROM batch_item_message_sources WHERE batch_item_id=? AND source_position=1').run(f.items[1].id)
    const {getBatchImportSessionSummary}=await import('../src/main/batch-import/session')
    expect((await getBatchImportSessionSummary(f.db,f.path,f.session.id)).items[1].outcome).toBe('needs_attention')
  })

  it('多来源不 JOIN Search，canonical 只召回一次',async()=>{
    const f=fixture();await prepare(f,0,messages([1,2,3]));await prepare(f,1,messages([1,2,3]))
    await executeBatchImportSession(f.db,f.path,f.session.id)
    const result=await hybridSearch(f.db,'provenancefts',understandQuery(f.db,'provenancefts','2026-10-05'),null)
    expect(result.results).toHaveLength(3)
    expect(new Set(result.results.map(row=>row.messageId)).size).toBe(3)
  })

  it.each(['不同消息','相同消息'] as const)('不同连接并发插入同一来源位置：%s保持唯一绑定',async kind=>{
    const f=fixture();await prepare(f,0,messages([1,2]));await importSavedBatchItem(f.db,f.path,f.items[0].id)
    const ids=listItemMessageSources(f.db,f.items[0].id).map(row=>row.message_id)
    if(kind==='相同消息')ids[1]=ids[0]
    const {transform}=await import('esbuild')
    const module=await transform(readFileSync(join(import.meta.dirname,'../src/main/batch-import/message-sources.ts'),'utf8'),{loader:'ts',format:'esm',target:'node24'})
    const workerModule=join(f.directory,'source-worker.mjs');writeFileSync(workerModule,module.code)
    const barrier=new SharedArrayBuffer(4)
    const run=(messageId:string)=>new Promise<{ok:boolean;error?:string}>((resolve,reject)=>{
      const worker=new Worker(`const {workerData,parentPort}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const {pathToFileURL}=require('node:url');(async()=>{const {bindItemMessageSource}=await import(pathToFileURL(workerData.module).href);const db=new DatabaseSync(workerData.path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.barrier),0,0);try{bindItemMessageSource(db,workerData.item,0,workerData.message,'并发');parentPort.postMessage({ok:true})}catch(error){parentPort.postMessage({ok:false,error:error.message})}finally{db.close()}})()`,{eval:true,workerData:{module:workerModule,path:f.path,item:f.items[1].id,message:messageId,barrier}})
      worker.on('message',value=>{if(value.ready){ready++;if(ready===2){Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0)}}else resolve(value)})
      worker.on('error',reject)
      worker.on('exit',code=>{if(code!==0)reject(new Error(`并发工作线程异常退出：${code}`))})
    })
    let ready=0
    const results=await Promise.all(ids.map(run))
    expect(results.filter(row=>row.ok)).toHaveLength(kind==='相同消息'?2:1)
    if(kind==='不同消息')expect(results.find(row=>!row.ok)?.error).toContain('SOURCE_RELATION_CONFLICT')
    expect(listItemMessageSources(f.db,f.items[1].id)).toHaveLength(1)
  })
})
