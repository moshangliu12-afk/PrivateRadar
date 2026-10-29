import { afterEach, describe, expect, it } from 'vitest'
import { buildCanonicalExportSnapshot } from '../src/main/export/chat-selection'
import { renderChatJson } from '../src/main/export/chat-json'
import { createExportFiles } from '../src/main/export/chat-formats'
import { sha256 } from '../src/main/export/chat-markdown'
import { cleanupExportFixtures, exportFixture, sourceFingerprint } from './markdown-export-fixture'

afterEach(cleanupExportFixtures)
describe('JSON 结构化导出', () => {
  it.each(['中文内容', '👩🏽‍💻 🦉 emoji', '首行\r\n第二行\n尾行', 'https://example.invalid/path?a=1&b=中文#段落', '长消息🙂中文'.repeat(20000), '', '  \n\t', '# 原文 **不是渲染**\n```json\n{"a":1}', '用户正文 C:\\用户路径\\原文.txt'].map((content, index) => [index, content] as const))('UTF-8、合法 JSON 和原文逐字保留 %i', async (_index, content) => {
    const f = exportFixture(); f.add('消息', content)
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, f.request)
    const bytes = renderChatJson(snapshot, '测试版本'), result = JSON.parse(bytes.toString('utf8'))
    expect(result.exportVersion).toBe('json-v1'); expect(result.appVersion).toBe('测试版本')
    expect(result.exportedAt).toBe(snapshot.selection.captured_at)
    expect(result.messageCount).toBe(1); expect(result.messages[0].content).toBe(content)
    expect(result.messages[0]).toMatchObject({ id: '消息', conversationId: '导出会话', sender: { id: '发言人', name: '原发言人', nameSource: 'source_native' }, timestamp: '2026-10-01T01:00:00.000Z', messageType: 'text', source: { batchId: '来源批次', position: 0 } })
    expect(bytes.toString('utf8')).not.toContain('\uFFFD')
  })
  it.each([['来源群', '用户项目组', '用户项目组'], ['来源群', null, '来源群'], [null, '用户项目组', '用户项目组'], [null, null, '未知会话']])('名称三层语义：来源 %s / 用户 %s', async (source, user, display) => {
    const f = exportFixture(); f.add('消息')
    f.db.prepare('UPDATE conversations SET name=?,user_conversation_label=?').run(source ?? '', user)
    const before = sourceFingerprint(f.db)
    const result = JSON.parse(renderChatJson(await buildCanonicalExportSnapshot(f.databasePath, f.request), '测试版本').toString())
    expect(result.conversation).toEqual({ id: '导出会话', platform: 'wechat', sourceConversationName: source, userConversationLabel: user, displayConversationName: display })
    expect(sourceFingerprint(f.db)).toEqual(before)
  })
  it('稳定顺序、未知和推测事实保守表达，不输出数据库内部结构或机器来源路径', async () => {
    const f = exportFixture(); f.add('较晚', '后文', '2026-10-02T00:00:00.000Z'); f.add('较早', '前文'); f.add('未知', '未知时间正文', null)
    f.db.prepare("UPDATE messages SET sender_name='推测姓名',sender_name_source='inferred',conversation_name='猜测群',conversation_name_source='inferred' WHERE id='未知'").run()
    const snapshot = await buildCanonicalExportSnapshot(f.databasePath, f.request)
    const result = JSON.parse(renderChatJson(snapshot, '测试版本').toString())
    expect(result.messages.map((message: { id: string }) => message.id)).toEqual(['较早', '较晚', '未知'])
    expect(result.messages[2]).toMatchObject({ timestamp: null, storedTimestamp: null, sender: { name: null }, sourceConversationName: null, timestampSource: 'unknown' })
    expect(JSON.stringify(result)).not.toMatch(/不得导出原路径|raw_metadata|fingerprint|sqlite_master|messages_fts|import_job_id|推测姓名|猜测群/)
    expect(renderChatJson(snapshot, '测试版本')).toEqual(renderChatJson(snapshot, '测试版本'))
  })
  it('非文本附件仅保留已有类型和占位，来源身份及 Evidence 登记可追踪但不复制附件', async () => {
    const f = exportFixture(); f.add('图片', '[图片]'); f.evidence('图片')
    f.db.prepare("UPDATE messages SET message_type='image',attachments_json=?").run(JSON.stringify([{ type: 'image', path: 'C:\\私有附件.png' }, { type: 'audio' }]))
    const result = JSON.parse(renderChatJson(await buildCanonicalExportSnapshot(f.databasePath, f.request), '测试版本').toString())
    expect(result.messages[0].attachments).toEqual([{ ordinal: 0, kind: 'image', copied: false, fileState: 'not_checked' }, { ordinal: 1, kind: 'audio', copied: false, fileState: 'not_checked' }])
    expect(result.sources).toHaveLength(1); expect(result.evidence.occurrences).toHaveLength(1)
    expect(result.evidence).toMatchObject({ verification: 'not_performed', isEvidenceBackup: false })
    expect(result.evidence.occurrences[0].sourceConversationName).toBe('来源群')
    expect(JSON.stringify(result)).not.toContain('私有附件')
  })
  it('复用 metadata 和摘要，与实际 JSON 文件名、消息数、格式、字节与哈希一致', async () => {
    const f = exportFixture(); f.add('消息')
    const files = createExportFiles(await buildCanonicalExportSnapshot(f.databasePath, f.request), '测试版本', 'json')
    const data = JSON.parse(files.content.toString()), metadata = JSON.parse(files.manifest.toString())
    expect(metadata).toMatchObject({ export_format: 'json', export_version: 'json-v1', output_files: ['聊天.json', 'export.json'], selection: { message_count: data.messageCount }, conversation: data.conversation,
      output: { path: '聊天.json', bytes: files.content.length, sha256: sha256(files.content) } })
    expect(files.filename).toBe('聊天.json'); expect(metadata.policy.template_version).toBe('json-v1')
  })
})
