import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToMain } from 'node:timers/promises'
import type { HistoricalRescanState } from '../../shared/historical-keyword-rescan'
import { freezeKeywordRules } from './config'
import { matchKeywordSnapshot } from './matcher'
import { parseRulesSnapshot, type RulesSnapshot } from './contracts'

const activeJobs = new Set<string>()
const errors = {
  RESCAN_BUSY: '已有历史扫描正在运行，请等待结束。',
  RULE_UNAVAILABLE: '关键词组已停用、归档或不存在，请刷新。',
  RULE_CHANGED: '规则已发生变化，本次扫描已停止。请使用当前规则重新扫描。',
  SCAN_FAILED: '历史扫描未完成，原聊天与其他规则未改动。可重新扫描以完成校准。',
  INTERRUPTED: '上次历史扫描已中断，请重新扫描。',
  CANCELLED: '历史扫描已取消。已安全写入的派生结果保留，可再次扫描完成校准。'
} as const
type ErrorCode = keyof typeof errors
export class HistoricalRescanError extends Error {
  constructor(readonly code: ErrorCode) { super(errors[code]) }
}
interface RunRow {
  id: string; group_id: string; status: HistoricalRescanState['status']; owner_pid: number; rules_snapshot_json: string
  scanned_messages: number; total_messages: number; matched_hits: number; new_hits: number; existing_hits: number; removed_hits: number
  started_at: string; finished_at: string | null; error_code: ErrorCode | null
}
function alive(row: RunRow): boolean {
  if (row.owner_pid === process.pid) return activeJobs.has(row.id)
  try { process.kill(row.owner_pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
function view(row: RunRow): HistoricalRescanState {
  const interrupted = row.status === 'running' && !alive(row)
  return { id: row.id, groupId: row.group_id, status: interrupted ? 'failed' : row.status,
    scannedMessages: row.scanned_messages, totalMessages: row.total_messages, matchedHits: row.matched_hits,
    newHits: row.new_hits, existingHits: row.existing_hits, removedHits: row.removed_hits,
    startedAt: row.started_at, finishedAt: row.finished_at, error: interrupted ? errors.INTERRUPTED : row.error_code ? errors[row.error_code] : null }
}
function selectedRules(db: DatabaseSync, groupId: string): RulesSnapshot {
  const all = freezeKeywordRules(db), group = all.groups.find(group => group.group_id === groupId)
  if (!group) throw new HistoricalRescanError('RULE_UNAVAILABLE')
  return { ...all, groups: [group] }
}

/** 只对已经明确重扫覆盖的来源应用其冻结规则，防止迟到的旧导入任务恢复失效结果。 */
export function rulesAfterHistoricalRescan(db: DatabaseSync, original: RulesSnapshot, batchItemId: string, sourcePosition: number): RulesSnapshot {
  const rows = db.prepare(`SELECT r.rules_snapshot_json FROM keyword_rescan_coverage c JOIN keyword_rescans r ON r.id=c.run_id
    WHERE c.batch_item_id=? AND c.source_position=? ORDER BY c.group_id`).all(batchItemId, sourcePosition)
  if (!rows.length) return original
  const groups = new Map(original.groups.map(group => [group.group_id, group]))
  for (const row of rows) for (const group of parseRulesSnapshot(String(row.rules_snapshot_json)).groups) groups.set(group.group_id, group)
  return { ...original, groups: [...groups.values()].sort((a, b) => a.group_id < b.group_id ? -1 : a.group_id > b.group_id ? 1 : 0) }
}

export function createHistoricalRescanService(db: DatabaseSync, options: {
  onBatch?: (state: HistoricalRescanState) => void | Promise<void>
} = {}) {
  const cancelled = new Set<string>(), tasks = new Map<string, Promise<void>>()
  const read = (id: string) => db.prepare('SELECT * FROM keyword_rescans WHERE id=?').get(id) as unknown as RunRow | undefined
  const finish = (id: string, status: 'failed' | 'complete' | 'cancelled', code: ErrorCode | null) => {
    db.prepare("UPDATE keyword_rescans SET status=?,finished_at=?,error_code=? WHERE id=? AND status='running'").run(status, new Date().toISOString(), code, id)
  }
  async function execute(id: string, rulesJson: string, upperMessage: number, upperSource: number): Promise<void> {
    const run = read(id)!, groupId = run.group_id, rules = parseRulesSnapshot(rulesJson), group = rules.groups[0]
    const check = () => {
      if (cancelled.has(id)) throw new HistoricalRescanError('CANCELLED')
      if (read(id)?.status !== 'running' || JSON.stringify(selectedRules(db, groupId)) !== rulesJson) throw new HistoricalRescanError('RULE_CHANGED')
    }
    const write = (action: () => void) => {
      db.exec('BEGIN IMMEDIATE')
      try { check(); action(); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
    }
    const addCounts = db.prepare(`UPDATE keyword_rescans SET scanned_messages=scanned_messages+?,matched_hits=matched_hits+?,
      new_hits=new_hits+?,existing_hits=existing_hits+?,removed_hits=removed_hits+? WHERE id=? AND status='running'`)
    const oldHit = db.prepare('SELECT id,group_name_snapshot,matched_terms_snapshot FROM keyword_hits WHERE group_id=? AND batch_item_id=? AND source_position=?')
    const insertHit = db.prepare('INSERT INTO keyword_hits(id,group_id,batch_item_id,source_position,group_name_snapshot,matched_terms_snapshot,matched_at) VALUES(?,?,?,?,?,?,?)')
    const updateHit = db.prepare('UPDATE keyword_hits SET group_name_snapshot=?,matched_terms_snapshot=?,matched_at=? WHERE id=?')
    const deleteHit = db.prepare('DELETE FROM keyword_hits WHERE group_id=? AND batch_item_id=? AND source_position=?')
    const coverSource = db.prepare(`INSERT INTO keyword_rescan_coverage(id,group_id,message_id,batch_item_id,source_position,run_id)
      VALUES(?,?,?,?,?,?) ON CONFLICT(group_id,batch_item_id,source_position) WHERE batch_item_id IS NOT NULL DO UPDATE SET run_id=excluded.run_id`)
    const coverOrphan = db.prepare(`INSERT INTO keyword_rescan_coverage(id,group_id,message_id,run_id,matched_terms_snapshot,matched_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(group_id,message_id) WHERE batch_item_id IS NULL
      DO UPDATE SET run_id=excluded.run_id,matched_terms_snapshot=excluded.matched_terms_snapshot,
        matched_at=CASE WHEN keyword_rescan_coverage.matched_terms_snapshot IS excluded.matched_terms_snapshot THEN keyword_rescan_coverage.matched_at ELSE excluded.matched_at END`)
    const oldOrphan = db.prepare('SELECT matched_terms_snapshot FROM keyword_rescan_coverage WHERE group_id=? AND message_id=? AND batch_item_id IS NULL')
    const hasSource = db.prepare('SELECT 1 FROM batch_item_message_sources WHERE message_id=? LIMIT 1')
    const clearOrphan = db.prepare('UPDATE keyword_rescan_coverage SET run_id=?,matched_terms_snapshot=NULL,matched_at=NULL WHERE group_id=? AND message_id=? AND batch_item_id IS NULL AND matched_terms_snapshot IS NOT NULL')
    try {
      let cursor = 0
      while (true) {
        await yieldToMain()
        if (cancelled.has(id)) throw new HistoricalRescanError('CANCELLED')
        const candidates = db.prepare('SELECT rowid AS n,id,length(CAST(content AS BLOB)) AS bytes FROM messages WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 128').all(cursor, upperMessage) as unknown as { n: number; id: string; bytes: number }[]
        if (!candidates.length) break
        let bytes = 0, count = 0
        while (count < candidates.length && (count === 0 || bytes + candidates[count].bytes <= 2097152)) bytes += candidates[count++].bytes
        const batch = candidates.slice(0, count), ids = batch.map(row => row.id), placeholders = ids.map(() => '?').join(',')
        const bodies = db.prepare(`SELECT id,content FROM messages WHERE id IN (${placeholders})`).all(...ids) as unknown as { id: string; content: string }[]
        const matches = new Map(bodies.map(message => [message.id, matchKeywordSnapshot(message.content, rules)[0]]))
        const sourced = new Set<string>()
        let sourceCursor = 0
        while (true) {
          const sources = db.prepare(`SELECT rowid AS n,message_id,batch_item_id,source_position FROM batch_item_message_sources
            WHERE message_id IN (${placeholders}) AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 256`).all(...ids, sourceCursor, upperSource) as unknown as { n: number; message_id: string; batch_item_id: string; source_position: number }[]
          if (!sources.length) break
          write(() => {
            let matched = 0, added = 0, existing = 0, removed = 0
            for (const source of sources) {
              sourced.add(source.message_id)
              const match = matches.get(source.message_id), old = oldHit.get(groupId, source.batch_item_id, source.source_position)
              if (match) {
                matched++; const terms = JSON.stringify(match.matched_terms)
                if (old) { existing++; if (old.group_name_snapshot !== group.group_name || old.matched_terms_snapshot !== terms) updateHit.run(group.group_name, terms, run.started_at, old.id!) }
                else { insertHit.run(randomUUID(), groupId, source.batch_item_id, source.source_position, group.group_name, terms, run.started_at); added++ }
              } else removed += Number(deleteHit.run(groupId, source.batch_item_id, source.source_position).changes)
              coverSource.run(randomUUID(), groupId, source.message_id, source.batch_item_id, source.source_position, id)
            }
            addCounts.run(0, matched, added, existing, removed, id)
          })
          sourceCursor = sources.at(-1)!.n
          await yieldToMain()
        }
        write(() => {
          let matched = 0, added = 0, existing = 0, removed = 0
          for (const message of batch) {
            // 扫描期间新增的真实来源交由原导入任务处理，不能重新建立第二份直接命中。
            if (sourced.has(message.id) || hasSource.get(message.id)) { removed += Number(clearOrphan.run(id, groupId, message.id).changes); continue }
            const match = matches.get(message.id), old = oldOrphan.get(groupId, message.id)
            const terms = match ? JSON.stringify(match.matched_terms) : null
            if (match) { matched++; if (old?.matched_terms_snapshot) existing++; else added++ }
            else if (old?.matched_terms_snapshot) removed++
            coverOrphan.run(randomUUID(), groupId, message.id, id, terms, terms ? run.started_at : null)
          }
          addCounts.run(batch.length, matched, added, existing, removed, id)
        })
        cursor = batch.at(-1)!.n
        await options.onBatch?.(view(read(id)!))
      }
      write(() => finish(id, 'complete', null))
    } catch (error) {
      const code = error instanceof HistoricalRescanError ? error.code : 'SCAN_FAILED'
      try { finish(id, code === 'CANCELLED' ? 'cancelled' : 'failed', code) } catch { /* 保留持久 running，下次明确启动可识别中断并重试。 */ }
    } finally { cancelled.delete(id); activeJobs.delete(id); tasks.delete(id) }
  }
  return {
    start(groupId: string): HistoricalRescanState {
      if (db.isTransaction) throw new HistoricalRescanError('RESCAN_BUSY')
      db.exec('BEGIN IMMEDIATE')
      let row: RunRow, rulesJson: string, upperMessage: number, upperSource: number
      try {
        const old = db.prepare("SELECT * FROM keyword_rescans WHERE status='running'").get() as unknown as RunRow | undefined
        if (old) { if (alive(old)) throw new HistoricalRescanError('RESCAN_BUSY'); finish(old.id, 'failed', 'INTERRUPTED') }
        rulesJson = JSON.stringify(selectedRules(db, groupId))
        const total = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n)
        upperMessage = Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').get()!.n)
        upperSource = Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM batch_item_message_sources').get()!.n)
        const id = randomUUID()
        db.prepare("INSERT INTO keyword_rescans(id,group_id,rules_snapshot_json,owner_pid,status,total_messages,started_at) VALUES(?,?,?,?,'running',?,?)").run(id, groupId, rulesJson, process.pid, total, new Date().toISOString())
        row = read(id)!; db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      activeJobs.add(row.id)
      const task = new Promise<void>(resolve => setImmediate(() => { void execute(row.id, rulesJson, upperMessage, upperSource).then(resolve, () => {
        try { if (db.isOpen) finish(row.id, 'failed', 'SCAN_FAILED') } catch { /* 下次明确启动识别中断。 */ }
        activeJobs.delete(row.id); tasks.delete(row.id); resolve()
      }) }))
      tasks.set(row.id, task)
      return view(row)
    },
    status(groupId: string): HistoricalRescanState | null {
      const row = db.prepare('SELECT * FROM keyword_rescans WHERE group_id=? ORDER BY rowid DESC LIMIT 1').get(groupId) as unknown as RunRow | undefined
      return row ? view(row) : null
    },
    cancel(runId: string): void { if (activeJobs.has(runId) && tasks.has(runId)) cancelled.add(runId) },
    async wait(runId: string): Promise<void> { await tasks.get(runId) }
  }
}
