const reliableSources = ['source_native', 'user_supplied'] as const

export function isReliableTimestampSource(source: string): boolean {
  return reliableSources.some((value) => value === source)
}

/** 调用方只传代码内固定的表别名；日期可解析性以 SQLite 为准。 */
export function reliableTimestampSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  const sources = reliableSources.map((value) => `'${value}'`).join(', ')
  return `(${prefix}timestamp_source IN (${sources}) AND date(${prefix}timestamp, 'localtime') IS NOT NULL)`
}
