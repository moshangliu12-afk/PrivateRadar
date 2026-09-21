const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** 仅用于 UI 日历导航；日期键始终是无时区的本地日历日期。 */
export function shiftLocalDateKey(dateKey: string, offset: number): string {
  const { year, month, day } = parseLocalDateKey(dateKey)
  const value = new Date(year, month - 1, day, 12, 0, 0, 0)
  value.setDate(value.getDate() + offset)
  return toDateKey(value.getFullYear(), value.getMonth() + 1, value.getDate())
}

export function formatLocalDateKey(dateKey: string): string {
  const { year, month, day } = parseLocalDateKey(dateKey)
  return `${year}年${month}月${day}日`
}

export function canNavigateToNextDate(selectedDate: string, latestDate: string): boolean {
  return selectedDate < latestDate
}

export function shouldShowReturnToLatest(selectedDate: string, latestDate: string): boolean {
  return selectedDate < latestDate
}

function parseLocalDateKey(value: string): { year: number; month: number; day: number } {
  const match = DATE_KEY_PATTERN.exec(value)
  if (!match) throw new Error('日期必须为 YYYY-MM-DD')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, 12, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('日期无效')
  }
  return { year, month, day }
}

function toDateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
