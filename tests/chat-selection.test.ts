import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession } from '../src/main/batch-import/repository'
import { bindItemMessageSource } from '../src/main/batch-import/message-sources'
import { buildCanonicalExportSnapshot, captureExportSelection, platformDisplayName } from '../src/main/export/chat-selection'
import { EXPORT_LIMITS, EXPORT_POLICY } from '../src/shared/markdown-export'

const fixtures: Array<{ db: DatabaseSync; directory: string }> = []
const originalTimezone = process.env.TZ
afterEach(() => {
  vi.restoreAllMocks()
  if (originalTimezone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimezone
  for (const f of fixtures.splice(0)) {
    f.db.close()
    rmSync(f.directory, { recursive: true, force: true })
  }
})

function fixture(platform = 'wechat') {
  const directory = mkdtempSync(join(tmpdir(), 'privateradar-export-synthetic-'))
  const path = join(directory, 'synthetic.db')
  const db = new DatabaseSync(path)
  fixtures.push({ db, directory })
  initializeDatabase(db)
  db.prepare('INSERT INTO conversations (id,platform,name,created_at) VALUES (?,?,?,?)')
    .run('会话甲', platform, '合成会话', '2026-10-01T00:00:00.000Z')
  const insert = db.prepare(`INSERT INTO messages
    (id,platform,conversation_id,sender_id,sender_name,timestamp,content,message_type,source,
     source_batch_id,source_position,timestamp_source,sender_name_source,fingerprint,imported_at,attachments_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  function add(id: string, overrides: Record<string, unknown> = {}) {
    const row = { platform, conversation_id: '会话甲', sender_name: '合成人物', timestamp: '2026-10-01T00:00:00.000Z',
      content: '合成正文', message_type: 'text', source_batch_id: '批次甲', source_position: 0,
      timestamp_source: 'source_native', sender_name_source: 'source_native', attachments_json: '[]', ...overrides }
    insert.run(id, String(row.platform), String(row.conversation_id), '合成发送人', row.sender_name as string | null,
      row.timestamp as string | null, String(row.content), String(row.message_type), 'file:C:\\不得导出\\合成.json',
      String(row.source_batch_id), Number(row.source_position), String(row.timestamp_source), String(row.sender_name_source),
      id, '2099-01-01T00:00:00.000Z', String(row.attachments_json))
  }
  const request = { conversation_id: '会话甲', range: { type: 'conversation' as const, start_date: null, end_date: null } }
  return { db, path, add, request }
}

describe('导出公共契约与平台', () => {
  it('冻结策略与容量值不变', () => {
    expect(EXPORT_POLICY).toEqual({ schema_version: 1, template_version: 'markdown-safe-v1',
      render_policy: 'safe-single-line-else-fence-v1', time_policy: 'system-local-at-start-v1',
      order_policy: 'canonical-time-batch-position-id-v1' })
    expect(EXPORT_LIMITS.max_message_count).toBe(50000)
    expect(EXPORT_LIMITS.max_total_body_bytes).toBe(33554432)
    expect(EXPORT_LIMITS.page_size).toBe(256)
    expect(EXPORT_LIMITS.body_batch_bytes).toBe(2097152)
  })

  it.each([['wechat', '微信'], ['qq', 'QQ'], ['feishu', '飞书'], ['local-file', '本地文件'],
    ['future-platform', 'future-platform'], ['', '来源平台未提供'], [null, '来源平台未提供'],
    ['we\nchat', '来源平台未提供'], ['constructor', 'constructor'], ['__proto__', '__proto__']])('平台显示保留登记事实 %s', (platform, label) => {
    expect(platformDisplayName(platform)).toBe(label)
  })

  it.each(['wechat', 'local-file', 'future-platform', ''])('快照平台来自会话 %s', async platform => {
    const f = fixture(platform); f.add('消息甲')
    const result = await buildCanonicalExportSnapshot(f.path, f.request)
    expect(result.platform).toBe(platform || null)
    expect(result.conversation_id).toBe('会话甲')
    expect(result.conversation_name).toBe('合成会话')
    expect(result.conversation).toEqual({ id: '会话甲', platform: platform || null, display_name: '合成会话', sourceConversationName: '合成会话', userConversationLabel: null, displayConversationName: '合成会话' })
    expect(result.selection.platform).toBe(platform || null)
  })

  it('同名跨平台会话按完整会话标识隔离', async () => {
    const f = fixture(); f.add('微信消息')
    f.db.prepare('INSERT INTO conversations (id,platform,name,conversation_type,created_at) VALUES (?,?,?,?,?)').run('会话乙', 'local-file', '合成会话', 'group', '合成')
    f.add('文件消息', { conversation_id: '会话乙', platform: 'local-file' })
    const result = await buildCanonicalExportSnapshot(f.path, { ...f.request, conversation_id: '会话乙' })
    expect(result.platform).toBe('local-file')
    expect(result.messages.map(m => m.id)).toEqual(['文件消息'])
  })
})

describe('规范正文、顺序与未知事实', () => {
  it('完整正文逐字保留，未知发送人与导入时间不冒充来源事实', async () => {
    const f = fixture()
    const body = '  原始正文\r\n# 标题\n---\n![图片](x)\n```\n👩🏽‍💻 e\u0301\t  '
    f.add('消息甲', { content: body, sender_name: '推测人名', sender_name_source: 'inferred', timestamp_source: 'unknown' })
    const result = await buildCanonicalExportSnapshot(f.path, f.request)
    expect(result.messages[0]).toMatchObject({ content: body, sender_name: null, canonical_timestamp: null,
      local_date: null, local_time: null, evidence_status: 'unavailable' })
    expect(result.selection).toMatchObject({ message_count: 1, unknown_time_count: 1, excluded_unknown_time_count: 0 })
    expect(result.evidence.verification).toBe('not_performed')
  })

  it('同刻同文不同标识全部保留，按规范时间、二进制批次、位置、标识排序', async () => {
    const f = fixture()
    f.add('乙', { source_batch_id: 'a', source_position: 2 })
    f.add('甲', { source_batch_id: 'a', source_position: 2 })
    f.add('最早', { timestamp: '2026-09-30T23:59:59.999Z' })
    f.add('批次大写', { source_batch_id: 'A', source_position: 99 })
    f.add('位置靠前', { source_batch_id: 'a', source_position: 1 })
    f.add('未知乙', { timestamp_source: 'inferred', source_batch_id: 'b' })
    f.add('未知甲', { timestamp: null, source_batch_id: 'a' })
    const result = await buildCanonicalExportSnapshot(f.path, f.request)
    expect(result.messages.map(m => m.id)).toEqual(['最早', '批次大写', '位置靠前', '乙', '甲', '未知甲', '未知乙'])
  })

  it.each([null, '', '不是时间', '2026-02-30T00:00:00.000Z', '2026-10-01 08:00:00'])('无效规范时间归入未知，不重新解释 %s', async timestamp => {
    const f = fixture(); f.add('消息甲', { timestamp })
    expect((await buildCanonicalExportSnapshot(f.path, f.request)).messages[0].canonical_timestamp).toBeNull()
  })

  it('分页不依赖物理顺序，不丢失同刻消息，每页至多二百五十六条', async () => {
    const f = fixture()
    f.db.exec('BEGIN')
    for (let i = 599; i >= 0; i--) f.add(`消息${String(i).padStart(4, '0')}`, { source_position: i % 3 })
    f.db.exec('COMMIT')
    const expected = f.db.prepare('SELECT id FROM messages ORDER BY source_position,id COLLATE BINARY').all().map(r => r.id)
    const progress: number[] = []
    const result = await buildCanonicalExportSnapshot(f.path, f.request, { onProgress: p => progress.push(p.page_message_count) })
    expect(result.messages.map(m => m.id)).toEqual(expected)
    expect(progress).toEqual([256, 256, 88])
  })

  it('未知时间分区也使用二进制稳定键分页，可靠消息始终排在其前面', async () => {
    const f = fixture(); f.add('可靠消息', { timestamp_source: 'user_supplied' })
    for (let i = 599; i >= 0; i--) f.add(`未知${String(i).padStart(4, '0')}`, {
      timestamp_source: i % 2 ? 'inferred' : 'unknown', source_position: i % 3 })
    const expected = f.db.prepare("SELECT id FROM messages WHERE id!='可靠消息' ORDER BY source_position,id COLLATE BINARY")
      .all().map(r => r.id)
    const result = await buildCanonicalExportSnapshot(f.path, f.request)
    expect(result.messages.map(m => m.id)).toEqual(['可靠消息', ...expected])
    expect(result.messages.slice(1).every(m => m.canonical_timestamp === null)).toBe(true)
    expect(result.selection.unknown_time_count).toBe(600)
  })
})

describe('日期与捕获时区', () => {
  it('当地起日包含、终日次日排除，未知时间仅计入排除数', async () => {
    process.env.TZ = 'Asia/Shanghai'
    const f = fixture()
    for (const [id, timestamp] of [['之前', '2026-09-30T15:59:59.999Z'], ['起点', '2026-09-30T16:00:00.000Z'],
      ['终点内', '2026-10-01T15:59:59.999Z'], ['终点外', '2026-10-01T16:00:00.000Z']]) f.add(id, { timestamp })
    f.add('未知', { timestamp_source: 'unknown' })
    const result = await buildCanonicalExportSnapshot(f.path, { ...f.request,
      range: { type: 'date_range', start_date: '2026-10-01', end_date: '2026-10-01' } })
    expect(result.messages.map(m => m.id)).toEqual(['起点', '终点内'])
    expect(result.messages[0]).toMatchObject({ local_date: '2026-10-01', local_time: '00:00' })
    expect(result.selection).toMatchObject({ timezone: 'Asia/Shanghai', message_count: 2, excluded_unknown_time_count: 1 })
  })

  it('夏令时使用当地日历次日而非固定二十四小时', () => {
    process.env.TZ = 'America/New_York'
    const range = (date: string) => captureExportSelection({ conversation_id: '合成',
      range: { type: 'date_range', start_date: date, end_date: date } })
    const spring = range('2026-03-08'), autumn = range('2026-11-01')
    expect(Date.parse(spring.end_exclusive_utc!) - Date.parse(spring.start_inclusive_utc!)).toBe(23 * 3600000)
    expect(Date.parse(autumn.end_exclusive_utc!) - Date.parse(autumn.start_inclusive_utc!)).toBe(25 * 3600000)
  })

  it('不存在的当地午夜拒绝执行', () => {
    process.env.TZ = 'Pacific/Apia'
    expect(() => captureExportSelection({ conversation_id: '合成',
      range: { type: 'date_range', start_date: '2011-12-30', end_date: '2011-12-30' } })).toThrow('TIME_BOUNDARY_UNSUPPORTED')
  })

  it.each([
    { type: 'date_range', start_date: '2026-10-01', end_date: null },
    { type: 'date_range', start_date: '2026-02-30', end_date: '2026-03-01' },
    { type: 'date_range', start_date: '2026-10-02', end_date: '2026-10-01' },
    { type: 'conversation', start_date: '2026-10-01', end_date: '2026-10-02' },
    { type: '其他', start_date: null, end_date: null }
  ])('拒绝非法范围 %j', range => {
    expect(() => captureExportSelection({ conversation_id: '合成', range } as never)).toThrow('INVALID_SELECTION')
  })

  it('空范围返回明确的空快照', async () => {
    const f = fixture(); f.add('消息甲')
    const result = await buildCanonicalExportSnapshot(f.path, { ...f.request,
      range: { type: 'date_range', start_date: '2098-01-01', end_date: '2098-01-01' } })
    expect(result.messages).toEqual([])
    expect(result.selection.message_count).toBe(0)
  })
})

describe('来源与附件投影', () => {
  it('一个正文保留所有来源位置，登记与重新验证分开，输出不带机器路径', async () => {
    const f = fixture(); f.add('消息甲')
    const session = createBatchImportSession(f.db, 'synthetic')
    const items = [createBatchImportItem(f.db, session.id, 0), createBatchImportItem(f.db, session.id, 1)]
    for (const [i, item] of items.entries()) {
      f.db.prepare(`UPDATE batch_import_items SET source_batch_id=?,evidence_status='available',snapshot_sha256=?,
        evidence_relative_path=?,snapshot_relative_path=? WHERE id=?`).run(`来源${i}`, 'a'.repeat(64),
          'C:\\禁止读取\\原始.zip', 'C:\\禁止读取\\快照.json', item.id)
      for (let position = 0; position < 2; position++) bindItemMessageSource(f.db, item.id, position, '消息甲', '合成登记', {
        senderName: '来源人物', senderNameSource: 'source_native', timestamp: '', timestampSource: 'unknown',
        conversationName: '来源会话', conversationNameSource: 'source_native' })
    }
    const result = await buildCanonicalExportSnapshot(f.path, f.request)
    expect(result.messages).toHaveLength(1)
    expect(result.sources).toHaveLength(2)
    expect(result.evidence.occurrences).toHaveLength(4)
    expect(result.messages[0]).toMatchObject({ evidence_status: 'registered',
      canonical_origin: { source_batch_id: '批次甲', source_position: 0 } })
    expect(result.evidence).toMatchObject({ verification: 'not_performed', is_evidence_backup: false })
    expect(JSON.stringify(result)).not.toMatch(/禁止读取|不得导出|relative_path|raw_metadata|imported_at/)
  })

  it('附件只按登记类型投影，占位不猜正文或扩展名', async () => {
    const f = fixture()
    f.add('有附件', { attachments_json: JSON.stringify([{ type: 'image', path: 'C:\\秘密.png' },
      { type: 'audio' }, { type: 'video' }, { type: 'file' }, 'photo.jpg', { type: 'other' }]) })
    f.add('仅正文', { content: '[图片] 假文件.png' })
    f.add('缺登记', { message_type: 'image' })
    const result = await buildCanonicalExportSnapshot(f.path, f.request)
    expect(result.attachments.map(a => a.kind)).toEqual(['image', 'audio', 'video', 'file', 'unknown', 'unknown', 'missing'])
    expect(result.attachments.every(a => a.copied === false && a.file_state === 'not_checked')).toBe(true)
    expect(JSON.stringify(result.attachments)).not.toContain('秘密')
  })
})

describe('一致只读快照与容量保护', () => {
  it('输出快照及其嵌套数组被冻结，不能被格式渲染器改写', async () => {
    const f = fixture(); f.add('消息甲')
    const snapshot = await buildCanonicalExportSnapshot(f.path, f.request)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.messages)).toBe(true)
    expect(Object.isFrozen(snapshot.messages[0].canonical_origin)).toBe(true)
  })

  it('读取超时和预先取消均明确失败并释放事务', async () => {
    const f = fixture(); f.add('消息甲')
    const controller = new AbortController(); controller.abort()
    await expect(buildCanonicalExportSnapshot(f.path, f.request, { signal: controller.signal })).rejects.toThrow('EXPORT_CANCELLED')
    const realNow = performance.now.bind(performance)
    let expired = false
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + (expired ? 31000 : 0))
    await expect(buildCanonicalExportSnapshot(f.path, f.request, { onProgress: () => { expired = true } }))
      .rejects.toThrow('READ_SNAPSHOT_TIMEOUT')
    vi.restoreAllMocks()
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  })

  it('成功时数据库字节和结构不变', async () => {
    const f = fixture(); f.add('消息甲')
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const before = readFileSync(f.path)
    const schema = f.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
    await buildCanonicalExportSnapshot(f.path, f.request)
    expect(readFileSync(f.path)).toEqual(before)
    expect(f.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema)
  })

  it('分页间其他连接新增消息和来源不会进入本次快照', async () => {
    const f = fixture()
    for (let i = 0; i < 300; i++) f.add(`消息${i}`, { source_position: i })
    const session = createBatchImportSession(f.db, 'synthetic'), item = createBatchImportItem(f.db, session.id, 0)
    let changed = false
    const result = await buildCanonicalExportSnapshot(f.path, f.request, { onProgress: () => {
      if (!changed) {
        changed = true; f.add('后来消息'); f.db.prepare("UPDATE messages SET content='后来改写' WHERE id='消息299'").run()
        bindItemMessageSource(f.db, item.id, 0, '消息299', '合成', { senderName: '', senderNameSource: 'unknown',
          timestamp: '', timestampSource: 'unknown', conversationName: '', conversationNameSource: 'unknown' })
      }
    } })
    expect(result.messages).toHaveLength(300)
    expect(result.messages.every(m => m.content === '合成正文')).toBe(true)
    expect(result.selection.message_count).toBe(300)
    expect(result.evidence.occurrences).toEqual([])
    expect((await buildCanonicalExportSnapshot(f.path, f.request)).messages).toHaveLength(301)
  })

  it('取消及时失败并释放连接', async () => {
    const f = fixture(); for (let i = 0; i < 300; i++) f.add(`消息${i}`)
    const controller = new AbortController()
    await expect(buildCanonicalExportSnapshot(f.path, f.request, { signal: controller.signal,
      onProgress: () => controller.abort() })).rejects.toThrow('EXPORT_CANCELLED')
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    expect((await buildCanonicalExportSnapshot(f.path, f.request)).messages).toHaveLength(300)
  })

  it('执行中系统时区改变则失败', async () => {
    process.env.TZ = 'Asia/Shanghai'
    const f = fixture(); f.add('消息甲')
    await expect(buildCanonicalExportSnapshot(f.path, f.request, { onProgress: () => { process.env.TZ = 'UTC' } }))
      .rejects.toThrow('TIMEZONE_CHANGED')
  })

  it('二兆字节正文批次上限在实际读取前生效', async () => {
    const f = fixture()
    for (let i = 0; i < 5; i++) f.add(`消息${i}`, { content: 'x'.repeat(1048576) })
    const batches: number[] = []
    const result = await buildCanonicalExportSnapshot(f.path, f.request, { onProgress: p => batches.push(p.max_body_batch_bytes) })
    expect(result.messages).toHaveLength(5)
    expect(Math.max(...batches)).toBe(2097152)
  })

  it('正文按字节限制，超限失败而非截断', async () => {
    const f = fixture(); f.add('超限', { content: '汉'.repeat(349526) })
    await expect(buildCanonicalExportSnapshot(f.path, f.request)).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
  })

  it('过长元数据读取前拒绝', async () => {
    const f = fixture(); f.add('超限', { sender_name: 'x'.repeat(8193) })
    await expect(buildCanonicalExportSnapshot(f.path, f.request)).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
  })

  it('元数据预检覆盖所有消息而非任意首行', async () => {
    const f = fixture(); f.add('正常'); f.add('超限', { sender_name: 'x'.repeat(8193) })
    const read = vi.fn()
    await expect(buildCanonicalExportSnapshot(f.path, f.request, { onProgress: read })).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
    expect(read).not.toHaveBeenCalled()
  })

  it('超过正文总量上限拒绝执行', async () => {
    const f = fixture(); f.db.exec('BEGIN')
    for (let i = 0; i < 33; i++) f.add(`消息${i}`, { content: 'x'.repeat(1048576) })
    f.db.exec('COMMIT')
    await expect(buildCanonicalExportSnapshot(f.path, f.request)).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
  })

  it('单消息超过一页的来源出现全部保留，且分页采用稳定键', async () => {
    const f = fixture(); f.add('消息甲')
    const session = createBatchImportSession(f.db, 'synthetic'), item = createBatchImportItem(f.db, session.id, 0)
    f.db.exec('BEGIN')
    for (let i = 599; i >= 0; i--) bindItemMessageSource(f.db, item.id, i, '消息甲', '合成', {
      senderName: '', senderNameSource: 'unknown', timestamp: '', timestampSource: 'unknown',
      conversationName: '', conversationNameSource: 'unknown' })
    f.db.exec('COMMIT')
    const result = await buildCanonicalExportSnapshot(f.path, f.request)
    expect(result.evidence.occurrences.map(o => o.source_position)).toEqual(Array.from({ length: 600 }, (_, i) => i))
    expect(result.sources[0].evidence_status).toBe('unavailable')
  })

  it('来源查询及正文读取按页批量执行，不逐消息查询', async () => {
    const f = fixture()
    for (let i = 0; i < 600; i++) f.add(`消息${i}`)
    const queries: string[] = [], prepare = DatabaseSync.prototype.prepare
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      queries.push(sql); return prepare.call(this, sql)
    })
    await buildCanonicalExportSnapshot(f.path, f.request)
    expect(queries.filter(sql => sql.includes('FROM batch_item_message_sources s'))).toHaveLength(3)
    expect(queries.filter(sql => sql.startsWith('SELECT id,content FROM messages'))).toHaveLength(3)
    expect(queries.some(sql => /\bOFFSET\b|messages_fts/i.test(sql))).toBe(false)
  })

  it('数据库排他锁最多等待冻结的一秒，失败后仍可重试', async () => {
    const f = fixture(); f.add('消息甲')
    f.db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE')
    try {
      await expect(buildCanonicalExportSnapshot(f.path, f.request)).rejects.toThrow('EXPORT_DATABASE_BUSY')
    } finally { f.db.exec('ROLLBACK') }
    expect((await buildCanonicalExportSnapshot(f.path, f.request)).messages).toHaveLength(1)
  })

  it('超过十万附件占位明确拒绝，不返回部分快照', async () => {
    const f = fixture(), attachments = JSON.stringify(Array.from({ length: 100 }, () => ({ type: 'file' })))
    f.db.exec('BEGIN')
    for (let i = 0; i < 1000; i++) f.add(`消息${i}`, { attachments_json: attachments })
    f.db.exec('COMMIT')
    expect((await buildCanonicalExportSnapshot(f.path, f.request)).attachments).toHaveLength(100000)
    f.add('超限消息', { attachments_json: attachments })
    await expect(buildCanonicalExportSnapshot(f.path, f.request)).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
  }, 15000)

  it('超过一万个不同来源项明确拒绝', async () => {
    const f = fixture(); f.add('消息甲')
    const session = createBatchImportSession(f.db, 'synthetic')
    const itemInsert = f.db.prepare(`INSERT INTO batch_import_items
      (id,batch_session_id,ordinal,created_at,updated_at) VALUES (?,?,?,'合成','合成')`)
    const relationInsert = f.db.prepare(`INSERT INTO batch_item_message_sources
      (batch_item_id,source_position,message_id,created_at,source_sender_name_source,source_timestamp_source,source_conversation_name_source)
      VALUES (?,0,'消息甲','合成','unknown','unknown','unknown')`)
    f.db.exec('BEGIN')
    for (let i = 0; i < 10000; i++) { itemInsert.run(`来源${i}`, session.id, i); relationInsert.run(`来源${i}`) }
    f.db.exec('COMMIT')
    expect((await buildCanonicalExportSnapshot(f.path, f.request)).sources).toHaveLength(10000)
    itemInsert.run('超限来源', session.id, 10000); relationInsert.run('超限来源')
    await expect(buildCanonicalExportSnapshot(f.path, f.request)).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
  }, 30000)

  it('超过二十万来源关系明确拒绝', async () => {
    const f = fixture(); f.add('消息甲')
    const session = createBatchImportSession(f.db, 'synthetic'), item = createBatchImportItem(f.db, session.id, 0)
    const insert = f.db.prepare(`INSERT INTO batch_item_message_sources
      (batch_item_id,source_position,message_id,created_at,source_sender_name_source,source_timestamp_source,source_conversation_name_source)
      VALUES (?,?,'消息甲','合成','unknown','unknown','unknown')`)
    f.db.exec('BEGIN')
    for (let i = 0; i < 200000; i++) insert.run(item.id, i)
    f.db.exec('COMMIT')
    expect((await buildCanonicalExportSnapshot(f.path, f.request)).evidence.occurrences).toHaveLength(200000)
    insert.run(item.id, 200000)
    await expect(buildCanonicalExportSnapshot(f.path, f.request)).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
  }, 60000)

  it('附件登记损坏或关联其他消息时输出保守占位', async () => {
    const f = fixture()
    f.add('消息甲', { attachments_json: '{损坏' })
    f.add('消息乙', { attachments_json: JSON.stringify([{ type: 'image', message_id: '别的消息' }]) })
    expect((await buildCanonicalExportSnapshot(f.path, f.request)).attachments.map(a => a.kind)).toEqual(['ambiguous', 'unknown'])
  })

  it('未知会话与注入字符串不能扩大查询范围', async () => {
    const f = fixture(); f.add('消息甲')
    await expect(buildCanonicalExportSnapshot(f.path, { ...f.request, conversation_id: "' OR 1=1 --" }))
      .rejects.toThrow('CONVERSATION_NOT_FOUND')
  })

  it('已有空库不触发初始化或迁移，不存在的库不创建', async () => {
    const f = fixture(), empty = join(fixtures.at(-1)!.directory, '空库.db')
    const db = new DatabaseSync(empty); db.close()
    await expect(buildCanonicalExportSnapshot(empty, f.request)).rejects.toThrow()
    const check = new DatabaseSync(empty, { readOnly: true })
    expect(check.prepare('SELECT name FROM sqlite_master').all()).toEqual([]); check.close()
    await expect(buildCanonicalExportSnapshot(join(fixtures.at(-1)!.directory, '不存在.db'), f.request)).rejects.toThrow()
  })
})

describe('合成会话查询容量验证', () => {
  const metrics: object[] = []
  it.each([100, 1000, 10000, 50000])('%i 条消息完成只读查询与完整快照', async count => {
    const f = fixture(); f.db.exec('BEGIN')
    for (let i = count - 1; i >= 0; i--) f.add(`消息${String(i).padStart(6, '0')}`, {
      source_position: i, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() })
    f.db.exec('COMMIT')
    const start = performance.now()
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    try {
      const result = await buildCanonicalExportSnapshot(f.path, f.request)
      expect(result.messages).toHaveLength(count)
      expect(result.messages[0].id).toBe('消息000000')
      expect(result.messages.at(-1)!.canonical_origin.source_position).toBe(count - 1)
      const metric = { synthetic: true, message_count: count, body_bytes: result.selection.total_body_bytes,
        source_relations: result.evidence.occurrences.length, attachments: result.attachments.length,
        query_duration_ms: Math.round(performance.now() - start), event_loop_ticks: ticks }
      metrics.push(metric)
      console.info(JSON.stringify(metric))
      if (process.env.PRIVATE_RADAR_EXPORT_METRICS_PATH) writeFileSync(process.env.PRIVATE_RADAR_EXPORT_METRICS_PATH, JSON.stringify(metrics, null, 2))
    } finally { clearInterval(timer) }
    if (count === 50000) {
      f.add('超过上限')
      await expect(buildCanonicalExportSnapshot(f.path, f.request)).rejects.toThrow('EXPORT_LIMIT_EXCEEDED')
    }
  }, 120000)
})
