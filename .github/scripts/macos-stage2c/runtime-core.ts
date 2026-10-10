// 仅供内部验收；所有数据均为隔离生成的假数据，不改变产品实现。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { initializeDatabase } from '../../../src/main/schema'
import { prepareSchemaV7Fixture } from '../../../tests/schema-v7-fixture'
import { importChatFile } from '../../../src/main/import/importer'
import type { ManualJsonImportResult } from '../../../src/main/import/manual-json'
import { configureMacEvidenceRoot } from '../../../src/main/batch-import/mac-json-evidence'
import { createManualJsonSnapshot, createManualJsonZip } from '../../../src/main/import/manual-json-contract'
import { createBatchImportItem, createBatchImportSession } from '../../../src/main/batch-import/repository'
import { loadManualJsonSnapshot, saveCapturedJsonEvidence, verifyBatchEvidence } from '../../../src/main/batch-import/evidence'
import { saveDirectoryEvidence, verifyDirectoryEvidence } from '../../../src/main/batch-import/directory-evidence'
import { WindowsPathLease } from '../../../src/main/batch-import/windows-path-lease'
import { addKeywordTerm, createKeywordGroup } from '../../../src/main/keyword-radar/config'
import { getKeywordHitContext, listRecentKeywordHits } from '../../../src/main/keyword-radar/desktop'
import { processPendingKeywordRadarRuns } from '../../../src/main/keyword-radar/recovery'
import { processPendingCommitmentExtractorRuns } from '../../../src/main/commitment/recovery'
import { confirmCommitmentCandidate, getCommitmentCandidateContext, ignoreCommitmentCandidate, listCommitmentCandidates } from '../../../src/main/commitment/desktop'
import { openBatchItemEvidence, openKeywordHitEvidence } from '../../../src/main/keyword-radar/evidence-navigation'
import { openCommitmentCandidateEvidence } from '../../../src/main/commitment/evidence-navigation'
import { getFirstUseStatus, markConnectorHeartbeat } from '../../../src/main/first-use'
import { prepareWorkBuddyConnector } from '../../../src/main/deployment'
import { askChat } from '../../../src/main/retrieval/service'
import { loadMessagesForDate } from '../../../src/main/intelligence/daily/repository'
import { getTodayKeywordInterest } from '../../../src/main/intelligence/daily/keyword-interest'
import { captureSearchRuntime } from './search-runtime'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const fields: Record<string, string> = {}
let windowsLeaseCalls = 0
WindowsPathLease.prototype.lock = async function () { windowsLeaseCalls++; throw new Error('Mac 不得进入 Windows 租约') }
const rows = (n = 1, content?: string) => Array.from({ length: n }, (_, i) => ({
  platform: 'stage2c-test', conversation_name: '隔离验收聊天', sender_name: '隔离发送人',
  timestamp: '2026-10-01T00:30:00+08:00', content: content ?? '我会把文件' + i + '整理好发给你'
}))
const bytes = (n = 1) => Buffer.from(JSON.stringify(rows(n), null, 2).replace(/\n/g, '\r\n'))
async function settle(db: DatabaseSync) {
  for (let i = 0; i < 12; i++) await new Promise<void>(done => setImmediate(done))
  await processPendingKeywordRadarRuns(db); await processPendingCommitmentExtractorRuns(db)
  for (let i = 0; i < 12; i++) await new Promise<void>(done => setImmediate(done))
}
function openWorkspace(directory: string) {
  const path = join(directory, 'private-radar.db'), db = new DatabaseSync(path)
  initializeDatabase(db); configureMacEvidenceRoot(directory)
  return { directory, path, db }
}
type Workspace = ReturnType<typeof openWorkspace>
async function fixture(action: (f: Workspace) => Promise<void>) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'privateradar-stage2c-')), f = openWorkspace(directory)
  try { await action(f) } finally {
    await settle(f.db); f.db.close()
    assert.equal(dirname(directory), realpathSync(tmpdir())); assert.ok(basename(directory).startsWith('privateradar-stage2c-'))
    rmSync(directory, { recursive: true, force: true })
  }
}
async function gate(name: string, action: () => Promise<void>) {
  try { await action(); fields[name] = 'PASS' }
  catch (error) { fields[name] = 'FAIL'; console.error(name, error) }
  console.log(name + ' = ' + fields[name])
}
function count(db: DatabaseSync, table: string) { return Number(db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n) }
function stored(f: Workspace, id: string) { return f.db.prepare('SELECT * FROM batch_import_items WHERE id=?').get(id)! }
function paths(f: Workspace, id: string) {
  const directory = join(f.directory, 'evidence', id)
  return { directory, zip: join(directory, 'original.zip'), snapshot: join(directory, 'messages.json') }
}
function newItem(f: Workspace) {
  const id = createBatchImportItem(f.db, createBatchImportSession(f.db, 'file').id, 0).id
  f.db.prepare("UPDATE batch_import_items SET source_batch_id='file:json:item:' || id WHERE id=?").run(id)
  return id
}
async function imported(f: Workspace, captured = bytes()) {
  const source = join(f.directory, '原文.json'); writeFileSync(source, captured)
  const result = await importChatFile(f.db, source, f.path) as ManualJsonImportResult
  await settle(f.db); assert.equal(result.status, 'success'); return result
}
function keywords(f: Workspace) { addKeywordTerm(f.db, createKeywordGroup(f.db, '文件').id, '文件') }
async function refused(f: Workspace, id: string) {
  let calls = 0; const before = stored(f, id)
  await assert.rejects(openBatchItemEvidence(f.db, f.path, id, async () => { calls++; return '' }))
  assert.equal(calls, 0); assert.deepEqual(stored(f, id), before)
}
async function verifyRestart(f: Workspace) {
  for (const table of ['messages', 'batch_import_items', 'batch_item_message_sources']) assert.equal(count(f.db, table), 1)
  const id = String(f.db.prepare('SELECT id FROM batch_import_items').get()!.id)
  assert.equal(stored(f, id).evidence_status, 'available'); assert.equal((await verifyBatchEvidence(f.db, f.path, id)).status, 'available')
  const hit = listRecentKeywordHits(f.db)[0]; assert.ok(hit)
  assert.ok(getKeywordHitContext(f.db, hit.id).entries.some(entry => entry.isCurrent && entry.batchItemId === id))
  const candidate = listCommitmentCandidates(f.db)[0]; assert.ok(candidate)
  assert.ok(getCommitmentCandidateContext(f.db, candidate.id).entries.some(entry => entry.isCurrent && entry.batchItemId === id))
  const search = await askChat(f.db, '文件', { aiProvider: null, embeddingProvider: null, anchorDate: '2026-09-30' })
  assert.equal(search.results.length, 1)
  assert.equal(search.results[0].messageId, String(f.db.prepare('SELECT id FROM messages').get()!.id))
  assert.equal(f.db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok')
}
async function validate() {
  await gate('MACOS_SQLITE_RUNTIME', () => fixture(async f => {
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 8)
    prepareSchemaV7Fixture(f.db); assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 7)
    initializeDatabase(f.db); assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 8)
    assert.equal(f.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
    assert.equal(f.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal')
    f.db.exec('CREATE TABLE ci_parent(id INTEGER PRIMARY KEY); CREATE TABLE ci_child(parent INTEGER REFERENCES ci_parent(id))')
    assert.throws(() => f.db.exec('INSERT INTO ci_child VALUES(99)'), /FOREIGN KEY/)
    f.db.exec('BEGIN IMMEDIATE; INSERT INTO ci_parent VALUES(1); ROLLBACK'); assert.equal(count(f.db, 'ci_parent'), 0)
    f.db.exec('BEGIN IMMEDIATE; INSERT INTO ci_parent VALUES(2); COMMIT'); assert.equal(count(f.db, 'ci_parent'), 1)
    assert.equal(f.db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok')
    assert.equal(f.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(f.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy, 0)
  }))
  await gate('MACOS_FTS5_RUNTIME', () => fixture(async f => {
    f.db.exec("CREATE VIRTUAL TABLE ci_fts USING fts5(body); INSERT INTO ci_fts VALUES('runtime arm64')")
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ci_fts WHERE ci_fts MATCH 'arm64'").get()!.n, 1)
    await imported(f)
    const result = await askChat(f.db, '文件', { aiProvider: null, embeddingProvider: null, anchorDate: '2026-09-30' })
    assert.equal(result.results.length, 1)
  }))
  await gate('MACOS_MANUAL_JSON_CORE', async () => {
    await fixture(async f => {
      keywords(f); const captured = bytes(), first = await imported(f, captured), p = paths(f, first.batchItemId)
      assert.deepEqual(readFileSync(p.zip), createManualJsonZip(captured)); assert.equal(first.rawSourceIdentity, hash(captured))
      assert.equal(stored(f, first.batchItemId).attachment_identity, hash(readFileSync(p.zip)))
      assert.equal((await loadManualJsonSnapshot(f.db, f.path, first.batchItemId)).messages.length, 1)
      const old = listCommitmentCandidates(f.db)[0]; assert.ok(old); confirmCommitmentCandidate(f.db, old.id)
      const second = await imported(f, captured); assert.notEqual(first.batchItemId, second.batchItemId)
      assert.equal(second.importedCount, 0); assert.equal(second.duplicateCount, 1); assert.equal(count(f.db, 'messages'), 1)
      assert.equal(count(f.db, 'batch_item_message_sources'), 2)
      assert.equal(listCommitmentCandidates(f.db).find(c => c.id === old.id)!.status, 'confirmed')
      const fresh = listCommitmentCandidates(f.db).find(c => c.batchItemId === second.batchItemId)!; ignoreCommitmentCandidate(f.db, fresh.id)
      await imported(f, captured); assert.equal(listCommitmentCandidates(f.db).find(c => c.id === fresh.id)!.status, 'ignored')
      assert.ok(getCommitmentCandidateContext(f.db, old.id).entries.some(entry => entry.isCurrent && entry.batchItemId === first.batchItemId))
    })
    await fixture(async f => {
      await imported(f, Buffer.from(JSON.stringify(rows(1, '报价  更新')))); const before = f.db.prepare('SELECT * FROM messages').all()
      const source = join(f.directory, '冲突.json'); writeFileSync(source, JSON.stringify(rows(1, '报价 更新')))
      const result = await importChatFile(f.db, source, f.path) as ManualJsonImportResult
      await settle(f.db); assert.equal(result.status, 'failed'); assert.match(result.errors.join(''), /SOURCE_CONTENT_CONFLICT|原文不同/)
      assert.deepEqual(f.db.prepare('SELECT * FROM messages').all(), before); assert.equal(stored(f, result.batchItemId).evidence_status, 'available')
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM batch_item_message_sources WHERE batch_item_id=?').get(result.batchItemId)!.n, 0)
    })
    for (const n of [500, 501]) await fixture(async f => {
      keywords(f); const result = await imported(f, bytes(n)), snapshot = await loadManualJsonSnapshot(f.db, f.path, result.batchItemId)
      assert.equal(snapshot.messages.length, n); assert.equal(snapshot.messages[n - 1].source_position, n - 1)
      for (const table of ['messages', 'batch_item_message_sources', 'keyword_hits', 'commitment_candidates']) assert.equal(count(f.db, table), n)
      for (const table of ['keyword_radar_runs', 'commitment_extractor_runs']) assert.equal(f.db.prepare('SELECT status FROM ' + table).get()!.status, 'complete')
    })
  })
  await gate('MACOS_EVIDENCE_FILESYSTEM', () => fixture(async f => {
    const result = await imported(f), p = paths(f, result.batchItemId)
    assert.equal((await verifyBatchEvidence(f.db, f.path, result.batchItemId)).status, 'available')
    const before = readFileSync(p.zip); writeFileSync(p.zip, Buffer.from('摘要不符')); await refused(f, result.batchItemId); writeFileSync(p.zip, before)
    f.db.prepare("UPDATE batch_import_items SET evidence_relative_path='../外部.zip' WHERE id=?").run(result.batchItemId); await refused(f, result.batchItemId)
    f.db.prepare('UPDATE batch_import_items SET evidence_relative_path=? WHERE id=?').run('evidence/' + result.batchItemId + '/original.zip', result.batchItemId)
    configureMacEvidenceRoot(join(f.directory, '其他根')); await refused(f, result.batchItemId); configureMacEvidenceRoot(f.directory)
    const id = newItem(f), broken = Buffer.from('不是 JSON'); await saveCapturedJsonEvidence(f.db, f.path, id, broken)
    assert.throws(() => createManualJsonSnapshot(broken)); assert.equal(stored(f, id).snapshot_relative_path, null)
    assert.deepEqual(readdirSync(paths(f, id).directory), ['original.zip']); assert.deepEqual(readFileSync(paths(f, id).zip), createManualJsonZip(broken))
  }))
  await gate('MACOS_NON_OVERWRITE_PUBLISH', () => fixture(async f => {
    const existing = newItem(f), p = paths(f, existing); mkdirSync(p.directory, { recursive: true }); writeFileSync(p.zip, '已有内容')
    await assert.rejects(saveCapturedJsonEvidence(f.db, f.path, existing, bytes()))
    assert.equal(readFileSync(p.zip, 'utf8'), '已有内容'); assert.equal(stored(f, existing).evidence_relative_path, null)
    assert.deepEqual(readdirSync(p.directory), ['original.zip'])
    const concurrent = newItem(f), outcomes = await Promise.allSettled([
      saveCapturedJsonEvidence(f.db, f.path, concurrent, bytes()), saveCapturedJsonEvidence(f.db, f.path, concurrent, bytes(2))
    ])
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1)
    assert.equal(hash(readFileSync(paths(f, concurrent).zip)), stored(f, concurrent).attachment_identity)
    assert.deepEqual(readdirSync(paths(f, concurrent).directory), ['original.zip'])
    const normal = await imported(f); assert.equal((await verifyBatchEvidence(f.db, f.path, normal.batchItemId)).status, 'available')
  }))
  await gate('MACOS_SYMLINK_BOUNDARY', () => fixture(async f => {
    const source = join(f.directory, '实际.json'), alias = join(f.directory, '链接.json'); writeFileSync(source, bytes()); symlinkSync(source, alias)
    await assert.rejects(importChatFile(f.db, alias, f.path)); assert.equal(count(f.db, 'batch_import_items'), 0)
    const result = await imported(f), p = paths(f, result.batchItemId)
    for (const target of [p.zip, p.snapshot]) {
      const backup = target + '.backup'; renameSync(target, backup); symlinkSync(backup, target)
      await refused(f, result.batchItemId); unlinkSync(target); renameSync(backup, target)
    }
    const backup = join(f.directory, '目录原位置'); renameSync(p.directory, backup); symlinkSync(backup, p.directory, 'dir')
    await refused(f, result.batchItemId); unlinkSync(p.directory); renameSync(backup, p.directory)
    const parent = join(f.directory, '父目录'), parentAlias = join(f.directory, '父链接'); mkdirSync(parent); symlinkSync(parent, parentAlias, 'dir')
    const dbDirectory = join(parentAlias, '应用'); mkdirSync(dbDirectory); const other = openWorkspace(dbDirectory)
    const outside = join(parent, '外部材料'), protectedBytes = Buffer.from('外部材料必须保留'); writeFileSync(outside, protectedBytes)
    try {
      const id = newItem(other), before = stored(other, id)
      await assert.rejects(saveCapturedJsonEvidence(other.db, other.path, id, bytes()))
      await refused(other, id)
      assert.deepEqual(stored(other, id), before)
      assert.equal(existsSync(join(parent, '应用', 'evidence')), false)
      assert.deepEqual(readFileSync(outside), protectedBytes)
    }
    finally { other.db.close(); configureMacEvidenceRoot(f.directory) }
  }))
  await gate('MACOS_TIME_RUNTIME', () => fixture(async f => {
    keywords(f); await imported(f); const input = '2026-10-01T00:30:00+08:00', absolute = new Date(input)
    assert.equal(absolute.toISOString(), '2026-09-30T16:30:00.000Z')
    const day = [absolute.getFullYear(), String(absolute.getMonth() + 1).padStart(2, '0'), String(absolute.getDate()).padStart(2, '0')].join('-')
    const sqlite = String(f.db.prepare("SELECT date(?, 'localtime') AS day").get(input)!.day)
    assert.equal(sqlite, day); assert.equal(loadMessagesForDate(f.db, day).length, 1)
    assert.equal(getTodayKeywordInterest(f.db, absolute).todayDate, day); assert.equal(getTodayKeywordInterest(f.db, absolute).items.length, 1)
    console.log(JSON.stringify({ 时区: Intl.DateTimeFormat().resolvedOptions().timeZone, 偏移分钟: absolute.getTimezoneOffset(), 来源时间: input, 绝对时间: absolute.toISOString(), 本地日历日期: day, 数据库本地日期: sqlite }))
  }))
  await gate('MACOS_EVIDENCE_NAVIGATION_LOGIC', () => fixture(async f => {
    keywords(f); const result = await imported(f), opened: string[] = [], boundary = async (path: string) => { opened.push(path); return '' }
    await openKeywordHitEvidence(f.db, f.path, listRecentKeywordHits(f.db)[0].id, boundary)
    await openCommitmentCandidateEvidence(f.db, f.path, listCommitmentCandidates(f.db)[0].id, boundary)
    assert.deepEqual(opened, [paths(f, result.batchItemId).directory, paths(f, result.batchItemId).directory]); assert.equal(windowsLeaseCalls, 0)
  }))
  await gate('MACOS_DIRECTORY_EVIDENCE_POLICY', () => fixture(async f => {
    const id = createBatchImportItem(f.db, createBatchImportSession(f.db, 'workbuddy').id, 0).id
    f.db.prepare("UPDATE batch_import_items SET evidence_source_kind='directory',evidence_status='available',evidence_relative_path='evidence/' || id WHERE id=?").run(id)
    const before = stored(f, id); assert.equal((await verifyBatchEvidence(f.db, f.path, id)).status, 'error')
    assert.equal((await verifyDirectoryEvidence(f.db, f.path, id)).status, 'error')
    await assert.rejects(saveDirectoryEvidence(f.db, f.path, id, join(f.directory, '不存在')), /尚未支持/)
    await refused(f, id); assert.deepEqual(stored(f, id), before); assert.equal(windowsLeaseCalls, 0)
  }))
  await gate('MACOS_WORKBUDDY_GUARD', () => fixture(async f => {
    markConnectorHeartbeat(f.db, 'connected'); const before = f.db.prepare('SELECT * FROM app_settings').all(), status = getFirstUseStatus(f.db, f.path)
    assert.equal(status.manualJsonOnly, true); assert.equal(status.databaseHealthy, true)
    for (const key of ['workBuddyConnected', 'workBuddyInstalled', 'connectorPrepared', 'connectorRequiresRetrust'] as const) assert.equal(status[key], false)
    assert.deepEqual(f.db.prepare('SELECT * FROM app_settings').all(), before)
    const files = readdirSync(f.directory); assert.throws(() => prepareWorkBuddyConnector('不存在的载荷', f.directory, '0.2.0-alpha.20'), /尚未支持/)
    assert.deepEqual(readdirSync(f.directory), files)
  }))
  return fields
}
async function main() {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64')
  console.log(JSON.stringify({ 平台: process.platform, 架构: process.arch, Node版本: process.version, Electron版本: process.versions.electron ?? null }))
  const mode = process.argv[2], directory = process.argv[3]
  if (mode === 'search') {
    const report = await captureSearchRuntime()
    writeFileSync(directory, JSON.stringify(report, (_key, value) => value === Infinity ? 'Infinity' : value, 2) + '\n')
    console.log(JSON.stringify(report.runtime)); return
  }
  if (mode === 'restart-a' || mode === 'restart-b') {
    assert.ok(directory); assert.equal(dirname(resolve(directory)), realpathSync(tmpdir())); assert.ok(basename(directory).startsWith('privateradar-stage2c-restart-'))
    const f = openWorkspace(directory)
    try { if (mode === 'restart-a') { keywords(f); await imported(f) }; await verifyRestart(f) }
    finally { await settle(f.db); f.db.close() }
    console.log(mode + ' = PASS'); return
  }
  const result = await validate(); writeFileSync(directory, JSON.stringify(result, null, 2) + '\n')
  if (Object.values(result).includes('FAIL')) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
