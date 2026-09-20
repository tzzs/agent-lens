import { describe, expect, it } from 'vitest'
import { formatTokens, table } from '../src/render.ts'
import { resolveSince } from '@agentlens/query'

describe('formatTokens', () => {
  it('scales to k/M/B/T with one decimal', () => {
    expect(formatTokens(8_200_000)).toBe('8.2M')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_500)).toBe('1.5k')
    expect(formatTokens(2_699_600_000)).toBe('2.7B')
    expect(formatTokens(3_000_000_000_000)).toBe('3T')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(null)).toBe('n/a')
  })
})

describe('table', () => {
  it('aligns columns with the §9 style (left default, right for numerics)', () => {
    const out = table(['Name', 'N'], [['a', 5], ['bbb', 100]], ['left', 'right'])
    const lines = out.split('\n')
    expect(lines[0]).toBe('Name    N')
    expect(lines[1]).toBe('─────────')
    expect(lines[2]).toBe('a       5')
    expect(lines[3]).toBe('bbb   100')
  })

  it('null cells render n/a', () => {
    expect(table(['C'], [[null]])).toContain('n/a')
  })
})

describe('resolveSince forms (§9 filters)', () => {
  const now = Date.UTC(2026, 8, 21, 12)
  it('relative durations', () => {
    expect(resolveSince('7d', now)).toBe(now - 7 * 86_400_000)
    expect(resolveSince('24h', now)).toBe(now - 86_400_000)
    expect(resolveSince('30m', now)).toBe(now - 30 * 60_000)
  })
  it('absolute dates', () => {
    expect(resolveSince('2026-09-01', now)).toBe(Date.UTC(2026, 8, 1))
    expect(resolveSince('20260901', now)).toBe(Date.UTC(2026, 8, 1))
    expect(resolveSince(123, now)).toBe(123)
  })
  it('rejects garbage', () => {
    expect(() => resolveSince('yesterday', now)).toThrow()
    expect(() => resolveSince('20261301', now)).toThrow()
  })
})
