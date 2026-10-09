import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { isRecord, parseByFileType } from './adapters'
import { normalizeMessage } from './normalize'

export const MANUAL_JSON_MAX_BYTES = 50 * 1024 * 1024

export interface ManualJsonItem {
  sourceBatchId: string
  batchSessionId: string
  status: string
  effectiveJobId: string | null
}

/** 只读取后端登记的来源身份；输入标记、文件名和渲染进程声明均不能切换契约。 */
export function getManualJsonItem(db: DatabaseSync, itemId?: string): ManualJsonItem | null {
  if (!itemId) return null
  const row = db.prepare(
    "SELECT i.source_batch_id,i.batch_session_id,i.status,i.effective_job_id FROM batch_import_items i " +
    "JOIN batch_import_sessions s ON s.id=i.batch_session_id WHERE i.id=? AND s.source='file' " +
    "AND i.evidence_source_kind='zip' AND i.source_batch_id='file:json:item:' || i.id"
  ).get(itemId)
  return row ? { sourceBatchId: String(row.source_batch_id), batchSessionId: String(row.batch_session_id),
    status: String(row.status), effectiveJobId: row.effective_job_id == null ? null : String(row.effective_job_id) } : null
}

export interface ManualJsonSnapshotInput {
  source_kind: 'manual_json'
  raw_source_sha256: string
  raw_source_bytes: number
  messages: Array<{ source_position: number; valid: boolean; value: unknown }>
}

function validRecord(value: unknown): boolean {
  try {
    normalizeMessage(value, 'file', { sourceBatchId: 'snapshot', preserveSourceContent: true })
    return true
  } catch { return false }
}

export function createManualJsonSnapshot(bytes: Buffer): ManualJsonSnapshotInput {
  const parsed = parseByFileType('JSON', bytes.toString('utf8'))
  return {
    source_kind: 'manual_json',
    raw_source_sha256: createHash('sha256').update(bytes).digest('hex'),
    raw_source_bytes: bytes.length,
    messages: parsed.rows.map((row, index) => ({ source_position: index, valid: validRecord(row.value), value: row.value }))
  }
}

export function validateManualJsonSnapshot(value: unknown): ManualJsonSnapshotInput {
  if (!isRecord(value) || value.source_kind !== 'manual_json' ||
      typeof value.raw_source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.raw_source_sha256) ||
      typeof value.raw_source_bytes !== 'number' || !Number.isSafeInteger(value.raw_source_bytes) ||
      value.raw_source_bytes < 0 || value.raw_source_bytes > MANUAL_JSON_MAX_BYTES || !Array.isArray(value.messages)) {
    throw new Error('手动 JSON 快照格式无效')
  }
  for (const [index, row] of value.messages.entries()) {
    if (!isRecord(row) || row.source_position !== index || typeof row.valid !== 'boolean' ||
        !Object.hasOwn(row, 'value') || row.valid !== validRecord(row.value)) {
      throw new Error('手动 JSON 快照的原始位置或有效性标记无效')
    }
  }
  return value as unknown as ManualJsonSnapshotInput
}

/** 单条目、无压缩 ZIP；固定名称只承载捕获字节，不参与来源去重。 */
export function createManualJsonZip(bytes: Buffer): Buffer {
  const name = Buffer.from('source.json')
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22)
  const checksum = crc32(bytes)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x21, 12)
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22)
  local.writeUInt16LE(name.length, 26)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24)
  central.writeUInt16LE(name.length, 28)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + bytes.length, 16)
  return Buffer.concat([local, name, bytes, central, name, end])
}

export class SourceContentConflictError extends Error {
  constructor(position: number, fingerprintConflict = true) {
    super('SOURCE_CONTENT_CONFLICT: 本来源未导入：有消息与已有记录的' +
      (fingerprintConflict ? '归一化指纹相同' : '来源身份相同') +
      '，但原文不同。为保护来源真实性，本次导入已整体回滚，未绑定来源、未覆盖或修改已有记录。' +
      '（source_position=' + position + '）')
    this.name = 'SourceContentConflictError'
  }
}
