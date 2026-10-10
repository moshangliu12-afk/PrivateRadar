import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import {
  loadStructuredSnapshot,
  saveOriginalZip,
  saveStructuredSnapshot,
  verifyBatchEvidence
} from '../src/main/batch-import/evidence'
import type { WorkBuddyIngestInput } from '../src/main/integrations/workbuddy/validation'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close()
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function fixture(): { db: DatabaseSync; databasePath: string; directory: string; zipPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-evidence-'))
  directories.push(directory)
  const databasePath = join(directory, 'private-radar.db')
  const db = new DatabaseSync(databasePath)
  databases.push(db)
  initializeDatabase(db)
  const zipPath = join(directory, 'source.zip')
  writeFileSync(zipPath, emptyZip())
  return { db, databasePath, directory, zipPath }
}

function emptyZip(comment?: string): Buffer {
  const text = Buffer.from(comment ?? '', 'utf8')
  const bytes = Buffer.alloc(22 + text.length)
  bytes.write('PK\u0005\u0006', 0, 'binary')
  bytes.writeUInt16LE(text.length, 20)
  text.copy(bytes, 22)
  return bytes
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function item(db: DatabaseSync): string {
  const session = createBatchImportSession(db, 'workbuddy')
  return createBatchImportItem(db, session.id, 0, '聊天记录.zip').id
}

function messages(): WorkBuddyIngestInput {
  return {
    import_mode: 'quick',
    source_batch_id: '固定来源批次',
    messages: [
      { platform: 'wechat', sender_name: '甲', content: '  第一行\n第二行  ',
        timestamp: '2026-09-24T09:00:00+08:00', timestamp_source: 'source_native', source_position: 0 },
      { platform: 'wechat', sender_name: '乙', content: '[动画表情]',
        timestamp: '2026-09-25T10:02:00+08:00', timestamp_source: 'source_native', source_position: 1 },
      { platform: 'wechat', sender_name: '甲', content: '[文件] example.pdf',
        timestamp: '2026-09-26T11:03:00+08:00', timestamp_source: 'source_native', source_position: 2 }
    ]
  }
}

describe('alpha.15 原始证据与结构化快照', () => {
  it.skipIf(process.platform !== 'win32')('将明确给出的 ZIP 保存到附件项目录并登记相对路径与哈希', async () => {
    const { db, databasePath, directory, zipPath } = fixture()
    const itemId = item(db)
    const stored = await saveOriginalZip(db, databasePath, itemId, zipPath)
    const target = join(directory, 'evidence', itemId, 'original.zip')
    expect(existsSync(target)).toBe(true)
    expect(stored).toEqual({ relativePath: `evidence/${itemId}/original.zip`, sha256: hash(readFileSync(zipPath)) })
    expect(hash(readFileSync(target))).toBe(stored.sha256)
    expect(db.prepare('SELECT attachment_identity, evidence_relative_path, evidence_status FROM batch_import_items WHERE id = ?').get(itemId)).toEqual({
      attachment_identity: stored.sha256, evidence_relative_path: stored.relativePath, evidence_status: 'available'
    })
    expect((await verifyBatchEvidence(db, databasePath, itemId)).zip.status).toBe('available')
  })

  it.skipIf(process.platform !== 'win32')('关闭并重新打开数据库后仍可校验 ZIP、快照并恢复原输入', async () => {
    const { db, databasePath, zipPath } = fixture()
    const itemId = item(db)
    await saveOriginalZip(db, databasePath, itemId, zipPath)
    await saveStructuredSnapshot(db, databasePath, itemId, messages())
    db.close()
    databases.pop()

    const reopened = new DatabaseSync(databasePath)
    databases.push(reopened)
    initializeDatabase(reopened)
    const verified = await verifyBatchEvidence(reopened, databasePath, itemId)
    expect(verified.status).toBe('available')
    expect(verified.zip.status).toBe('available')
    expect(verified.snapshot).toMatchObject({ status: 'available', messageCount: 3 })
    expect(await loadStructuredSnapshot(reopened, databasePath, itemId)).toEqual(messages())
  })

  it.skipIf(process.platform !== 'win32')('两个内容相同的 ZIP 在不同附件项下分别保存，不合并实例', async () => {
    const { db, databasePath, directory, zipPath } = fixture()
    const session = createBatchImportSession(db, 'workbuddy')
    const first = createBatchImportItem(db, session.id, 0)
    const second = createBatchImportItem(db, session.id, 1)
    const a = await saveOriginalZip(db, databasePath, first.id, zipPath)
    const b = await saveOriginalZip(db, databasePath, second.id, zipPath)
    expect(first.id).not.toBe(second.id)
    expect(a.sha256).toBe(b.sha256)
    expect(a.relativePath).not.toBe(b.relativePath)
    expect(existsSync(join(directory, 'evidence', first.id, 'original.zip'))).toBe(true)
    expect(existsSync(join(directory, 'evidence', second.id, 'original.zip'))).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('快照保留多日期、发送人、消息顺序、原始空格换行及占位文本', async () => {
    const { db, databasePath, directory, zipPath } = fixture()
    const itemId = item(db)
    await saveOriginalZip(db, databasePath, itemId, zipPath)
    const input = messages()
    const stored = await saveStructuredSnapshot(db, databasePath, itemId, input)
    const bytes = readFileSync(join(directory, 'evidence', itemId, 'messages.json'))
    const parsed = JSON.parse(bytes.toString('utf8')) as { schema_version: number; input: WorkBuddyIngestInput }
    expect(parsed.schema_version).toBe(1)
    expect(parsed.input).toEqual(input)
    expect(parsed.input.messages.map((message) => message.content)).toEqual([
      '  第一行\n第二行  ', '[动画表情]', '[文件] example.pdf'
    ])
    expect(stored.sha256).toBe(hash(bytes))
    expect(db.prepare('SELECT snapshot_relative_path, snapshot_sha256 FROM batch_import_items WHERE id = ?').get(itemId)).toEqual({
      snapshot_relative_path: stored.relativePath, snapshot_sha256: stored.sha256
    })
  })

  it.skipIf(process.platform !== 'win32')('源 ZIP 缺失时返回失败，不产生 available 或伪证据', async () => {
    const { db, databasePath, directory } = fixture()
    const itemId = item(db)
    await expect(saveOriginalZip(db, databasePath, itemId, join(directory, '不存在.zip'))).rejects.toThrow()
    expect(db.prepare('SELECT evidence_status, evidence_relative_path FROM batch_import_items WHERE id = ?').get(itemId)).toEqual({
      evidence_status: 'error', evidence_relative_path: null
    })
    expect(existsSync(join(directory, 'evidence', itemId, 'original.zip'))).toBe(false)
    expect((await verifyBatchEvidence(db, databasePath, itemId)).status).toBe('error')
    const recovered = join(directory, '恢复.zip')
    writeFileSync(recovered, emptyZip())
    await saveOriginalZip(db, databasePath, itemId, recovered)
    expect(db.prepare('SELECT status, evidence_status FROM batch_import_items WHERE id = ?').get(itemId)).toEqual({
      status: 'pending', evidence_status: 'available'
    })
  })

  it.skipIf(process.platform !== 'win32')('持久 ZIP 损坏时只读校验返回 corrupt，不覆盖损坏文件', async () => {
    const { db, databasePath, directory, zipPath } = fixture()
    const itemId = item(db)
    await saveOriginalZip(db, databasePath, itemId, zipPath)
    const target = join(directory, 'evidence', itemId, 'original.zip')
    writeFileSync(target, emptyZip('已损坏'))
    const verified = await verifyBatchEvidence(db, databasePath, itemId)
    expect(verified.zip.status).toBe('corrupt')
    expect(verified.status).toBe('corrupt')
    expect(readFileSync(target)).toEqual(emptyZip('已损坏'))
  })

  it.skipIf(process.platform !== 'win32')('快照损坏或缺失时分别返回 corrupt 和 missing', async () => {
    const { db, databasePath, directory, zipPath } = fixture()
    const itemId = item(db)
    await saveOriginalZip(db, databasePath, itemId, zipPath)
    await saveStructuredSnapshot(db, databasePath, itemId, messages())
    const target = join(directory, 'evidence', itemId, 'messages.json')
    writeFileSync(target, '{"schema_version":1,"input":{}}')
    expect((await verifyBatchEvidence(db, databasePath, itemId)).snapshot.status).toBe('corrupt')
    rmSync(target)
    expect((await verifyBatchEvidence(db, databasePath, itemId)).snapshot.status).toBe('missing')
  })

  it.skipIf(process.platform !== 'win32')('同一项重复保存相同 ZIP 与快照时幂等，不生成额外文件', async () => {
    const { db, databasePath, directory, zipPath } = fixture()
    const itemId = item(db)
    const firstZip = await saveOriginalZip(db, databasePath, itemId, zipPath)
    const firstSnapshot = await saveStructuredSnapshot(db, databasePath, itemId, messages())
    expect(await saveOriginalZip(db, databasePath, itemId, zipPath)).toEqual(firstZip)
    expect(await saveStructuredSnapshot(db, databasePath, itemId, messages())).toEqual(firstSnapshot)
    expect(readdirSync(join(directory, 'evidence', itemId)).sort()).toEqual(['messages.json', 'original.zip'])
    expect((await verifyBatchEvidence(db, databasePath, itemId)).status).toBe('available')
  })

  it.skipIf(process.platform !== 'win32')('同一项传入不同 ZIP 时明确拒绝且原证据仍可验证', async () => {
    const { db, databasePath, directory, zipPath } = fixture()
    const itemId = item(db)
    const original = await saveOriginalZip(db, databasePath, itemId, zipPath)
    const other = join(directory, 'other.zip')
    writeFileSync(other, emptyZip('另一个附件'))
    await expect(saveOriginalZip(db, databasePath, itemId, other)).rejects.toThrow('已有不同的 ZIP')
    expect((await verifyBatchEvidence(db, databasePath, itemId)).zip.status).toBe('available')
    expect(hash(readFileSync(join(directory, 'evidence', itemId, 'original.zip')))).toBe(original.sha256)
  })

  it.skipIf(process.platform !== 'win32')('字段顺序不同但内容相同的结构化输入生成同一快照哈希', async () => {
    const { db, databasePath, zipPath } = fixture()
    const session = createBatchImportSession(db, 'workbuddy')
    const a = createBatchImportItem(db, session.id, 0)
    const b = createBatchImportItem(db, session.id, 1)
    await saveOriginalZip(db, databasePath, a.id, zipPath)
    await saveOriginalZip(db, databasePath, b.id, zipPath)
    const original = messages()
    const reordered: WorkBuddyIngestInput = {
      messages: original.messages.map((message) => Object.fromEntries(Object.entries(message).reverse()) as WorkBuddyIngestInput['messages'][number]),
      source_batch_id: original.source_batch_id,
      import_mode: original.import_mode
    }
    const first = await saveStructuredSnapshot(db, databasePath, a.id, original)
    const second = await saveStructuredSnapshot(db, databasePath, b.id, reordered)
    expect(first.sha256).toBe(second.sha256)
  })

  it.skipIf(process.platform !== 'win32')('识别文件已落盘但数据库未登记的孤立原件，不静默接管或覆盖', async () => {
    const { db, databasePath, directory, zipPath } = fixture()
    const itemId = item(db)
    const evidenceDirectory = join(directory, 'evidence', itemId)
    mkdirSync(evidenceDirectory, { recursive: true })
    writeFileSync(join(evidenceDirectory, 'original.zip'), emptyZip())
    expect((await verifyBatchEvidence(db, databasePath, itemId)).zip.status).toBe('error')
    await expect(saveOriginalZip(db, databasePath, itemId, zipPath)).rejects.toThrow('目标路径已存在')
    expect(db.prepare('SELECT evidence_relative_path FROM batch_import_items WHERE id = ?').get(itemId)).toEqual({ evidence_relative_path: null })
  })

  it.skipIf(process.platform !== 'win32')('ZIP 已保存但快照保存失败时保留 ZIP，并明确标记附件项未准备完成', async () => {
    const { db, databasePath, zipPath } = fixture()
    const itemId = item(db)
    await saveOriginalZip(db, databasePath, itemId, zipPath)
    await expect(saveStructuredSnapshot(db, databasePath, itemId, { messages: [] })).rejects.toThrow()
    const row = db.prepare('SELECT status, evidence_status, snapshot_relative_path, error_summary FROM batch_import_items WHERE id = ?').get(itemId) as {
      status: string; evidence_status: string; snapshot_relative_path: string | null; error_summary: string
    }
    expect(row.status).toBe('failed')
    expect(row.evidence_status).toBe('available')
    expect(row.snapshot_relative_path).toBe(null)
    expect(row.error_summary).toContain('快照保存失败')
    expect((await verifyBatchEvidence(db, databasePath, itemId)).status).toBe('error')
    await saveStructuredSnapshot(db, databasePath, itemId, messages())
    expect((await verifyBatchEvidence(db, databasePath, itemId)).status).toBe('available')
  })

  it.skipIf(process.platform !== 'win32')('拒绝附件编号目录穿越及数据库中被篡改的相对路径', async () => {
    const { db, databasePath, zipPath } = fixture()
    const itemId = item(db)
    await expect(saveOriginalZip(db, databasePath, '../escape', zipPath)).rejects.toThrow('编号无效')
    await saveOriginalZip(db, databasePath, itemId, zipPath)
    db.prepare("UPDATE batch_import_items SET evidence_relative_path = '../escape' WHERE id = ?").run(itemId)
    expect((await verifyBatchEvidence(db, databasePath, itemId)).zip.status).toBe('corrupt')
  })
})
