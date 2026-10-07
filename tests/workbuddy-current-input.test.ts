import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gateWorkBuddyBatchCurrentInput, normalizeWorkBuddyCurrentInput, WorkBuddyCurrentInputError,
  type WorkBuddyCurrentContextBlock } from '../src/main/import/workbuddy-current-input'
import { parseWorkBuddyChatHistoryText } from '../src/main/import/workbuddy-chat-history'
import { workBuddyBatchIngestSchema } from '../src/main/integrations/workbuddy/validation'

const transcript = readFileSync(new URL('./fixtures/workbuddy-chat-history/current-inline-seven.txt', import.meta.url), 'utf8')
const lf = transcript.replace(/\r\n/g, '\n')
const pathA = 'C:\\隔离契约测试\\wechat-chat-history-A'
const pathB = 'C:\\隔离契约测试\\wechat-chat-history-B'

function card(changes: Partial<WorkBuddyCurrentContextBlock> = {}): WorkBuddyCurrentContextBlock {
  return { extracted_dir_path: pathA, file: '虚构聊天记录_20010117_120000.zip', message_count: 7,
    first_sender: '·虚构用户7-###', first_message_at: '2001年1月15日 18:30',
    transcript, ...changes }
}

function errorFor(action: () => unknown): WorkBuddyCurrentInputError {
  try { action() } catch (error) {
    expect(error).toBeInstanceOf(WorkBuddyCurrentInputError)
    return error as WorkBuddyCurrentInputError
  }
  throw new Error('预期当前输入停止，但实际返回了附件')
}

describe('当前输入附件实例归一化', () => {
  it('一个原始上下文保留一个七条消息的逻辑附件，不修改输入', () => {
    const block = Object.freeze(card())
    const input = Object.freeze([block])
    const before = JSON.stringify(input)
    const result = normalizeWorkBuddyCurrentInput(input)
    expect(result.raw_context_count).toBe(1)
    expect(result.logical_attachments).toHaveLength(1)
    expect(result.logical_attachments[0]).toMatchObject({ extracted_dir_path: pathA, transcript,
      context_indexes: [0], message_count: 7 })
    expect(result.logical_attachments[0].messages.map((message) => message.source_position)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(JSON.stringify(input)).toBe(before)
  })

  it('同一卡片七条虚构 transcript 的两个相同副本只保留一个逻辑附件', () => {
    const result = normalizeWorkBuddyCurrentInput([card(), card()])
    expect(result.raw_context_count).toBe(2)
    expect(result.logical_attachments).toHaveLength(1)
    expect(result.logical_attachments[0].context_indexes).toEqual([0, 1])
    expect(result.logical_attachments[0].messages).toHaveLength(7)
  })

  it.each([
    ['开头 BOM', `\uFEFF${transcript}`],
    ['LF 换行', lf],
    ['前导包裹换行', `\r\n\r\n${transcript}`],
    ['末尾单个行终止符', `${transcript}\r\n`],
    ['组合外层差异', `\uFEFF\r\n${lf}\n`]
  ])('%s 不改变消息语义，允许折叠重复序列化', (_name, variant) => {
    const result = normalizeWorkBuddyCurrentInput([card(), card({ transcript: variant })])
    expect(result.logical_attachments).toHaveLength(1)
    expect(result.logical_attachments[0].transcript).toBe(transcript)
    expect(result.logical_attachments[0].messages).toEqual(
      parseWorkBuddyChatHistoryText(transcript, { expectedMessageCount: 7 }).messages)
  })

  it('外层带 BOM 和换行的单份上下文保留原始来源文本', () => {
    const original = `\uFEFF\n${lf}\n`
    const attachment = normalizeWorkBuddyCurrentInput([card({ transcript: original })]).logical_attachments[0]
    expect(attachment.transcript).toBe(original)
    expect(attachment.messages).toHaveLength(7)
    expect(attachment.messages[4].content).toMatch(/虚构服务中心\n2001年1月17日$/)
  })

  it('文档末尾纯分隔空行允许折叠，但不改首份解析结果', () => {
    const result = normalizeWorkBuddyCurrentInput([card(), card({ transcript: `${lf}\n\n` })])
    expect(result.logical_attachments).toHaveLength(1)
    expect(result.logical_attachments[0].transcript).toBe(transcript)
    expect(result.logical_attachments[0].messages).toEqual(
      parseWorkBuddyChatHistoryText(transcript, { expectedMessageCount: 7 }).messages)
  })

  it('省略截断标记与明确 false 都表示未截断', () => {
    expect(normalizeWorkBuddyCurrentInput([card(), card({ truncated: false })]).logical_attachments).toHaveLength(1)
  })

  it('不同路径即使文件名、消息数和正文完全相同仍保留两个实例', () => {
    const result = normalizeWorkBuddyCurrentInput([card(), card({ extracted_dir_path: pathB })])
    expect(result.logical_attachments.map((attachment) => attachment.extracted_dir_path)).toEqual([pathA, pathB])
    expect(result.logical_attachments.map((attachment) => attachment.context_indexes)).toEqual([[0], [1]])
    expect(result.logical_attachments[0].messages).toEqual(result.logical_attachments[1].messages)
  })

  it('不同正文位于不同目录时分别解析，不当作同路径冲突', () => {
    const result = normalizeWorkBuddyCurrentInput([card(), card({ extracted_dir_path: pathB,
      transcript: transcript.replace('发布虚构样例', '更改虚构样例') })])
    expect(result.logical_attachments).toHaveLength(2)
    expect(result.logical_attachments[0].messages[1].content).not.toBe(result.logical_attachments[1].messages[1].content)
  })

  it('每次调用独立归组，不跨当前输入缓存附件身份', () => {
    const first = normalizeWorkBuddyCurrentInput([card()])
    const second = normalizeWorkBuddyCurrentInput([card()])
    expect(first).toEqual(second)
    expect(first.logical_attachments[0]).not.toBe(second.logical_attachments[0])
  })
})

describe('同路径冲突整体停止', () => {
  it.each([
    ['显示文件名', { file: '其他卡片.zip' }],
    ['消息数', { message_count: 8 }],
    ['首位发送人', { first_sender: '·其他人' }],
    ['首条时间', { first_message_at: '2001年1月15日 18:31' }],
    ['截断状态', { truncated: true }]
  ] satisfies Array<[string, Partial<WorkBuddyCurrentContextBlock>]>)('%s 冲突不因副本顺序变化而被接受', (_name, changes) => {
    for (const pair of [[card(), card(changes)], [card(changes), card()]]) {
      const error = errorFor(() => normalizeWorkBuddyCurrentInput(pair))
      expect(error.code).toBe('DUPLICATE_CONTEXT_CONFLICT')
      expect(error.contextIndex).toBe(1)
    }
  })

  it.each([
    ['正文', transcript.replace('发布虚构样例', '更改虚构样例')],
    ['后续发送人', transcript.replace('·虚构用户8', '·另一位发送人')],
    ['后续时间', transcript.replace('2001年1月16日 12:54', '2001年1月16日 12:55')],
    ['正文缩进', transcript.replace('　　为了', '  为了')],
    ['同行空格', transcript.replace('00000000006                      值班时间', '00000000006 值班时间')],
    ['emoji', transcript.replace('🏡', '🏠')],
    ['段落空行', transcript.replace('请大家注意以下几点', '\r\n请大家注意以下几点')]
  ])('%s 实质差异拒绝合并', (_name, variant) => {
    expect(errorFor(() => normalizeWorkBuddyCurrentInput([card(), card({ transcript: variant })])).code)
      .toBe('DUPLICATE_CONTEXT_CONFLICT')
  })

  it('后续消息交换顺序时拒绝合并，不按时间排序修复', () => {
    const messages = parseWorkBuddyChatHistoryText(transcript, { expectedMessageCount: 7 }).messages
    const reordered = [0, 2, 1, 3, 4, 5, 6].map((index) => {
      const message = messages[index]
      return `${message.sender_name}\n${message.source_time_text}\n${message.content}`
    }).join('\n\n')
    expect(errorFor(() => normalizeWorkBuddyCurrentInput([card(), card({ transcript: reordered })])).code)
      .toBe('DUPLICATE_CONTEXT_CONFLICT')
  })

  it('同路径一份不能解析时停止，不能丢弃坏副本后继续', () => {
    expect(errorFor(() => normalizeWorkBuddyCurrentInput([card(), card({ transcript: '正文缺失消息头' })])).code)
      .toBe('DUPLICATE_CONTEXT_CONFLICT')
  })

  it('之前已验证的另一目录不会使冲突输入返回部分成功附件', () => {
    expect(errorFor(() => gateWorkBuddyBatchCurrentInput([
      card({ extracted_dir_path: pathB }), card(), card({ message_count: 8 })
    ])).code).toBe('DUPLICATE_CONTEXT_CONFLICT')
  })

  it('相同的截断副本也不能作为完整消息来源', () => {
    expect(errorFor(() => normalizeWorkBuddyCurrentInput([card({ truncated: true }), card({ truncated: true })])).code)
      .toBe('TRUNCATED_CURRENT_CONTEXT')
  })

  it('单份卡片首条信息与真实正文不一致时停止', () => {
    expect(errorFor(() => normalizeWorkBuddyCurrentInput([card({ first_sender: '·其他人' })])).code)
      .toBe('INVALID_CURRENT_CONTEXT')
  })

  it('不能解析的单份正文返回明确错误，不补造消息', () => {
    expect(errorFor(() => normalizeWorkBuddyCurrentInput([card({ transcript: '无可靠时间' })])).code)
      .toBe('INVALID_CURRENT_TRANSCRIPT')
  })

  it.each([
    { extracted_dir_path: '' }, { file: '' }, { message_count: 0 }, { message_count: 1.5 },
    { transcript: null }, { first_sender: null }, { first_message_at: null }, { truncated: 'false' }
  ])('非法当前卡片字段 %j 不猜测补全', (changes) => {
    expect(errorFor(() => normalizeWorkBuddyCurrentInput([card(changes as Partial<WorkBuddyCurrentContextBlock>)])).code)
      .toBe('INVALID_CURRENT_CONTEXT')
  })
})

describe('先归一化再限定一个或两个逻辑附件', () => {
  it('甲乙卡片各重复两次，原始四份上下文允许形成两个逻辑附件', () => {
    const result = gateWorkBuddyBatchCurrentInput([
      card(), card({ extracted_dir_path: pathB }), card(), card({ extracted_dir_path: pathB })
    ])
    expect(result.raw_context_count).toBe(4)
    expect(result.logical_attachments.map((attachment) => attachment.context_indexes)).toEqual([[0, 2], [1, 3]])
    expect(result.logical_attachments).toHaveLength(2)
  })

  it('只有甲卡片重复两次，按一个真实逻辑附件通过门禁', () => {
    const result = gateWorkBuddyBatchCurrentInput([card(), card()])
    expect(result.raw_context_count).toBe(2)
    expect(result.logical_attachments).toHaveLength(1)
    expect(result.logical_attachments[0].context_indexes).toEqual([0, 1])
  })

  it('一份真实原始上下文也可独立通过门禁', () => {
    const result = gateWorkBuddyBatchCurrentInput([card()])
    expect(result.logical_attachments).toHaveLength(1)
    expect(result.logical_attachments[0].context_indexes).toEqual([0])
  })

  it.each([0, 3])('%s 个独立附件仍在当前产品数量范围之外', (count) => {
    const input = Array.from({ length: count }, (_, index) => card({ extracted_dir_path: `${pathA}-${index}` }))
    expect(errorFor(() => gateWorkBuddyBatchCurrentInput(input)).code).toBe('LOGICAL_ATTACHMENT_COUNT_MISMATCH')
  })

  it('当前上下文允许单卡，内部旧版压缩包接口继续只接受双卡', () => {
    function schemaAccepts(blocks: WorkBuddyCurrentContextBlock[]) {
      const result = normalizeWorkBuddyCurrentInput(blocks)
      return workBuddyBatchIngestSchema.safeParse({ attachments: result.logical_attachments.map((attachment, index) => ({
        // 只验证已有接口的数量契约，合成字符串不代表取得了当前卡片 ZIP。
        source_zip_path: `C:\\隔离契约测试\\合成门禁-${index}.zip`, messages: attachment.messages
      })) }).success
    }
    expect(gateWorkBuddyBatchCurrentInput([card(), card()]).logical_attachments).toHaveLength(1)
    expect(schemaAccepts([card(), card()])).toBe(false)
    expect(schemaAccepts([card(), card(), card({ extracted_dir_path: pathB }), card({ extracted_dir_path: pathB })])).toBe(true)
  })
})
