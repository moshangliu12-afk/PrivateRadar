import { z } from 'zod'

export const commitmentTextSchema = z.string().refine(value => value.trim().length > 0, '字段不能为空')
export const commitmentSourcePositionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positionsInputSchema = z.array(commitmentSourcePositionSchema)
export const commitmentSourcePositionsSnapshotSchema = positionsInputSchema.refine(
  positions => positions.every((position, index) => index === 0 || positions[index - 1] < position),
  '来源位置必须递增且唯一'
)
/** 只规范化明确传入的位置；空集合保持空集合，绝不扫描附件项补全。 */
export function freezeCommitmentSourcePositions(positions: number[]): number[] {
  return [...new Set(positionsInputSchema.parse(positions))].sort((left, right) => left - right)
}
export function parseCommitmentSourcePositions(json: string): number[] {
  return commitmentSourcePositionsSnapshotSchema.parse(JSON.parse(json))
}

export interface CommitmentExtractorRun {
  batch_item_id: string
  core_import_job_id: string
  rule_version: string
  source_positions_snapshot_json: string
  status: 'pending' | 'complete' | 'failed'
  attempt_count: number
  created_at: string
  processed_at: string | null
  error_summary: string | null
}
export interface CommitmentCandidate {
  id: string
  batch_item_id: string
  source_position: number
  status: 'pending' | 'confirmed' | 'ignored'
  reason_code: string
  rule_id: string
  rule_version: string
  created_at: string
  reviewed_at: string | null
}
export const createCommitmentCandidateSchema = z.object({
  batchItemId: commitmentTextSchema,
  sourcePosition: commitmentSourcePositionSchema,
  reasonCode: commitmentTextSchema,
  ruleId: commitmentTextSchema,
  ruleVersion: commitmentTextSchema
}).strict()
export type CreateCommitmentCandidateInput = z.infer<typeof createCommitmentCandidateSchema>
export const commitmentReviewStatusSchema = z.enum(['confirmed', 'ignored'])
export type CommitmentReviewStatus = z.infer<typeof commitmentReviewStatusSchema>
