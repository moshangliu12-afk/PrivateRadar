import { ingestRadarItem, radarFixture } from './keyword-radar-fixture'
import { registerCommitmentExtractorRun } from '../src/main/commitment/runs'

export const commitmentVersion = '承诺规则测试版本一'
export function commitmentFixture() {
  const f = radarFixture()
  const jobs = f.items.map((_item, index) => ingestRadarItem(f, index).jobId)
  return { ...f, jobs }
}
export function registerFixtureRun(f: ReturnType<typeof commitmentFixture>, index = 0, positions = [0, 1], version = commitmentVersion) {
  return registerCommitmentExtractorRun(f.db, f.items[index].id, f.jobs[index], version, positions, '2026-10-07T01:00:00Z')
}
export function candidateInput(f: ReturnType<typeof commitmentFixture>, index = 0, position = 0, version = commitmentVersion) {
  return { batchItemId: f.items[index].id, sourcePosition: position,
    reasonCode: '测试原因', ruleId: '测试规则', ruleVersion: version }
}
