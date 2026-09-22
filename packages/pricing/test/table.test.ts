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

describe('PricingTable.withGapFill (§8: openrouter is a fallback, not an override)', () => {
  const primary = PricingTable.fromSnapshot(
    {
      fetchedAt: JAN_2026,
      source: 'test-litellm',
      entries: [
        { model: 'anthropic/claude-sonnet-5', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
        { model: 'deepseek/deepseek-flash', input_cost_per_token: 2.5e-7, output_cost_per_token: 1e-6 },
      ],
    },
    { generatedAt: JAN_2026 },
  )

  function fallbackOf(...prices: [string, string, string][]): PricingTable {
    return PricingTable.fromOpenRouterSnapshot(
      {
        fetchedAt: JAN_2026,
        source: 'test-openrouter',
        entries: prices.map(([model, prompt, completion]) => ({
          model,
          pricing: { prompt, completion },
          effective_from: 0,
        })),
      },
      { generatedAt: JAN_2026 },
    )
  }

  it('prices a model the primary snapshot has no entry for', () => {
    const { table, added } = primary.withGapFill(fallbackOf(['z-ai/glm-5.3-flash', '1.5e-7', '5e-7']))
    expect(added).toBe(1)
    // The agent log names the model but not OpenRouter's vendor, so this is the name fallback.
    expect(table.lookup('builtin:bigmodel-start-plan', 'GLM-5.3-Flash', SEP_2026)).toMatchObject({
      inputPerMTok: 0.15,
      source: 'openrouter',
    })
  })

  it('never overrides a model the primary prices, even at a different rate', () => {
    const { table, added } = primary.withGapFill(fallbackOf(['anthropic/claude-sonnet-5', '4e-6', '2e-5']))
    expect(added).toBe(0)
    expect(table.lookup('anthropic', 'claude-sonnet-5', SEP_2026)).toMatchObject({ inputPerMTok: 2, source: 'litellm' })
  })

  it('keeps a name-only lookup unambiguous when the fallback repeats a priced name', () => {
    // `lookup` returns null when >1 provider prices one name; admitting the fallback's
    // second `deepseek-flash` would have turned priced history into gaps.
    const { table, added } = primary.withGapFill(fallbackOf(['volcano/deepseek-flash', '1e-6', '2e-6']))
    expect(added).toBe(0)
    expect(table.lookup('unknown', 'deepseek-flash', SEP_2026)?.source).toBe('litellm')
  })

  it('is immutable, and fills everything when the primary prices nothing', () => {
    const before = primary.size()
    const { table, added } = PricingTable.empty().withGapFill(fallbackOf(['a/x', '1e-6', '2e-6'], ['b/y', '1e-6', '2e-6']))
    expect(added).toBe(2)
    expect(table.size()).toBe(2)
    expect(primary.size()).toBe(before)
  })
})
