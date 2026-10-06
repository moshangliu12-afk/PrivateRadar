import { Worker } from 'node:worker_threads'
import { afterEach, expect, it } from 'vitest'
import { cleanupRadarFixtures, radarFixture, ingestRadarItem } from './keyword-radar-fixture'
import { createKeywordGroup, addKeywordTerm } from '../src/main/keyword-radar/config'
import { getKeywordRadarRun } from '../src/main/keyword-radar/runs'
import { parseRulesSnapshot } from '../src/main/keyword-radar/contracts'

afterEach(cleanupRadarFixtures)

it('另一个连接并发改词必须等待导入写事务；Run 使用完整旧规则，提交后配置为完整新规则', async () => {
  const f = radarFixture(), group = createKeywordGroup(f.db, '冻结规则'), old = addKeywordTerm(f.db, group.id, 'Codex')
  const barrier = new SharedArrayBuffer(8), signals = new Int32Array(barrier)
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const signals = new Int32Array(workerData.barrier), db = new DatabaseSync(workerData.path);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    parentPort.postMessage({ ready: true });
    Atomics.wait(signals,0,0);
    Atomics.store(signals,1,1); Atomics.notify(signals,1);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE keyword_terms SET enabled=0 WHERE id=?').run(workerData.term);
      db.prepare('INSERT INTO keyword_terms VALUES (?,?,?,?,1,?)')
        .run('new-term',workerData.group,'新增','新增','创建');
      db.exec('COMMIT'); parentPort.postMessage({ done: true });
    } catch(error) { parentPort.postMessage({ error: error.message }); }
    finally { db.close(); }
  `, { eval: true, workerData: { path: f.path, group: group.id, term: old.id, barrier } })
  const ready = new Promise<void>((resolve, reject) => {
    worker.on('error', reject); worker.on('message', message => { if (message.ready) resolve() })
  })
  const done = new Promise<void>((resolve, reject) => {
    worker.on('error', reject); worker.on('message', message => { if (message.done) resolve(); if (message.error) reject(new Error(message.error)) })
  })
  const exited = new Promise<void>((resolve, reject) => worker.on('exit', code => code === 0 ? resolve() : reject(new Error(`隔离线程退出：${code}`))))
  try {
    await ready
    f.db.function('notify_config_writer', () => {
      // 此时已持有 importer 的写锁，通知另一连接尝试修改配置。
      Atomics.store(signals, 0, 1); Atomics.notify(signals, 0)
      expect(Atomics.wait(signals, 1, 0, 2000)).not.toBe('timed-out')
      return 1
    })
    f.db.exec(`CREATE TRIGGER notify_concurrent_config AFTER INSERT ON batch_item_message_sources
      WHEN NEW.source_position=0 BEGIN SELECT notify_config_writer(); END`)
    expect(ingestRadarItem(f).status).toBe('success')
    await done; await exited
    const snapshot = parseRulesSnapshot(getKeywordRadarRun(f.db, f.items[0].id)!.rules_snapshot_json)
    expect(snapshot.groups[0].terms).toEqual([{ term_id: old.id, term: 'Codex', normalized_term: 'codex' }])
    expect(f.db.prepare('SELECT id,enabled FROM keyword_terms ORDER BY id').all()).toEqual(
      [{ id: old.id, enabled: 0 }, { id: 'new-term', enabled: 1 }].sort((a, b) => a.id.localeCompare(b.id))
    )
  } finally { await worker.terminate() }
}, 15_000)
