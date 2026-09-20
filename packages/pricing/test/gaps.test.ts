import { describe, expect, it } from 'vitest'
import { PricingGaps } from '../src/gaps.ts'

describe('PricingGaps', () => {
  it('accumulates per distinct model, tolerating bracket/tier spellings', () => {
    const gaps = new PricingGaps()
    const t1 = Date.UTC(2026, 8, 1)
    const t2 = Date.UTC(2026, 8, 9)
    gaps.record('anthropic', 'claude-opus-5', t2)
    gaps.record('anthropic', 'claude-opus-5[1m]', t1)
    gaps.record('deepseek', 'deepseek-flash', t1)
    expect(gaps.count()).toBe(2)

    const top = gaps.list()[0]!
    expect(top.model).toBe('claude-opus-5')
    expect(top.occurrences).toBe(2)
    expect(top.firstSeen).toBe(t1)
    expect(top.lastSeen).toBe(t2)
  })
})
