// 密钥字面量为人工虚构哨兵，仅验证敏感字段不会泄漏。
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listCommitmentCandidates, confirmCommitmentCandidate, ignoreCommitmentCandidate,
  getCommitmentCandidateContext, registerCommitmentCandidateIpc, safeCommitmentAction
} from '../src/main/commitment/desktop'
import { openCommitmentCandidateEvidence } from '../src/main/commitment/evidence-navigation'
import * as matcher from '../src/main/commitment/matcher'
import * as processor from '../src/main/commitment/processor'
import { processKeywordRadarRun } from '../src/main/keyword-radar/processor'
import { ingestWorkBuddyMessages } from '../src/main/integrations/workbuddy/ingest'
import { migrateBatchImportSchema } from '../src/main/batch-import/schema'
import { prepareSchemaV7Fixture } from './schema-v7-fixture'
import { commitmentMessages } from './commitment-processing-fixture'
import { cleanupRadarFixtures, ingestRadarItem, radarCount, radarFixture } from './keyword-radar-fixture'
import { reviewFixture, reviewDatabaseFingerprint, saveReviewEvidence, type ReviewFixture } from './commitment-review-fixture'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanupRadarFixtures() })

function ipc(f: Pick<ReviewFixture, 'db'>) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>()
  const open = vi.fn(async (_id: unknown) => ({ batchItemId: '隔离附件', opened: true as const }))
  registerCommitmentCandidateIpc({ handle: (name, callback) => {
    handlers.set(name, (...args) => callback(null, ...args) as Promise<any>)
  } }, f.db, open)
  return { handlers, open, call: (name: string, ...args: unknown[]) => handlers.get('commitment-candidates:' + name)!(...args) }
}

function candidateAt(f: ReviewFixture, position = 0, itemIndex = 0) {
  const row = listCommitmentCandidates(f.db).find(candidate => candidate.batchItemId === f.items[itemIndex].id && candidate.sourcePosition === position)
  if (!row) throw new Error('审核测试候选项不存在')
  return row
}

function secondItem(f: ReviewFixture, position = 0) {
  const messages = f.messages.map(message => ({ ...message, sender_name: '来源乙', conversation_name: '乙群',
    timestamp: '2026-10-06T02:20:00.000Z', timestamp_source: 'user_supplied' as const }))
  const result = ingestRadarItem(f, 1, messages)
  expect(result.importedCount).toBe(0)
  processor.processCommitmentExtractorRun(f.db, f.items[1].id)
  processKeywordRadarRun(f.db, f.items[1].id)
  return candidateAt(f, position, 1)
}

describe('承诺候选项列表及来源事实', () => {
  it('读取三种审核状态和原文，不把确认转换为任务或完成', () => {
    const f = reviewFixture(), rows = listCommitmentCandidates(f.db)
    confirmCommitmentCandidate(f.db, candidateAt(f, 1).id)
    ignoreCommitmentCandidate(f.db, candidateAt(f, 2).id)
    const listed = listCommitmentCandidates(f.db).sort((a, b) => a.sourcePosition - b.sourcePosition)
    expect(listed.map(candidate => candidate.status)).toEqual(['pending', 'confirmed', 'ignored'])
    expect(listed.map(candidate => candidate.body)).toEqual(f.messages.map(message => message.content))
    expect(rows.every(candidate => candidate.status === 'pending' && candidate.reviewedAt === null)).toBe(true)
    expect(listed.every(candidate => !('deadline' in candidate) && !('completed' in candidate))).toBe(true)
  })

  it('共享规范消息的不同来源只展示当前来源发送人、会话和时间', () => {
    const f = reviewFixture(), candidate = secondItem(f)
    expect(candidate).toMatchObject({ body: f.messages[0].content, senderName: '来源乙', conversationName: '乙群',
      chatTimestamp: '2026-10-06T02:20:00.000Z', batchItemId: f.items[1].id,
      source: { batchItemId: f.items[1].id } })
    expect(radarCount(f.db, 'messages')).toBe(3)
    const canonical = f.db.prepare('SELECT sender_name,conversation_name,timestamp FROM messages WHERE id=?').get(candidate.messageId)!
    expect(canonical).toMatchObject({ sender_name: '隔离发送人', conversation_name: '隔离群' })
    expect(canonical.timestamp).not.toBe(candidate.chatTimestamp)
    const center = getCommitmentCandidateContext(f.db, candidate.id).entries.find(entry => entry.isCurrent)!
    expect(center).toMatchObject({ senderName: '来源乙', conversationName: '乙群', chatTimestamp: candidate.chatTimestamp })
  })

  it('缺失来源元数据保持未知，不借用规范消息或审核时间', () => {
    const f = reviewFixture(undefined, () => ({ source_sender_name: null, source_conversation_name: null,
      source_timestamp: null, source_timestamp_source: 'unknown' }))
    const candidate = candidateAt(f)
    confirmCommitmentCandidate(f.db, candidate.id)
    expect(candidateAt(f)).toMatchObject({ senderName: null, conversationName: null, chatTimestamp: null, timestampSource: 'unknown' })
    expect(candidateAt(f).reviewedAt).not.toBeNull()
    const canonical = f.db.prepare('SELECT sender_name,conversation_name,timestamp FROM messages WHERE id=?').get(candidate.messageId)!
    expect(canonical.sender_name).not.toBeNull(); expect(canonical.timestamp).not.toBeNull()
    expect(getCommitmentCandidateContext(f.db, candidate.id).entries).toHaveLength(1)
  })

  it('生成原因、规则和版本始终来自候选项冻结字段，列表不重判', () => {
    const f = reviewFixture(), candidate = candidateAt(f), row = f.db.prepare('SELECT * FROM commitment_candidates WHERE id=?').get(candidate.id)!
    const spy = vi.spyOn(matcher, 'matchCommitmentBody').mockImplementation(() => { throw new Error('读取不得重新匹配') })
    expect(candidate).toMatchObject({ reasonCode: row.reason_code, ruleId: row.rule_id, ruleVersion: row.rule_version })
    expect(listCommitmentCandidates(f.db)).toHaveLength(3)
    getCommitmentCandidateContext(f.db, candidate.id)
    expect(spy).not.toHaveBeenCalled()
  })

  it.each([
    ['source_native', '2026-10-06T01:00:00.000Z'], ['user_supplied', '2026-10-06T01:00:00.000Z'],
    ['inferred', null], ['unknown', null]
  ])('聊天时间只接受可靠来源 %s', (source, expected) => {
    const f = reviewFixture(undefined, () => ({ source_timestamp: '2026-10-06T09:00:00+08:00', source_timestamp_source: source }))
    const candidate = candidateAt(f)
    expect(candidate.chatTimestamp).toBe(expected)
    expect(getCommitmentCandidateContext(f.db, candidate.id).entries.find(entry => entry.isCurrent)!.chatTimestamp).toBe(expected)
    if (expected === null) expect(candidate.chatTimestamp).not.toBe(f.db.prepare('SELECT created_at FROM commitment_candidates WHERE id=?').get(candidate.id)!.created_at)
  })

  it.each(['非法时间', '2026-02-30T02:20:00Z'])('可靠来源中的非法日期也保持未知 %s', timestamp => {
    const f = reviewFixture(undefined, () => ({ source_timestamp: timestamp, source_timestamp_source: 'source_native' }))
    expect(candidateAt(f).chatTimestamp).toBeNull()
    expect(getCommitmentCandidateContext(f.db, candidateAt(f).id).entries.every(entry => entry.chatTimestamp === null)).toBe(true)
  })
})

describe('候选项审核状态及最小通信边界', () => {
  it('同一候选项允许待审核到确认、确认到忽略、忽略到确认，时间只随真实变化更新', () => {
    const f = reviewFixture(), candidate = candidateAt(f), original = f.db.prepare('SELECT * FROM commitment_candidates WHERE id=?').get(candidate.id)!
    const before = reviewDatabaseFingerprint(f, true)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T01:00:00Z'))
    expect(confirmCommitmentCandidate(f.db, candidate.id)).toEqual({ id: candidate.id, status: 'confirmed', reviewedAt: '2026-10-08T01:00:00.000Z' })
    vi.setSystemTime(new Date('2026-10-08T02:00:00Z'))
    expect(ignoreCommitmentCandidate(f.db, candidate.id)).toEqual({ id: candidate.id, status: 'ignored', reviewedAt: '2026-10-08T02:00:00.000Z' })
    vi.setSystemTime(new Date('2026-10-08T03:00:00Z'))
    expect(confirmCommitmentCandidate(f.db, candidate.id)).toEqual({ id: candidate.id, status: 'confirmed', reviewedAt: '2026-10-08T03:00:00.000Z' })
    expect(f.db.prepare('SELECT * FROM commitment_candidates WHERE id=?').get(candidate.id)).toEqual({ ...original, status: 'confirmed', reviewed_at: '2026-10-08T03:00:00.000Z' })
    expect(reviewDatabaseFingerprint(f, true)).toBe(before)
  })

  it('待审核可以直接忽略', () => {
    const f = reviewFixture(), candidate = candidateAt(f)
    expect(ignoreCommitmentCandidate(f.db, candidate.id)).toMatchObject({ id: candidate.id, status: 'ignored', reviewedAt: expect.any(String) })
  })

  it.each(['confirmed', 'ignored'] as const)('重复 %s 操作不刷新审核时间或候选项其他字段', status => {
    const f = reviewFixture(), candidate = candidateAt(f), action = status === 'confirmed' ? confirmCommitmentCandidate : ignoreCommitmentCandidate
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T01:00:00Z'))
    const first = action(f.db, candidate.id), before = reviewDatabaseFingerprint(f)
    vi.setSystemTime(new Date('2026-10-09T01:00:00Z'))
    expect(action(f.db, candidate.id)).toEqual(first)
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  })

  it.each(['', "' OR 1=1 --", 'C:\\秘密文件.zip', null, undefined, 123])('四个编号通道拒绝无效身份 %s', async id => {
    const f = reviewFixture(), api = ipc(f), before = reviewDatabaseFingerprint(f)
    for (const name of ['confirm', 'ignore', 'context', 'open-evidence'])
      expect(await api.call(name, id)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(api.open).not.toHaveBeenCalled()
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  })

  it('只登记五个固定通道，已有候选项动作使用安全结果包装', async () => {
    const f = reviewFixture(), api = ipc(f), id = candidateAt(f).id
    expect([...api.handlers.keys()]).toEqual(['commitment-candidates:list', 'commitment-candidates:confirm',
      'commitment-candidates:ignore', 'commitment-candidates:context', 'commitment-candidates:open-evidence'])
    expect(await api.call('list')).toMatchObject({ ok: true, value: expect.any(Array) })
    expect(await api.call('confirm', id)).toMatchObject({ ok: true, value: { id, status: 'confirmed' } })
    expect(await api.call('ignore', id)).toMatchObject({ ok: true, value: { id, status: 'ignored' } })
    expect(await api.call('context', id)).toMatchObject({ ok: true, value: { candidateId: id, batchItemId: f.items[0].id } })
    expect(await api.call('open-evidence', id)).toMatchObject({ ok: true, value: { opened: true } })
    expect(api.open).toHaveBeenCalledExactlyOnceWith(id)
  })

  it('缺失候选项返回受控错误，不能新建候选项或运行记录', async () => {
    const f = reviewFixture(), before = reviewDatabaseFingerprint(f), id = randomUUID(), api = ipc(f)
    for (const name of ['confirm', 'ignore', 'context'])
      expect(await api.call(name, id)).toMatchObject({ ok: false, error: { code: 'CANDIDATE_UNAVAILABLE' } })
    expect(await safeCommitmentAction(() => openCommitmentCandidateEvidence(f.db, f.path, id, async () => '')))
      .toMatchObject({ ok: false, error: { code: 'CANDIDATE_UNAVAILABLE' } })
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  })

  it('未知异常和审核写入失败均使用固定安全错误，不泄露正文或路径', async () => {
    const secret = 'SQLite 私聊原文 C:\\私有路径 堆栈'
    const result = await safeCommitmentAction(() => { throw new Error(secret) })
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED', message: expect.any(String) } })
    expect(JSON.stringify(result)).not.toContain(secret)
    const f = reviewFixture(), before = reviewDatabaseFingerprint(f)
    f.db.exec("CREATE TEMP TRIGGER reject_candidate_review BEFORE UPDATE ON commitment_candidates BEGIN SELECT RAISE(ABORT,'隔离审核失败'); END")
    expect(await ipc(f).call('confirm', candidateAt(f).id)).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  })
})

describe('候选项上下文和历史只读边界', () => {
  it('以真实来源位置五为中心，读取同附件前后两条并保持事实', () => {
    const bodies = Array.from({ length: 9 }, (_value, index) => index === 5 ? '我会处理这个问题' : `普通原话${index}`)
    const f = reviewFixture(bodies), candidate = candidateAt(f, 5), before = reviewDatabaseFingerprint(f)
    const context = getCommitmentCandidateContext(f.db, candidate.id)
    expect(context).toMatchObject({ candidateId: candidate.id, batchItemId: f.items[0].id })
    expect(context.entries.map(entry => entry.sourcePosition)).toEqual([3, 4, 5, 6, 7])
    expect(context.entries.filter(entry => entry.isCurrent).map(entry => entry.sourcePosition)).toEqual([5])
    expect(context.entries.every(entry => entry.batchItemId === candidate.batchItemId && entry.senderName === '隔离发送人' && entry.conversationName === '隔离群')).toBe(true)
    expect(context.entries.map(entry => entry.body)).toEqual(bodies.slice(3, 8))
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  })

  it('共享规范正文不跨附件，其他会话也不能进入候选项上下文', () => {
    const f = reviewFixture(['原话前一条', '我会处理这个问题', '其他会话原话', '原话后一条'], position => ({
      source_conversation_name: position === 2 ? '其他群' : '同源群', source_sender_name: `来源甲${position}`
    }))
    secondItem(f, 1)
    const candidate = candidateAt(f, 1), context = getCommitmentCandidateContext(f.db, candidate.id)
    expect(context.entries.map(entry => entry.sourcePosition)).toEqual([0, 1, 3])
    expect(context.entries.every(entry => entry.batchItemId === f.items[0].id && entry.conversationName === '同源群')).toBe(true)
    expect(context.entries.map(entry => entry.senderName)).toEqual(['来源甲0', '来源甲1', '来源甲3'])
    expect(context.entries.some(entry => entry.senderName === '来源乙')).toBe(false)
  })

  it.each([null, '   '])('会话未确定时上下文只保留中心原话 %s', conversation => {
    const f = reviewFixture(undefined, () => ({ source_conversation_name: conversation })), candidate = candidateAt(f)
    const context = getCommitmentCandidateContext(f.db, candidate.id)
    expect(context.entries).toHaveLength(1)
    expect(context.entries[0]).toMatchObject({ sourcePosition: 0, conversationName: null, isCurrent: true })
  })

  it('打开已有候选项列表和上下文不会处理待运行记录或重跑匹配', async () => {
    const f = reviewFixture(), candidate = candidateAt(f)
    expect(ingestRadarItem(f, 1, commitmentMessages(['我会处理历史问题'])
      .map(message => ({ ...message, source_message_id: '只读测试待处理原生身份' }))).status).toBe('success')
    const match = vi.spyOn(matcher, 'matchCommitmentBody'), process = vi.spyOn(processor, 'processCommitmentExtractorRun')
    const before = reviewDatabaseFingerprint(f), api = ipc(f)
    await api.call('list'); await api.call('context', candidate.id)
    expect(match).not.toHaveBeenCalled(); expect(process).not.toHaveBeenCalled()
    expect(f.db.prepare('SELECT status,attempt_count FROM commitment_extractor_runs WHERE batch_item_id=?').get(f.items[1].id))
      .toEqual({ status: 'pending', attempt_count: 0 })
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  })

  it('隔离旧三百零九条消息和一百零四条来源，打开列表不回扫或创建派生数据', async () => {
    const f = radarFixture(); prepareSchemaV7Fixture(f.db)
    const messages = commitmentMessages(Array.from({ length: 309 }, (_value, index) => `我会处理历史问题${index}`))
    expect(ingestWorkBuddyMessages(f.db, { messages }).importedCount).toBe(309)
    expect(ingestRadarItem(f, 0, messages.slice(0, 104)).importedCount).toBe(0)
    migrateBatchImportSchema(f.db)
    const before = reviewDatabaseFingerprint(f), spy = vi.spyOn(matcher, 'matchCommitmentBody')
    expect(await ipc(f).call('list')).toEqual({ ok: true, value: [] })
    expect(spy).not.toHaveBeenCalled()
    expect(radarCount(f.db, 'messages')).toBe(309); expect(radarCount(f.db, 'messages_fts')).toBe(309)
    expect(radarCount(f.db, 'batch_item_message_sources')).toBe(104)
    expect(radarCount(f.db, 'commitment_candidates')).toBe(0); expect(radarCount(f.db, 'commitment_extractor_runs')).toBe(0)
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  })
})

describe('候选项证据仅定位当前附件', () => {
  it('共享规范消息时只打开当前附件目录，证据字节及全部业务记录保持不变', async () => {
    const f = reviewFixture(), candidate = secondItem(f)
    const firstDirectory = await saveReviewEvidence(f, 0), secondDirectory = await saveReviewEvidence(f, 1)
    const paths = [join(firstDirectory, 'original.zip'), join(firstDirectory, 'messages.json'), join(secondDirectory, 'original.zip'), join(secondDirectory, 'messages.json')]
    const bytes = paths.map(path => readFileSync(path)), before = reviewDatabaseFingerprint(f), open = vi.fn(async () => '')
    expect(await openCommitmentCandidateEvidence(f.db, f.path, candidate.id, open)).toEqual({ batchItemId: f.items[1].id, opened: true })
    expect(open).toHaveBeenCalledExactlyOnceWith(secondDirectory)
    expect(paths.map(path => readFileSync(path))).toEqual(bytes)
    expect(reviewDatabaseFingerprint(f)).toBe(before)
    const reviewBefore = reviewDatabaseFingerprint(f, true)
    confirmCommitmentCandidate(f.db, candidate.id); ignoreCommitmentCandidate(f.db, candidate.id)
    expect(reviewDatabaseFingerprint(f, true)).toBe(reviewBefore)
    expect(paths.map(path => readFileSync(path))).toEqual(bytes)
  }, 30000)

  it('当前附件未登记证据时保留候选项，不回退到另一个完整来源', async () => {
    const f = reviewFixture(), candidate = secondItem(f), open = vi.fn(async () => '')
    await saveReviewEvidence(f, 0)
    const before = reviewDatabaseFingerprint(f)
    expect(candidate.source).toMatchObject({ evidenceRecorded: false, batchItemId: f.items[1].id })
    expect(await safeCommitmentAction(() => openCommitmentCandidateEvidence(f.db, f.path, candidate.id, open)))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_UNAVAILABLE' } })
    expect(open).not.toHaveBeenCalled()
    expect(candidateAt(f, 0, 1)).toEqual(candidate)
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  }, 30000)

  it.each(['缺失原始文件', '损坏原始文件', '损坏消息快照'] as const)('%s 时不改候选项、不改变核心状态、不打开其他附件', async condition => {
    const f = reviewFixture(), candidate = secondItem(f), open = vi.fn(async () => '')
    await saveReviewEvidence(f, 0); const directory = await saveReviewEvidence(f, 1)
    if (condition === '缺失原始文件') unlinkSync(join(directory, 'original.zip'))
    else writeFileSync(join(directory, condition === '损坏原始文件' ? 'original.zip' : 'messages.json'), '隔离损坏')
    confirmCommitmentCandidate(f.db, candidate.id)
    const reviewed = candidateAt(f, 0, 1), before = reviewDatabaseFingerprint(f)
    expect(await safeCommitmentAction(() => openCommitmentCandidateEvidence(f.db, f.path, candidate.id, open)))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_UNAVAILABLE' } })
    expect(open).not.toHaveBeenCalled(); expect(candidateAt(f, 0, 1)).toEqual(reviewed)
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  }, 30000)

  it('证据路径逃逸直接失败，不信任数据库中的任意路径', async () => {
    const f = reviewFixture(), open = vi.fn(async () => '')
    await saveReviewEvidence(f)
    f.db.prepare("UPDATE batch_import_items SET evidence_relative_path='../其他来源.zip' WHERE id=?").run(f.items[0].id)
    const before = reviewDatabaseFingerprint(f)
    expect(await safeCommitmentAction(() => openCommitmentCandidateEvidence(f.db, f.path, candidateAt(f).id, open)))
      .toMatchObject({ ok: false, error: { code: 'EVIDENCE_UNAVAILABLE' } })
    expect(open).not.toHaveBeenCalled(); expect(reviewDatabaseFingerprint(f)).toBe(before)
  }, 30000)

  it('系统打开失败返回受控错误，不把系统路径写入或返回', async () => {
    const f = reviewFixture(); await saveReviewEvidence(f)
    const before = reviewDatabaseFingerprint(f), open = vi.fn(async () => 'C:\\秘密路径 系统错误')
    const result = await safeCommitmentAction(() => openCommitmentCandidateEvidence(f.db, f.path, candidateAt(f).id, open))
    expect(result).toMatchObject({ ok: false, error: { code: 'EVIDENCE_UNAVAILABLE' } })
    expect(JSON.stringify(result)).not.toContain('秘密路径')
    expect(reviewDatabaseFingerprint(f)).toBe(before)
  }, 30000)
})
