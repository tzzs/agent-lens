import { describe, expect, it } from 'vitest'
import {
  normalizeLitellmEntries,
  normalizeOpenRouterEntries,
  loadSnapshot,
  bundledSnapshot,
  openRouterRawToSnapshot,
  PricingDataError,
  type OpenRouterSnapshot,
  type PriceSnapshot,
  type RawLitellmEntry,
  type RawOpenRouterEntry,
} from '../src/snapshot.ts'
import { PricingTable } from '../src/table.ts'

const GENERATED_AT = Date.UTC(2026, 8, 20)

function snap(entries: RawLitellmEntry[]): PriceSnapshot {
  return { fetchedAt: GENERATED_AT, source: 'test', entries }
}

function orSnap(entries: RawOpenRouterEntry[]): OpenRouterSnapshot {
  return { fetchedAt: GENERATED_AT, source: 'test-openrouter', entries }
}

/** The `/api/v1/models` shape, prices as USD-per-token strings. */
const OR_API = {
  data: [
    {
      id: 'z-ai/glm-5.3-flash',
      pricing: { prompt: '0.00000015', completion: '0.0000005', input_cache_read: '0.00000003' },
    },
    {
      id: 'anthropic/claude-opus-4.8',
      pricing: {
        prompt: '0.000005',
        completion: '0.000025',
        input_cache_read: '0.0000005',
        input_cache_write: '0.00000625',
        input_cache_write_1h: '0.00001',
      },
    },
    { id: 'anthropic/claude-opus-4.8:batch', pricing: { prompt: '0.0000025', completion: '0.0000125' } },
    { id: 'nex-agi/nex-n2.5-mini:free', pricing: { prompt: '0', completion: '0' } },
    { id: '~openai/gpt-sol-latest', pricing: { prompt: '0.000002', completion: '0.00001' } },
    { id: 'google/gemini-3.8-flash', pricing: { prompt: '0.00000075', completion: '0.00000375', internal_reasoning: '0.00000375' } },
    { id: 'router-sans-slash', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'vendor/no-pricing-map' },
    { id: 42, pricing: { prompt: '0', completion: '0' } },
  ],
}

describe('openRouterRawToSnapshot', () => {
  it('wraps the API list into the snapshot envelope, ids becoming `model`', () => {
    const s = openRouterRawToSnapshot(OR_API, { fetchedAt: GENERATED_AT, source: 'test-url' })
    expect(s.source).toBe('test-url')
    expect(s.schemaVersion).toBe(1)
    expect(s.entries.map((e) => e.model)).toEqual([
      'z-ai/glm-5.3-flash',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-opus-4.8:batch',
      'nex-agi/nex-n2.5-mini:free',
      '~openai/gpt-sol-latest',
      'google/gemini-3.8-flash',
      'router-sans-slash',
      'vendor/no-pricing-map',
    ])
  })

  it('stamps entries undated so history keeps pricing after a refresh (§8, §19)', () => {
    const s = openRouterRawToSnapshot(OR_API, { fetchedAt: GENERATED_AT, source: 'test-url' })
    expect(s.entries.every((e) => e.effective_from === 0)).toBe(true)
    const table = PricingTable.fromOpenRouterSnapshot(s)
    expect(table.lookup('z-ai', 'glm-5.3-flash', Date.UTC(2020, 0, 1))?.inputPerMTok).toBeCloseTo(0.15, 10)
  })

  it('a body without a data array is a PricingDataError, not an empty table', () => {
    expect(() => openRouterRawToSnapshot({ models: [] }, { fetchedAt: 0, source: 'x' })).toThrow(PricingDataError)
    expect(() => openRouterRawToSnapshot(null, { fetchedAt: 0, source: 'x' })).toThrow(/"data" array/)
  })
})

describe('normalizeOpenRouterEntries', () => {
  const entries = normalizeOpenRouterEntries(
    openRouterRawToSnapshot(OR_API, { fetchedAt: GENERATED_AT, source: 'test-url' }),
    { generatedAt: GENERATED_AT },
  )

  it('drops the route variants and rolling aliases that would collide with the base id', () => {
    expect(entries.map((e) => `${e.provider}/${e.model}`)).toEqual([
      'z-ai/glm-5.3-flash',
      'anthropic/claude-opus-4.8',
      'google/gemini-3.8-flash',
      'unknown/router-sans-slash',
    ])
  })

  it('converts per-token string prices to per-MTok and splits the vendor prefix', () => {
    const opus = entries.find((e) => e.model === 'claude-opus-4.8')!
    expect(opus.inputPerMTok).toBeCloseTo(5, 10)
    expect(opus.outputPerMTok).toBeCloseTo(25, 10)
    expect(opus.cacheReadPerMTok).toBeCloseTo(0.5, 10)
    expect(opus.source).toBe('openrouter')
  })

  it('takes the 5-minute cache-write rate, because Usage has one cacheWrite bucket', () => {
    const opus = entries.find((e) => e.model === 'claude-opus-4.8')!
    expect(opus.cacheWritePerMTok).toBeCloseTo(6.25, 10)
  })

  it('reads the reasoning rate from internal_reasoning, and leaves absent buckets absent (§8 n/a)', () => {
    expect(entries.find((e) => e.model === 'gemini-3.8-flash')!.reasoningPerMTok).toBeCloseTo(3.75, 10)
    const glm = entries.find((e) => e.model === 'glm-5.3-flash')!
    expect(glm.reasoningPerMTok).toBeNull()
    expect(Number.isNaN(glm.cacheWritePerMTok)).toBe(true)
  })
})

describe('loadSnapshot', () => {
  it('parses and validates a snapshot', () => {
    const s = loadSnapshot(JSON.stringify(snap([{ model: 'claude-sonnet-5' }])))
    expect(s.entries).toHaveLength(1)
    expect(s.schemaVersion).toBe(1)
  })

  it('rejects entries without a string model', () => {
    expect(() => loadSnapshot(JSON.stringify({ fetchedAt: 1, source: 'x', entries: [{ foo: 1 }] }))).toThrow(PricingDataError)
  })
})

describe('normalizeLitellmEntries', () => {
  it('converts per-token prices to per-MTok', () => {
    const [e] = normalizeLitellmEntries(
      snap([
        {
          model: 'claude-sonnet-5',
          litellm_provider: 'anthropic',
          input_cost_per_token: 3e-6,
          output_cost_per_token: 1.5e-5,
          cache_read_input_token_cost: 3e-7,
          cache_creation_input_token_cost: 3.75e-6,
        },
      ]),
      { generatedAt: GENERATED_AT },
    )
    expect(e!.inputPerMTok).toBeCloseTo(3, 10)
    expect(e!.outputPerMTok).toBeCloseTo(15, 10)
    expect(e!.cacheReadPerMTok).toBeCloseTo(0.3, 10)
    expect(e!.cacheWritePerMTok).toBeCloseTo(3.75, 10)
    expect(e!.provider).toBe('anthropic')
    expect(e!.effectiveFrom).toBe(GENERATED_AT)
    expect(e!.source).toBe('litellm')
  })

  it('splits provider out of provider/model keys', () => {
    const [e] = normalizeLitellmEntries(
      snap([{ model: 'vertex_ai/gemini-2-5-pro', input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 }]),
      { generatedAt: GENERATED_AT },
    )
    expect(e!.provider).toBe('vertex_ai')
    expect(e!.model).toBe('gemini-2-5-pro')
  })

  it('ignores _budget and -budget variants', () => {
    const entries = normalizeLitellmEntries(
      snap([
        { model: 'claude-sonnet-5', input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
        { model: 'claude-sonnet-5-budget', input_cost_per_token: 1.5e-6, output_cost_per_token: 7.5e-6 },
        { model: 'gpt-5_budget', input_cost_per_token: 1e-6, output_cost_per_token: 8e-6 },
      ]),
      { generatedAt: GENERATED_AT },
    )
    expect(entries.map((e) => e.model)).toEqual(['claude-sonnet-5'])
  })

  it('treats a missing price field as absent, not 0', () => {
    const [e] = normalizeLitellmEntries(snap([{ model: 'deepseek-flash', input_cost_per_token: 2.5e-7 }]), {
      generatedAt: GENERATED_AT,
    })
    expect(e!.inputPerMTok).toBeCloseTo(0.25, 10)
    expect(Number.isNaN(e!.outputPerMTok)).toBe(true)
    expect(Number.isNaN(e!.cacheWritePerMTok)).toBe(true)
    expect(e!.reasoningPerMTok).toBeNull()
  })
})

describe('bundledSnapshot', () => {
  it('covers every model id observed on the target machine (§4.4 row 7)', () => {
    const models = new Set(bundledSnapshot().entries.map((e) => e.model))
    for (const m of [
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-haiku-4-5',
      'deepseek-flash',
      // §17 round two: Codex's model ids, which the Claude set never contained.
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2-codex',
      'gpt-5.1-codex-mini',
    ]) {
      expect(models.has(m), m).toBe(true)
    }
  })

  it('normalizes without throwing and drops budget aliases', () => {
    const entries = normalizeLitellmEntries(bundledSnapshot(), { generatedAt: GENERATED_AT })
    expect(entries.every((e) => !e.model.includes('budget'))).toBe(true)
    // A litellm-derived subset, not the hand-written stub: enough models that a new
    // agent CLI landing is unlikely to open a pricing gap on its first day.
    expect(entries.length).toBeGreaterThan(300)
    // Open-weight models are legitimately $0, so only non-negative-and-finite is invariant;
    // a missing price must stay absent (null), never a zero.
    expect(entries.every((e) => e.inputPerMTok !== null && e.inputPerMTok >= 0)).toBe(true)
    expect(entries.every((e) => e.outputPerMTok !== null && e.outputPerMTok >= 0)).toBe(true)
    expect(entries.filter((e) => e.inputPerMTok === 0).length).toBeLessThan(entries.length / 2)
  })

  it('prices apply from the epoch so events older than the fetch still cost out (§8)', () => {
    const snapshot = bundledSnapshot()
    expect(snapshot.entries.every((e) => e.effective_from === 0)).toBe(true)
    const table = PricingTable.fromSnapshot(snapshot, { generatedAt: GENERATED_AT })
    expect(table.lookup('anthropic', 'claude-sonnet-5', Date.UTC(2020, 0, 1))?.inputPerMTok).toBe(2)
  })
})
