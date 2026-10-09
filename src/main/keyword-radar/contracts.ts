import { z } from 'zod'
import { normalizeKeywordTermV1 } from './normalization'

const nonempty = z.string().min(1)
const termSnapshot = z.object({ term_id: nonempty, term: nonempty, normalized_term: nonempty }).strict()
  .refine(value => value.term.trim().length > 0 && value.term === value.term.trim().normalize('NFC') &&
    value.normalized_term === normalizeKeywordTermV1(value.term), '关键词快照规范化不一致')
const uniqueIds = (values: Array<{ term_id: string }>) => new Set(values.map(value => value.term_id)).size === values.length
export const rulesSnapshotSchema = z.object({
  snapshot_version: z.literal(1), matching_version: z.literal('literal-nfc-ascii-v1'),
  groups: z.array(z.object({
    group_id: nonempty, group_name: nonempty,
    terms: z.array(termSnapshot).refine(uniqueIds, '关键词标识重复')
  }).strict()).refine(groups => new Set(groups.map(group => group.group_id)).size === groups.length, '分组标识重复')
}).strict()
export const sourcePositionsSnapshotSchema = z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .min(1).max(500).refine(positions => positions.every((position, index) => index === 0 || positions[index - 1] < position), '来源位置必须递增且唯一')
export const manualJsonSourcePositionsSnapshotSchema = z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .min(1).refine(positions => positions.every((position, index) => index === 0 || positions[index - 1] < position), '来源位置必须递增且唯一')
export const matchedTermsSnapshotSchema = z.object({
  snapshot_version: z.literal(1), terms: z.array(termSnapshot).min(1).refine(uniqueIds, '命中关键词标识重复')
}).strict()
export type RulesSnapshot = z.infer<typeof rulesSnapshotSchema>
export type MatchedTermsSnapshot = z.infer<typeof matchedTermsSnapshotSchema>
export function parseRulesSnapshot(json: string): RulesSnapshot { return rulesSnapshotSchema.parse(JSON.parse(json)) }
export function parseSourcePositionsSnapshot(json: string): number[] { return sourcePositionsSnapshotSchema.parse(JSON.parse(json)) }
export function parseMatchedTermsSnapshot(json: string): MatchedTermsSnapshot { return matchedTermsSnapshotSchema.parse(JSON.parse(json)) }
