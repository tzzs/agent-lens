import { describe, expect, it } from 'vitest'
import type { Usage } from '@agentlens/event-model'
import { actualUsdFor, computeCost, DAYS_PER_MONTH, formatUsd, planCostFor } from '../src/cost.ts'
import { PRICE_MISSING, type PriceEntry } from '../src/price-types.ts'

const usage: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 2_000_000,
  cacheReadTokens: 3_000_000,
  cacheWriteTokens: 4_000_000,
  reasoningTokens: 0,
}

const sonnet: PriceEntry = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  tier: null,
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  reasoningPerMTok: null,
  effectiveFrom: Date.UTC(2026, 6, 1),
  source: 'litellm',
}

// 1M*3 + 2M*15 + 3M*0.3 + 4M*3.75 = 3 + 30 + 0.9 + 15 = 48.9
const API_EQUIVALENT = 48.9

describe('computeCost billing modes (§8)', () => {
  it('api: actual = api-equivalent = tokens x price', () => {
    const c = computeCost(usage, sonnet, 'api')
    expect(c.actualUsd).toBeCloseTo(API_EQUIVALENT, 10)
    expect(c.apiEquivalentUsd).toBeCloseTo(API_EQUIVALENT, 10)
    expect(c.gap).toBe(false)
    expect(c.pricedAt).toBe(sonnet.effectiveFrom)
  })

  // The $0 here is real, not a shrug: a flat plan charges nothing for these particular tokens,
  // and `cost_total` prices an unreported slice of a plan-covered request at exactly this. A
  // plan's COST is its fee, which is a period amount and lives in `planCostFor` below — proving
  // the two halves stay separate, because merging them would NULL the §18 fusion for every
  // subscription agent on this machine.
  it('subscription: no marginal cash per request, with the api-equivalent still computed', () => {
    const c = computeCost(usage, sonnet, 'subscription')
    expect(c.actualUsd).toBe(0)
    expect(c.apiEquivalentUsd).toBeCloseTo(API_EQUIVALENT, 10)
    expect(c.gap).toBe(false)
  })

  describe('§8 the plan fee over a window', () => {
    const plan = { planUsdPerMonth: 20, windowDays: 15 }
    it('prorates a declared fee across the window it covers', () => {
      expect(planCostFor('subscription', plan)).toBeCloseTo((20 * 15) / DAYS_PER_MONTH, 10)
      expect(planCostFor('subscription', { ...plan, windowDays: DAYS_PER_MONTH })).toBeCloseTo(20, 10)
    })
    it('answers nothing at all until BOTH the fee and the window are known', () => {
      expect(planCostFor('subscription', { planUsdPerMonth: null, windowDays: 15 })).toBeNull()
      expect(planCostFor('subscription', { planUsdPerMonth: 20, windowDays: null })).toBeNull()
      expect(planCostFor('subscription')).toBeNull()
      // A fee belongs to a plan and to nothing else.
      for (const mode of ['api', 'local'] as const) expect(planCostFor(mode, plan)).toBeNull()
    })
    it('rides on top of the marginal cash, and never replaces it', () => {
      expect(actualUsdFor(100, 'subscription', plan)).toBeCloseTo((20 * 15) / DAYS_PER_MONTH, 10)
      // Undeclared fee: the marginal $0 stands, and the surface says the fee is missing.
      expect(actualUsdFor(100, 'subscription', { planUsdPerMonth: null, windowDays: 15 })).toBe(0)
      expect(actualUsdFor(100, 'subscription')).toBe(0)
    })
    it('leaves api and local alone, and an unpriced amount alone in every mode', () => {
      expect(actualUsdFor(7, 'api', plan)).toBe(7)
      expect(actualUsdFor(7, 'local', plan)).toBe(0)
      for (const mode of ['api', 'subscription', 'local'] as const) {
        expect(actualUsdFor(null, mode, plan)).toBeNull()
      }
    })
  })

  // §8 table, `local` row: "tokens have a price, cost is always $0" — the two halves
  // of that sentence address different numbers. Contract corrected 2026-09-22: the
  // earlier test pinned apiEquivalentUsd: 0, which threw away the token volume a
  // local (Ollama/vLLM) agent burned and so contradicted the table.
  it('local: actual cash is $0 while the tokens still price out as API-equivalent', () => {
    expect(computeCost(usage, sonnet, 'local')).toEqual({
      actualUsd: 0,
      apiEquivalentUsd: API_EQUIVALENT,
      mode: 'local',
      pricedAt: sonnet.effectiveFrom,
      gap: false,
    })
  })

  it('local with no price is n/a + gap, never $0 (§8: $0 would read as a priced free model)', () => {
    const c = computeCost(usage, null, 'local')
    expect(c.actualUsd).toBeNull()
    expect(c.apiEquivalentUsd).toBeNull()
    expect(c.gap).toBe(true)
  })
})

describe('computeCost gap semantics', () => {
  it('unknown price yields null + gap, never 0', () => {
    const c = computeCost(usage, null, 'api')
    expect(c.actualUsd).toBeNull()
    expect(c.apiEquivalentUsd).toBeNull()
    expect(c.actualUsd).not.toBe(0)
    expect(c.gap).toBe(true)
    expect(c.pricedAt).toBeNull()
  })

  it('a missing needed field is a gap even when the entry exists', () => {
    const noCacheWrite: PriceEntry = { ...sonnet, cacheWritePerMTok: PRICE_MISSING }
    const c = computeCost(usage, noCacheWrite, 'subscription')
    expect(c.apiEquivalentUsd).toBeNull()
    expect(c.actualUsd).toBeNull()
    expect(c.gap).toBe(true)
  })

  it('a missing cache price is fine when those tokens are zero', () => {
    const zeroCache: Usage = { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const noCache: PriceEntry = { ...sonnet, cacheReadPerMTok: PRICE_MISSING, cacheWritePerMTok: PRICE_MISSING }
    const c = computeCost(zeroCache, noCache, 'api')
    expect(c.gap).toBe(false)
    expect(c.actualUsd).toBeCloseTo(33, 10)
  })

  it('bills reasoning tokens at the dedicated price when present', () => {
    const withReasoning: PriceEntry = { ...sonnet, reasoningPerMTok: 15 }
    const c = computeCost({ ...usage, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 1_000_000 }, withReasoning, 'api')
    expect(c.actualUsd).toBeCloseTo(2 * 15 + 1 * 15, 10)
  })
})

describe('formatUsd', () => {
  it('renders null as n/a and keeps precision tiers', () => {
    expect(formatUsd(null)).toBe('n/a')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(667.96)).toBe('$667.96')
    expect(formatUsd(0.0049)).toBe('$0.0049')
  })
})
