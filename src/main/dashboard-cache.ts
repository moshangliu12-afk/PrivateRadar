import type { DatabaseSync } from 'node:sqlite'
import type { DashboardSummary } from '../shared/models'
import { getDashboardSummary } from './database'

type SummaryLoader = (
  db: DatabaseSync,
  databasePath: string,
  forceRegenerate?: boolean,
  refreshLocal?: boolean
) => Promise<DashboardSummary>

/** Daily 内存缓存只在数据库导入修订号未变化时复用。 */
export class DashboardSummaryCache {
  private cachedRevision: string | null | undefined
  private cachedSummary: Promise<DashboardSummary> | null = null

  constructor(
    private readonly db: DatabaseSync,
    private readonly databasePath: string,
    private readonly onRevisionChanged: () => void = () => undefined,
    private readonly loader: SummaryLoader = getDashboardSummary
  ) {}

  get(): Promise<DashboardSummary> {
    const revision = readImportRevision(this.db)
    if (this.cachedSummary && revision === this.cachedRevision) return this.cachedSummary

    const revisionChanged = this.cachedRevision !== undefined && revision !== this.cachedRevision
    this.cachedRevision = revision
    if (revisionChanged) this.onRevisionChanged()
    return this.store(this.loader(this.db, this.databasePath, false, revisionChanged))
  }

  refresh(forceRegenerate = false): Promise<DashboardSummary> {
    this.cachedRevision = readImportRevision(this.db)
    return this.store(this.loader(this.db, this.databasePath, forceRegenerate, true))
  }

  private store(summary: Promise<DashboardSummary>): Promise<DashboardSummary> {
    this.cachedSummary = summary
    void summary.catch(() => {
      if (this.cachedSummary === summary) this.cachedSummary = null
    })
    return summary
  }
}

export function readImportRevision(db: DatabaseSync): string | null {
  const row = db.prepare(`
    SELECT id, completed_at
    FROM import_jobs
    WHERE status IN ('success', 'partial')
    ORDER BY COALESCE(completed_at, started_at) DESC, rowid DESC
    LIMIT 1
  `).get() as { id: string; completed_at: string | null } | undefined
  return row ? `${row.id}:${row.completed_at ?? ''}` : null
}
