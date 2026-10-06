import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeKeywordTermV1 } from './normalization'
import { rulesSnapshotSchema, type RulesSnapshot } from './contracts'

export interface KeywordGroup {
  id: string; name: string; enabled: number; archived_at: string | null; created_at: string; updated_at: string
}
export interface KeywordTerm {
  id: string; group_id: string; term: string; normalized_term: string; enabled: number; created_at: string
}
function groupName(name: string): string {
  const value = name.trim()
  if (!value) throw new Error('KEYWORD_GROUP_EMPTY: 分组名称不能为空')
  return value
}
function changed(count: number | bigint): void {
  if (count !== 1) throw new Error('KEYWORD_CONFIG_NOT_FOUND: 配置不存在或已归档')
}
export function createKeywordGroup(db: DatabaseSync, name: string): KeywordGroup {
  const id = randomUUID(), now = new Date().toISOString()
  db.prepare('INSERT INTO keyword_groups (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, groupName(name), now, now)
  return listKeywordGroups(db).find(group => group.id === id)!
}
export function listKeywordGroups(db: DatabaseSync): KeywordGroup[] {
  return db.prepare('SELECT * FROM keyword_groups ORDER BY id').all() as unknown as KeywordGroup[]
}
export function renameKeywordGroup(db: DatabaseSync, id: string, name: string): void {
  changed(db.prepare('UPDATE keyword_groups SET name=?,updated_at=? WHERE id=? AND archived_at IS NULL')
    .run(groupName(name), new Date().toISOString(), id).changes)
}
export function setKeywordGroupEnabled(db: DatabaseSync, id: string, enabled: boolean): void {
  changed(db.prepare('UPDATE keyword_groups SET enabled=?,updated_at=? WHERE id=? AND archived_at IS NULL')
    .run(Number(enabled), new Date().toISOString(), id).changes)
}
export function archiveKeywordGroup(db: DatabaseSync, id: string): void {
  const now = new Date().toISOString()
  changed(db.prepare('UPDATE keyword_groups SET enabled=0,archived_at=?,updated_at=? WHERE id=? AND archived_at IS NULL')
    .run(now, now, id).changes)
}
export function addKeywordTerm(db: DatabaseSync, groupId: string, term: string): KeywordTerm {
  const display = term.trim().normalize('NFC'), normalized = normalizeKeywordTermV1(term), id = randomUUID()
  // 单条语句同时校验归档状态，避免配置操作之间出现读写竞态。
  changed(db.prepare(`INSERT INTO keyword_terms (id,group_id,term,normalized_term,created_at)
    SELECT ?,id,?,?,? FROM keyword_groups WHERE id=? AND archived_at IS NULL`)
    .run(id, display, normalized, new Date().toISOString(), groupId).changes)
  return listKeywordTerms(db, groupId).find(value => value.id === id)!
}
export function listKeywordTerms(db: DatabaseSync, groupId: string): KeywordTerm[] {
  return db.prepare('SELECT * FROM keyword_terms WHERE group_id=? ORDER BY id').all(groupId) as unknown as KeywordTerm[]
}
export function setKeywordTermEnabled(db: DatabaseSync, id: string, enabled: boolean): void {
  changed(db.prepare(`UPDATE keyword_terms SET enabled=? WHERE id=? AND group_id IN
    (SELECT id FROM keyword_groups WHERE archived_at IS NULL)`).run(Number(enabled), id).changes)
}
/** 核心写事务内单次读取配置，冻结结果不再依赖以后配置的状态。 */
export function freezeKeywordRules(db: DatabaseSync): RulesSnapshot {
  if (!db.isTransaction) throw new Error('KEYWORD_SNAPSHOT_TRANSACTION_REQUIRED')
  const rows = db.prepare(`SELECT g.id AS group_id,g.name AS group_name,t.id AS term_id,t.term,t.normalized_term
    FROM keyword_groups g LEFT JOIN keyword_terms t ON t.group_id=g.id AND t.enabled=1
    WHERE g.enabled=1 AND g.archived_at IS NULL ORDER BY g.id,t.id`).all() as unknown as Array<{
      group_id: string; group_name: string; term_id: string | null; term: string | null; normalized_term: string | null
    }>
  const groups: RulesSnapshot['groups'] = []
  for (const row of rows) {
    let group = groups.at(-1)
    if (group?.group_id !== row.group_id) {
      group = { group_id: row.group_id, group_name: row.group_name, terms: [] }
      groups.push(group)
    }
    if (row.term_id !== null) group!.terms.push({ term_id: row.term_id, term: row.term!, normalized_term: row.normalized_term! })
  }
  return rulesSnapshotSchema.parse({ snapshot_version: 1, matching_version: 'literal-nfc-ascii-v1', groups })
}
