import { describe, expect, it } from 'vitest'
import { gateWorkBuddyBatchCurrentInput, normalizeWorkBuddyCurrentInput, WorkBuddyCurrentInputError,
  type WorkBuddyCurrentContextBlock } from '../src/main/import/workbuddy-current-input'
import { parseWorkBuddyChatHistoryText } from '../src/main/import/workbuddy-chat-history'

// 对应真实失败形态：七条消息、第四和第六条为图片；不纳入真实用户聊天。
const bodies = ['第一条文本', '第二条\n保留内部换行', '第三条\n\n保留内部段落',
  '[图片] 隔离图片一.jpg', '图片后的文本', '[图片] 隔离图片二.jpg', '最后一条文本']
const records = bodies.map((body, index) => `·隔离发送人\n2026年10月6日 08:0${index}\n${body}`)
const canonical = records.join('\n\n')
const base: WorkBuddyCurrentContextBlock = { extracted_dir_path: 'C:\\隔离测试\\第二张卡',
  file: '隔离图片卡.zip', message_count: 7, transcript: canonical }
function context(transcript: string): WorkBuddyCurrentContextBlock { return { ...base, transcript } }
function collapse(variant: string) {
  for (const pair of [[context(canonical), context(variant)], [context(variant), context(canonical)]]) {
    const original = JSON.stringify(pair)
    const firstParsed = parseWorkBuddyChatHistoryText(pair[0].transcript, { expectedMessageCount: 7 })
    const result = normalizeWorkBuddyCurrentInput(pair)
    expect(result.logical_attachments).toHaveLength(1)
    expect(result.logical_attachments[0].context_indexes).toEqual([0, 1])
    expect(result.logical_attachments[0].transcript).toBe(pair[0].transcript)
    expect(result.logical_attachments[0].messages).toEqual(firstParsed.messages)
    expect(result.logical_attachments[0].messages.map(m => m.source_position)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(JSON.stringify(pair)).toBe(original)
  }
}
function conflict(variant: string, changes: Partial<WorkBuddyCurrentContextBlock> = {}) {
  for (const pair of [[context(canonical), { ...context(variant), ...changes }],
    [{ ...context(variant), ...changes }, context(canonical)]]) {
    let thrown: unknown
    try { normalizeWorkBuddyCurrentInput(pair) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(WorkBuddyCurrentInputError)
    expect(thrown).toMatchObject({ code: 'DUPLICATE_CONTEXT_CONFLICT' })
  }
}

describe('重复上下文只容忍已确认消息边界的序列化空行', () => {
  it('完全相同副本折叠且保留首份正文', () => collapse(canonical))
  it('普通消息之间多一个空行可以折叠', () => {
    collapse(records.slice(0, 2).join('\n\n\n') + '\n\n' + records.slice(2).join('\n\n'))
  })
  it('两个图片占位记录前后空行数不同可以折叠', () => {
    collapse(records.map((record, index) => record + ([2, 3, 4, 5].includes(index) ? '\n\n' : '')).join('\n\n'))
  })
  it('真实失败形态：所有六个记录边界各增加一个空行可以折叠', () => collapse(records.join('\n\n\n')))
  it('CRLF 和 LF 的现有传输契约保持不变', () => collapse(canonical.replace(/\n/g, '\r\n')))
  it.each(['\n\n', '\n\n \t\n'])('文档末尾分隔空白 %j 可以折叠', suffix => collapse(canonical + suffix))
  it('仅比较副本，单份 parser 的正文末尾空行不被清洗', () => {
    const transcript = records.join('\n\n\n') + '\n\n'
    const result = normalizeWorkBuddyCurrentInput([context(transcript)])
    expect(result.logical_attachments[0].messages).toEqual(
      parseWorkBuddyChatHistoryText(transcript, { expectedMessageCount: 7 }).messages)
    expect(result.logical_attachments[0].messages[0].content).toBe(bodies[0] + '\n')
    expect(result.logical_attachments[0].messages.at(-1)?.content).toBe(bodies.at(-1) + '\n')
  })
  it.each([
    ['普通正文字符', canonical.replace('第一条文本', '第一条文本多一个字符')],
    ['正文内部换行', canonical.replace('第二条\n保留内部换行', '第二条\n\n保留内部换行')],
    ['正文内部段落', canonical.replace('第三条\n\n保留内部段落', '第三条\n保留内部段落')],
    ['正文行内空格', canonical.replace('第一条文本', '第一条 文本')],
    ['正文行末空格', canonical.replace('第一条文本', '第一条文本 ')],
    ['正文前导空行', canonical.replace('08:01\n第二条', '08:01\n\n第二条')],
    ['发送人', canonical.replace('08:00\n第一条文本\n\n·隔离发送人', '08:00\n第一条文本\n\n·另一发送人')],
    ['时间', canonical.replace('2026年10月6日 08:01', '2026年10月6日 08:11')],
    ['图片占位文本', canonical.replace('[图片] 隔离图片一.jpg', '[视频] 隔离图片一.jpg')],
    ['图片文件名', canonical.replace('[图片] 隔离图片一.jpg', '[图片] 另一张图片.jpg')],
    ['图片占位丢失', canonical.replace('[图片] 隔离图片一.jpg', '图片已省略')]
  ])('%s 不同继续拒绝副本', (_name, variant) => conflict(variant))
  it('消息顺序改变不能排序后合并', () => conflict([records[0], records[2], records[1], ...records.slice(3)].join('\n\n')))
  it('少一条消息，即使副本自己声明了六条也继续冲突', () => conflict(records.slice(0, 6).join('\n\n'), { message_count: 6 }))
  it('新增消息不能被吞掉', () => conflict(canonical + '\n\n·隔离发送人\n2026年10月6日 08:07\n新增一条', { message_count: 8 }))
  it('图片位置改变，即使占位数量相同也继续冲突', () => {
    const swapped = [...bodies]; [swapped[2], swapped[3]] = [swapped[3], swapped[2]]
    conflict(swapped.map((body, i) => `·隔离发送人\n2026年10月6日 08:0${i}\n${body}`).join('\n\n'))
  })
  it('缺少必要记录分隔仍不能折叠', () => conflict(records.join('\n')))
  it('相同 parser 输出不能吞掉文本非换行差异', () => conflict(canonical + ' '))
  it('四块原始上下文归为两个逻辑附件，保留图片占位位置', () => {
    const first = { ...base, extracted_dir_path: 'C:\\隔离测试\\第一张卡', file: '隔离文本卡.zip' }
    const result = gateWorkBuddyBatchCurrentInput([first, base, { ...first }, context(records.join('\n\n\n'))])
    expect(result.raw_context_count).toBe(4)
    expect(result.logical_attachments.map(a => a.context_indexes)).toEqual([[0, 2], [1, 3]])
    expect(result.logical_attachments.map(a => a.messages.length)).toEqual([7, 7])
    expect(result.logical_attachments[1].messages.flatMap((m, i) => m.content.includes('[图片]') ? [i] : [])).toEqual([3, 5])
  })
})
