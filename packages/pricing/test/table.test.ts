import { describe, expect, it } from 'vitest'
import { bundledSnapshot } from '../src/snapshot.ts'
import { normalizeModelName, PricingTable } from '../src/table.ts'
import type { PriceEntry } from '../src/price-types.ts'

const JAN_2026 = Date.UTC(2026, 0, 15)
const SEP_2026 = Date.UTC(2026, 8, 15)

function price(model: string, inputPerMTok: number, effectiveFrom: number): PriceEntry {
  return {
    provider: 'anthropic',
    model,
    tier: null,
    inputPerMTok,
    outputPerMTok: inputPerMTok * 5,
    cacheReadPerMTok: inputPerMTok / 10,
    cacheWritePerMTok: inputPerMTok * 1.25,
    reasoningPerMTok: null,
    effectiveFrom,
    source: 'litellm',
  }
}

describe('PricingTable.lookup', () => {
  it('honors effective-date windows across a mid-year price change', () => {
    const table = PricingTable.empty()
      .withOverride(price('claude-opus-4-8', 15, JAN_2026))
      .withOverride(price('claude-opus-4-8', 8, Date.UTC(2026, 5, 1)))

    const after = table.lookup('anthropic', 'claude-opus-4-8', SEP_2026)!
    expect(after.inputPerMTok).toBe(8) // newest <= occurredAt wins

    const historical = table.lookup('anthropic', 'claude-opus-4-8', JAN_2026 + 10)
    expect(historical?.inputPerMTok).toBe(15)

    // Events older than the earliest known price are a gap, not a guess.
    expect(table.lookup('anthropic', 'claude-opus-4-8', JAN_2026 - 1000)).toBeNull()
  })

  it('strips bracket forms and tier suffixes but keeps the raw name for display', () => {
    const table = PricingTable.fromSnapshot(bundledSnapshot(), { generatedAt: JAN_2026 })
    const hit = table.lookup('anthropic', 'claude-opus-4-8[1m]', SEP_2026)
    expect(hit?.model).toBe('claude-opus-4-8')

    const t = PricingTable.empty().withOverride(price('gpt-5', 5, JAN_2026))
    expect(t.lookup('openai', 'gpt-5:low', SEP_2026)?.model).toBe('gpt-5')
    expect(normalizeModelName('Claude-Opus-4-8[1m]')).toBe('claude-opus-4-8')
  })

  it('falls back to an unambiguous provider-agnostic match for sloppy provider labels', () => {
    const table = PricingTable.fromSnapshot(bundledSnapshot(), { generatedAt: JAN_2026 })
    expect(table.lookup('unknown', 'claude-haiku-4-5', SEP_2026)?.provider).toBe('anthropic')
  })

  it('returns null for unpriced models', () => {
    const table = PricingTable.fromSnapshot(bundledSnapshot(), { generatedAt: JAN_2026 })
    expect(table.lookup('anthropic', 'claude-fable-9', SEP_2026)).toBeNull()
  })

  it('override wins ties against litellm data on the same effective date', () => {
    const bundled = PricingTable.fromSnapshot(bundledSnapshot(), { generatedAt: JAN_2026 })
    const original = bundled.lookup('anthropic', 'claude-haiku-4-5', SEP_2026)!
    const table = bundled.withOverride(price('claude-haiku-4-5', 0.5, original.effectiveFrom))
    expect(table.lookup('anthropic', 'claude-haiku-4-5', SEP_2026)?.inputPerMTok).toBe(0.5)
  })
})

describe('PricingTable metadata', () => {
  it('lists models and sizes by distinct (provider, model)', () => {
    const table = PricingTable.fromSnapshot(bundledSnapshot(), { generatedAt: JAN_2026 })
    expect(table.size()).toBeGreaterThan(300)
    expect(table.models()).toContain('claude-sonnet-5')
    expect(table.models()).toContain('deepseek-flash')
    expect(PricingTable.empty().size()).toBe(0)
  })
})
