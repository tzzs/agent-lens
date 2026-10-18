import { describe, expect, it } from 'vitest'
import { granularityFor, isIsoDate, isoDay, localMidnight, spanDays, validCustom, windowParams } from '../src/lib/window.ts'

describe('time window', () => {
  it('sends presets as-is and "all" as epoch 0', () => {
    expect(windowParams('7d', '', '')).toEqual({ since: '7d' })
    expect(windowParams('all', '', '')).toEqual({ since: '0' })
  })

  it('sends a custom range as local midnight to local end-of-day, so the last day counts whole', () => {
    const w = windowParams('custom', '2026-09-01', '2026-09-30')
    expect(Number(w.since)).toBe(new Date(2026, 8, 1).getTime())
    expect(Number(w.until)).toBe(new Date(2026, 9, 1).getTime() - 1)
    // One day: the whole of that day, not an empty window.
    const one = windowParams('custom', '2026-09-05', '2026-09-05')
    expect(Number(one.until) - Number(one.since)).toBe(new Date(2026, 8, 6).getTime() - new Date(2026, 8, 5).getTime() - 1)
  })

  it('falls back to 30d for a custom range that is unusable', () => {
    expect(windowParams('custom', '', '')).toEqual({ since: '30d' })
    expect(windowParams('custom', '2026-09-30', '2026-09-01')).toEqual({ since: '30d' })
    expect(validCustom('2026-02-31', '2026-03-01')).toBe(false)
  })

  it('reads and writes YYYY-MM-DD in the viewer calendar', () => {
    expect(isIsoDate('2026-09-01')).toBe(true)
    expect(isIsoDate('2026-9-1')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isoDay(localMidnight('2026-09-01') + 3_600_000)).toBe('2026-09-01')
  })

  it('picks coarser trend buckets for longer windows', () => {
    expect(spanDays('24h', '', '')).toBe(1)
    expect(granularityFor('30d', '', '')).toBe('day')
    expect(granularityFor('90d', '', '')).toBe('day')
    expect(granularityFor('365d', '', '')).toBe('week')
    expect(granularityFor('all', '', '')).toBe('month')
    expect(spanDays('custom', '2026-09-01', '2026-09-30')).toBe(30)
    expect(granularityFor('custom', '2025-01-01', '2026-09-30')).toBe('month')
  })
})
