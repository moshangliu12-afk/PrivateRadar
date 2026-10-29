import { afterEach, describe, expect, it } from 'vitest'
import { buildCanonicalExportSnapshot } from '../src/main/export/chat-selection'
import { renderChatTxt } from '../src/main/export/chat-txt'
import { createExportFiles } from '../src/main/export/chat-formats'
import { sha256 } from '../src/main/export/chat-markdown'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'

afterEach(cleanupExportFixtures)
describe('TXT 纯文本导出', () => {
  it.each(['中文直接阅读', '👩🏽‍💻 中文 emoji', '首行\r\n第二行\n最后一行', 'https://example.invalid/a?q=1&b=2#中文', '', '  \n\t  ', '长消息中文🙂\n'.repeat(8000), '# 用户原文\n**原文符号**\n```原文围栏'].map((body, index) => [index, body] as const))('UTF-8 和正文逐字保留 %i', async (_index, body) => {
    const f = exportFixture(); f.add('消息', body)
    const text = renderChatTxt(await buildCanonicalExportSnapshot(f.databasePath, f.request)).toString('utf8')
    expect(text).toContain(body); expect(text).not.toContain('\uFFFD')
    expect(text).toContain('消息数量：1')
  })
  it.each([['来源群', '用户标签', '用户标签'], ['来源群', null, '来源群'], ['', null, '未知会话']])('顶部名称来源 %s / 用户 %s', async (source, user, display) => {
    const f = exportFixture(); f.add('消息')
    f.db.prepare('UPDATE conversations SET name=?,user_conversation_label=?').run(source, user)
    const before = sourceFingerprint(f.db)
    const text = renderChatTxt(await buildCanonicalExportSnapshot(f.databasePath, f.request)).toString()
    expect(text.startsWith('会话：' + display + '\n')).toBe(true)
    expect(text).not.toContain('userConversationLabel'); expect(sourceFingerprint(f.db)).toEqual(before)
  })
  it('日期分组、发送人和时间明确，未知时间放末尾，不增加 Markdown 控制语法', async () => {
    const f = exportFixture(); f.add('较晚', '后文', '2026-10-02T00:00:00.000Z'); f.add('较早', '前文'); f.add('未知', '未知消息', null)
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, f.request), text = renderChatTxt(snapshot).toString()
    expect(text).toContain(`====================\n${snapshot.messages[0].local_date}\n====================`)
    expect(text).toContain(`${snapshot.messages[0].local_time} · 原发言人`)
    expect(text.indexOf('前文')).toBeLessThan(text.indexOf('后文')); expect(text.indexOf('后文')).toBeLessThan(text.indexOf('未知消息'))
    expect(text).toContain('时间未提供'); expect(text).not.toMatch(/^#{1,6} |^\*\*|^```|\[export.json\]\(/m)
  })
  it('已有附件信息转为可读占位，缺失发送人不猜测，不输出机器附件路径', async () => {
    const f = exportFixture(); f.add('附件', '[原始附件说明]')
    f.db.prepare("UPDATE messages SET sender_name=NULL,message_type='file',attachments_json=?").run(JSON.stringify([{ type: 'image', path: 'C:\\秘密.png' }, { type: 'audio' }, { type: 'file' }]))
    const text = renderChatTxt(await buildCanonicalExportSnapshot(f.databasePath, f.request)).toString()
    for (const label of ['发送人未提供', '[图片，未复制]', '[语音，未复制]', '[文件，未复制]', '[原始附件说明]']) expect(text).toContain(label)
    expect(text).not.toContain('秘密.png')
  })
  it('TXT 与共用 metadata 的格式、文件名、计数和哈希一致', async () => {
    const f = exportFixture(); f.add('消息')
    const files = createExportFiles(await buildCanonicalExportSnapshot(f.databasePath, f.request), '测试版本', 'txt')
    const metadata = JSON.parse(files.manifest.toString())
    expect(metadata).toMatchObject({ export_format: 'txt', export_version: 'txt-v1', output_files: ['聊天.txt', 'export.json'], selection: { message_count: 1 },
      output: { path: '聊天.txt', bytes: files.content.length, sha256: sha256(files.content) } })
    expect(files.filename).toBe('聊天.txt'); expect(metadata.policy.render_policy).toBe('plain-text-v1')
  })
})
