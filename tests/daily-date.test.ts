import { describe, expect, it } from 'vitest'
import { canNavigateToNextDate, formatLocalDateKey, shiftLocalDateKey, shouldShowReturnToLatest } from '../src/renderer/src/daily-date'

describe('Daily 历史日期导航', () => {
  it('按本地日历向前和向后切换日期', () => {
    expect(shiftLocalDateKey('2026-09-20', -1)).toBe('2026-09-19')
    expect(shiftLocalDateKey('2026-09-20', 1)).toBe('2026-09-21')
    expect(shiftLocalDateKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftLocalDateKey('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('在最新日期禁用下一天并隐藏回到最新', () => {
    expect(canNavigateToNextDate('2026-09-20', '2026-09-20')).toBe(false)
    expect(shouldShowReturnToLatest('2026-09-20', '2026-09-20')).toBe(false)
  })

  it('历史日期允许下一天并显示回到最新', () => {
    expect(canNavigateToNextDate('2026-09-19', '2026-09-20')).toBe(true)
    expect(shouldShowReturnToLatest('2026-09-19', '2026-09-20')).toBe(true)
    expect(formatLocalDateKey('2026-09-20')).toBe('2026年9月20日')
  })
})
