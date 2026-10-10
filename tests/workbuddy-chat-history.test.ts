import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseByFileType } from '../src/main/import/adapters'
import { parseWorkBuddyChatHistoryText, WorkBuddyChatParseError } from '../src/main/import/workbuddy-chat-history'
import { initializeDatabase } from '../src/main/schema'
import { createBatchImportItem, createBatchImportSession, listBatchImportItems } from '../src/main/batch-import/repository'
import { saveOriginalZip, saveStructuredSnapshot } from '../src/main/batch-import/evidence'
import { executeBatchImportSession } from '../src/main/batch-import/session'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { workBuddyIngestSchema, type WorkBuddyIngestInput } from '../src/main/integrations/workbuddy/validation'

const fixtureRoot = new URL('./fixtures/workbuddy-chat-history/', import.meta.url)
const directories: string[] = []
const databases: DatabaseSync[] = []

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  while (directories.length) {
    const directory = directories.pop()!
    if (dirname(directory) !== tmpdir() || !basename(directory).startsWith('privateradar-chat-parser-')) {
      throw new Error('测试清理目标不在本轮临时目录范围内')
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(name: string): string {
  return readFileSync(new URL(name, fixtureRoot), 'utf8')
}

function block(sender: string, time: string, content: string): string {
  return `${sender}\n${time}\n${content}`
}

function parse(text: string, count = 1) {
  return parseWorkBuddyChatHistoryText(text, { expectedMessageCount: count })
}

function errorFor(text: string, count = 1): WorkBuddyChatParseError {
  try {
    parse(text, count)
  } catch (error) {
    expect(error).toBeInstanceOf(WorkBuddyChatParseError)
    return error as WorkBuddyChatParseError
  }
  throw new Error('预期解析停止，但实际返回了消息')
}

describe('WorkBuddy 聊天文本虚构样本', () => {
  it.each([
    ['a', 3, '1a70bd3db47b5f8dc581b5f61102bb0561b6a7637f494ef02dfe08ee232608b0'],
    ['b', 4, 'c916f57249009762b306b7ca53e881f7c8531d54300338883b58829f589cceb7'],
    ['c', 5, '7dcc80c03b6ce10fcae75abb4e89966e6c77cc86b37798018e104b39f8d47984']
  ] as const)('虚构样本 %s 保持来源字节、原始顺序和可靠时间', (name, count, sha256) => {
    const text = fixture(`card-${name}.txt`)
    expect(createHash('sha256').update(text).digest('hex')).toBe(sha256)
    const result = parse(text, count)
    expect(result.messages).toHaveLength(count)
    expect(result.messages.map((message) => message.source_position)).toEqual(Array.from({ length: count }, (_, index) => index))
    expect(result.messages.every((message) => message.sender_name.startsWith('·'))).toBe(true)
    expect(result.messages.every((message) => message.timestamp_source === 'source_native')).toBe(true)
    expect(result.messages.map((message) => `${message.sender_name}\n${message.source_time_text}\n${message.content}`).join('\n\n') + '\n').toBe(text)
    expect(workBuddyIngestSchema.safeParse({ messages: result.messages }).success).toBe(true)
  })

  it.each([['a', 3], ['b', 4]] as const)('样本 %s 与历史快照逐条对照，姓名加工差异单独保留', (name, count) => {
    const input = (JSON.parse(fixture(`card-${name}-agent-snapshot.json`)) as { input: WorkBuddyIngestInput }).input
    const result = parse(fixture(`card-${name}.txt`), count)
    expect(result.messages.map(({ content, timestamp, source_position }) => ({ content, timestamp, source_position })))
      .toEqual(input.messages.map(({ content, timestamp, source_position }) => ({ content, timestamp, source_position })))
    expect(result.messages.map((message) => message.sender_name)).toEqual(input.messages.map((message) => `·${message.sender_name}`))
    expect(result.messages.map((message) => message.sender_name)).not.toEqual(input.messages.map((message) => message.sender_name))
  })

  it('新五条样本只根据原文确认姓名、正文、同一分钟及特殊空白', () => {
    const messages = parse(fixture('card-c.txt'), 5).messages
    expect(messages.map(({ sender_name, content, timestamp }) => [sender_name, content, timestamp])).toEqual([
      ['·虚构用户4', '虚构说明22', '2001-01-16T17:00:00+08:00'],
      ['·虚构用户5', '甲', '2001-01-16T17:02:00+08:00'],
      ['·虚构用户4', '虚构说明23。', '2001-01-16T17:26:00+08:00'],
      ['·虚构用户5', '甲', '2001-01-16T17:26:00+08:00'],
      ['·虚构用户6📿', '@虚构说明24 虚构说明25 虚构说明26', '2001-01-16T18:22:00+08:00']
    ])
  })
})

describe('当前卡片七条虚构 inline transcript 验收', () => {
  const text = fixture('current-inline-seven.txt')

  it('完全虚构 fixture 字节固定，保留 inline 格式契约', () => {
    expect(createHash('sha256').update(text).digest('hex'))
      .toBe('7829f24d8504517c201830f935072f49a70dad8e44249b20ee028b48f820779e')
    expect(text).toContain('\r\n')
  })

  it('七条消息的发送人、原文时间、位置与顺序正确', () => {
    const messages = parse(text, 7).messages
    const keeper = '·虚构用户7-###'
    expect(messages.map(({ sender_name, source_time_text, source_position }) =>
      [sender_name, source_time_text, source_position])).toEqual([
      [keeper, '2001年1月15日 18:30', 0],
      ['·虚构用户8', '2001年1月16日 12:54', 1],
      ['·虚构用户9', '2001年1月16日 13:07', 2],
      [keeper, '2001年1月16日 18:24', 3],
      [keeper, '2001年1月17日 09:06', 4],
      ['·虚构用户10.', '2001年1月17日 15:11', 5],
      [keeper, '2001年1月17日 18:28', 6]
    ])
    expect(messages.every((message) => message.content.trim().length > 0)).toBe(true)
  })

  it('每段正文、空白、emoji 和换行可完整重建，不清洗姓名', () => {
    const messages = parse(text, 7).messages
    const reconstructed = messages.map((message) =>
      `${message.sender_name}\n${message.source_time_text}\n${message.content}`).join('\n\n')
    expect(reconstructed).toBe(text.replace(/\r\n/g, '\n'))
    expect(messages[0].content).toBe(messages[3].content)
    expect(messages[4].content).toContain('【虚构说明62🍀  】')
    expect(messages[4].content).toContain('\n　　为了')
    expect(messages[4].content).toContain('🚫')
    expect(messages[4].content).toContain('🏡')
    expect(messages[6].content).toContain('00000000006                      值班时间')
  })

  it('正文日期与多种值班时间不生成第八条消息', () => {
    const messages = parse(text, 7).messages
    expect(messages).toHaveLength(7)
    for (const value of ['18:30', '21:30', '19:00', '7:00']) {
      expect(messages[0].content).toContain(value)
    }
    // 虚构原文这里使用全角冒号，保留原值，不改为半角测试数据。
    expect(messages[4].content).toContain('14：00-18：00')
    expect(messages[4].content).toMatch(/虚构服务中心\n2001年1月17日$/)
    expect(messages[4].timestamp).toBe('2001-01-17T09:06:00+08:00')
  })

  it('逐条时间来自各自消息头，时区解释单独保留', () => {
    const result = parse(text, 7)
    expect(result.messages.map((message) => message.timestamp)).toEqual([
      '2001-01-15T18:30:00+08:00', '2001-01-16T12:54:00+08:00',
      '2001-01-16T13:07:00+08:00', '2001-01-16T18:24:00+08:00',
      '2001-01-17T09:06:00+08:00', '2001-01-17T15:11:00+08:00',
      '2001-01-17T18:28:00+08:00'
    ])
    expect(result.messages.every((message) => message.timestamp_source === 'source_native')).toBe(true)
    expect(result.timezone_interpretation).toEqual({ offset: '+08:00', source: 'system_interpretation',
      source_provided_timezone: false, source_precision: 'minute' })
  })
})

describe('WorkBuddy 聊天文本消息契约', () => {
  it('单条消息保留原文时间行，并将时区解释与源时间分开', () => {
    expect(parse(block('·甲', '2001年1月16日 09:00', '正文'))).toMatchObject({
      grammar_version: 1,
      timezone_interpretation: { offset: '+08:00', source: 'system_interpretation', source_provided_timezone: false, source_precision: 'minute' },
      messages: [{ sender_name: '·甲', content: '正文', timestamp: '2001-01-16T09:00:00+08:00',
        timestamp_source: 'source_native', source_time_text: '2001年1月16日 09:00', source_position: 0 }]
    })
  })

  it.each(['·虚构用户1', '-', '123', '虚构用户2', '李', '·虚构用户4', '·虚构用户6📿', ' A '])('发送人 %s 原样保留', (sender) => {
    expect(parse(block(sender, '2001年1月16日 09:00', '正文')).messages[0].sender_name).toBe(sender)
  })

  it('多条跨日期消息按文件顺序保留，不按时间排序', () => {
    const text = [block('·甲', '2001年1月16日 09:00', '后一天'), block('·乙', '2026年6月19日 08:00', '早一天')].join('\n\n')
    expect(parse(text, 2).messages.map(({ content, source_position, timestamp }) => [content, source_position, timestamp])).toEqual([
      ['后一天', 0, '2001-01-16T09:00:00+08:00'], ['早一天', 1, '2026-06-19T08:00:00+08:00']
    ])
  })

  it('物业长通知保留多个段落、缩进、行尾空格和内部空行', () => {
    const body = '各位业主：\n  本周进行设备巡检。  \n\n第一阶段：\n请清理通道。\n\n\n第二阶段：\n  请保管随身物品。\n落款：虚构服务中心'
    const text = [block('·物业', '2001年1月16日 09:00', body), block('·业主', '2001年1月16日 09:01', '收到')].join('\n\n')
    expect(parse(text, 2).messages[0].content).toBe(body)
  })

  it('仅移除一个结构分隔空行，保留正文末尾其余空行', () => {
    const body = '第一段\n\n'
    const text = [block('·甲', '2001年1月16日 09:00', body), block('·乙', '2001年1月16日 09:01', '下一条')].join('\n\n')
    expect(parse(text, 2).messages[0].content).toBe(body)
  })

  it.each(['[动画表情]', '[文件] 网盘流量执行白皮书-7.pdf', '[图片] 微信图片.jpg'])('可见占位 %s 原样作为正文保留', (content) => {
    expect(parse(block('·甲', '2001年1月16日 09:00', content)).messages[0].content).toBe(content)
  })

  it('正文相同、同一分钟的两条消息分别输出，不去重', () => {
    const message = block('·甲', '2001年1月16日 09:00', '相同推广正文')
    const messages = parse(`${message}\n\n${message}`, 2).messages
    expect(messages.map((message) => message.source_position)).toEqual([0, 1])
    expect(messages[0].content).toBe(messages[1].content)
    expect(messages[0].timestamp).toBe(messages[1].timestamp)
  })

  it('正文中的普通日期句子与非边界日期行不会变成消息头', () => {
    const body = '计划于2001年1月16日 09:00开始。\n2001年1月17日举办活动。\n\n活动日期\n下一段中注明：2026年9月29日。'
    expect(parse(block('·甲', '2001年1月16日 08:00', body)).messages[0].content).toBe(body)
  })

  it('正文内部独立完整日期行在没有消息分隔时仍保留', () => {
    const body = '通知说明\n2001年1月16日 09:00\n上述是正文列出的活动时间'
    expect(parse(block('·甲', '2001年1月16日 08:00', body)).messages[0].content).toBe(body)
  })

  it.each(['\n', '\r\n'])('换行格式 %j 产生相同输出', (newline) => {
    const lf = fixture('card-b.txt')
    expect(parse(lf.replace(/\n/g, newline), 4)).toEqual(parse(lf, 4))
  })

  it('只处理文件开头 BOM，同样文本重复解析结果固定', () => {
    const text = fixture('card-a.txt')
    expect(parse(`\uFEFF${text}`, 3)).toEqual(parse(text, 3))
    expect(parse(text, 3)).toEqual(parse(text, 3))
  })

  it('同样文本位于不同临时路径并具有不同 mtime 时结果固定', () => {
    const directory = mkdtempSync(join(tmpdir(), 'privateradar-chat-parser-'))
    directories.push(directory)
    const first = join(directory, '甲.txt'), second = join(directory, '乙.txt')
    writeFileSync(first, fixture('card-b.txt')); copyFileSync(first, second)
    utimesSync(first, 1, 1); utimesSync(second, 100000, 100000)
    expect(parse(readFileSync(first, 'utf8'), 4)).toEqual(parse(readFileSync(second, 'utf8'), 4))
  })

  it('原有通用 TXT adapter 保持原来的两种格式', () => {
    const text = '2001-01-16 09:00\t原群\t原发送人\t原正文\n[2001-01-16 09:01] 原群 | 原发送人: 下一条'
    expect(parseByFileType('TXT', text)).toMatchObject({ errors: [], totalCount: 2, rows: [
      { value: { content: '原正文' } }, { value: { content: '下一条' } }
    ] })
    expect(parseByFileType('TXT', fixture('card-a.txt')).rows).toHaveLength(0)
  })
})

describe('WorkBuddy 聊天文本格式冲突时停止', () => {
  it.each([
    ['', 'INVALID_TEXT'],
    ['\n2001年1月16日 09:00\n正文', 'INVALID_SENDER'],
    ['·甲\n正文没有时间', 'MISSING_OR_INVALID_TIME'],
    ['·甲\n时间未提供\n正文', 'MISSING_OR_INVALID_TIME'],
    ['·甲\n2001年1月16日\n正文', 'MISSING_OR_INVALID_TIME'],
    ['·甲\n09:00\n正文', 'MISSING_OR_INVALID_TIME'],
    ['·甲\n2001年1月16日 9:00\n正文', 'MISSING_OR_INVALID_TIME'],
    ['·甲\n2001年1月16日 09:00 +08:00\n正文', 'MISSING_OR_INVALID_TIME'],
    ['2001年1月16日 09:00\n正文', 'INVALID_SENDER'],
    ['·甲\n2001年1月16日 09:00\n', 'MISSING_CONTENT'],
    ['·甲\n2001年1月16日 09:00\n \n\t', 'MISSING_CONTENT'],
    ['·甲\r2001年1月16日 09:00\r正文', 'INVALID_TEXT'],
    ['·甲\n2001年1月16日 09:00\n正文\u0000', 'INVALID_TEXT']
  ])('格式冲突 %j 明确报错，不返回部分结果', (text, code) => {
    const error = errorFor(text)
    expect(error.code).toBe(code)
    expect(error.lineNumber).toBeGreaterThan(0)
    expect(error.message).toContain('第 ')
  })

  it.each(['2026年2月29日 09:00', '2026年4月31日 09:00', '2026年0月1日 09:00',
    '2026年13月1日 09:00', '2026年9月0日 09:00', '2001年1月16日 24:00', '2001年1月16日 09:60'])('非法日期 %s 不由系统自动修正', (time) => {
    expect(errorFor(block('·甲', time, '正文')).code).toBe('INVALID_CALENDAR_TIME')
  })

  it('合法闰日正常解析', () => {
    expect(parse(block('·甲', '2028年2月29日 09:00', '正文')).messages[0].timestamp).toBe('2028-02-29T09:00:00+08:00')
  })

  it('后续带标记消息缺少时间时整份停止，不继承上一条时间', () => {
    const text = `${block('·甲', '2001年1月16日 09:00', '第一条')}\n\n·乙\n缺失时间的第二条`
    expect(errorFor(text, 2)).toMatchObject({ code: 'MISSING_OR_INVALID_TIME', lineNumber: 6 })
  })

  it('后续消息缺少分隔时停止，不将其并入正文', () => {
    const text = `${block('·甲', '2001年1月16日 09:00', '第一条')}\n${block('·乙', '2001年1月16日 09:01', '第二条')}`
    expect(errorFor(text, 2).code).toBe('MISSING_SEPARATOR')
  })

  it('后续日期格式损坏时停止，不将时间行当正文', () => {
    const text = `${block('·甲', '2001年1月16日 09:00', '第一条')}\n\n乙\n2001-01-16 09:01\n第二条`
    expect(errorFor(text, 2).code).toBe('MISSING_OR_INVALID_TIME')
  })

  it('缺失无标记消息头导致漏切时由来源数量校验停止', () => {
    const text = `${block('·甲', '2001年1月16日 09:00', '第一条')}\n\n乙\n第二条没有时间`
    expect(errorFor(text, 2).code).toBe('MESSAGE_COUNT_MISMATCH')
  })

  it('正文模拟完整消息头导致多切时停止，不猜合并方式', () => {
    const body = '引用的聊天如下：\n\n乙\n2001年1月16日 09:01\n这其实是引用正文'
    expect(errorFor(block('·甲', '2001年1月16日 09:00', body)).code).toBe('MESSAGE_COUNT_MISMATCH')
  })

  it.each([0, -1, 1.5, 501, Number.NaN])('来源计数 %s 不合法时停止', (count) => {
    expect(errorFor(fixture('card-a.txt'), count).code).toBe('MESSAGE_COUNT_REQUIRED')
  })

  it('缺少当前卡片消息数时不能默默猜测边界', () => {
    expect(() => parseWorkBuddyChatHistoryText(fixture('card-a.txt'), undefined!)).toThrow('当前卡片明确声明的消息数')
  })

  it('消息数不符不补造或截断消息', () => {
    expect(errorFor(fixture('card-a.txt'), 2).code).toBe('MESSAGE_COUNT_MISMATCH')
    expect(errorFor(fixture('card-a.txt'), 4).code).toBe('MESSAGE_COUNT_MISMATCH')
  })
})

describe('WorkBuddy 聊天解析与既有 Batch 隔离集成', () => {
  it('多段正文及占位文本进入临时 importer，同正文同时间仍按位置分别保留', () => {
    const db = new DatabaseSync(':memory:'); databases.push(db); initializeDatabase(db)
    const longBody = '物业通知：\n  请检查门禁。\n\n第二段：\n请保持通道畅通。'
    const bodies = [longBody, '[动画表情]', '[文件] 网盘流量执行白皮书-7.pdf', '相同正文', '相同正文']
    const text = bodies.map((body) => block('·甲', '2001年1月16日 09:00', body)).join('\n\n')
    const input = { source_batch_id: '解析器隔离集成', messages: parse(text, bodies.length).messages }
    const result = ingestWorkBuddyMessages(db, input)
    expect(result).toMatchObject({ importedCount: 5, duplicateCount: 0, invalidCount: 0 })
    const rows = db.prepare('SELECT content, source_position, stable_identity, fingerprint FROM messages ORDER BY source_position').all()
    expect(rows.map((row) => row.content)).toEqual(bodies)
    expect(rows[3].stable_identity).not.toBe(rows[4].stable_identity)
    expect(rows[3].fingerprint).not.toBe(rows[4].fingerprint)
    expect(ingestWorkBuddyMessages(db, input)).toMatchObject({ importedCount: 0, duplicateCount: 5 })
  })

  it.skipIf(process.platform !== 'win32')('独立卡片文件经解析及既有证据门禁后分别写入 3+4，身份与任务不串批', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'privateradar-chat-parser-'))
    directories.push(directory)
    const databasePath = join(directory, '测试.db')
    const db = new DatabaseSync(databasePath); databases.push(db); initializeDatabase(db)
    const session = createBatchImportSession(db, 'workbuddy')
    const expectedBodies: string[][] = []
    for (const [ordinal, name, count] of [[0, 'a', 3], [1, 'b', 4]] as const) {
      const cardDirectory = join(directory, `当前卡片-${name}`)
      mkdirSync(cardDirectory)
      const textPath = join(cardDirectory, '聊天记录.txt')
      writeFileSync(textPath, fixture(`card-${name}.txt`))
      const parsed = parse(readFileSync(textPath, 'utf8'), count)
      expectedBodies.push(parsed.messages.map((message) => message.content))
      const item = createBatchImportItem(db, session.id, ordinal, `测试卡片-${name}`)
      // 当前证据服务仅支持 ZIP，使用合成测试文件满足门禁；不宣称它是源目录的原始 ZIP。
      const syntheticZip = join(directory, `合成门禁-${name}.zip`)
      const bytes = Buffer.alloc(22); bytes.write('PK\u0005\u0006', 0, 'binary'); writeFileSync(syntheticZip, bytes)
      await saveOriginalZip(db, databasePath, item.id, syntheticZip)
      await saveStructuredSnapshot(db, databasePath, item.id, { messages: parsed.messages })
    }
    const result = await executeBatchImportSession(db, databasePath, session.id)
    expect(result).toMatchObject({ status: 'success', imported_total: 7, duplicate_total: 0, updated_total: 0, invalid_total: 0 })
    expect(result.items.map((item) => item.imported)).toEqual([3, 4])
    const items = listBatchImportItems(db, session.id)
    expect(items[0].source_batch_id).not.toBe(items[1].source_batch_id)
    expect(items[0].effective_job_id).not.toBe(items[1].effective_job_id)
    for (const [index, item] of items.entries()) {
      const rows = db.prepare('SELECT content, sender_name, source_position, timestamp_source FROM messages WHERE source_batch_id = ? ORDER BY source_position').all(item.source_batch_id!)
      expect(rows.map((row) => row.content)).toEqual(expectedBodies[index])
      expect(rows.map((row) => row.source_position)).toEqual(Array.from({ length: expectedBodies[index].length }, (_, position) => position))
      expect(rows.every((row) => String(row.sender_name).startsWith('·'))).toBe(true)
      expect(rows.every((row) => row.timestamp_source === 'source_native')).toBe(true)
    }
    for (const table of ['messages', 'messages_fts'] as const) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 7 })
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM import_jobs').get()).toEqual({ count: 2 })
  })
})
