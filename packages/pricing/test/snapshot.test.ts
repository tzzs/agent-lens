import { describe, expect, it } from 'vitest'
import { normalizeLitellmEntries, loadSnapshot, bundledSnapshot, PricingDataError, type PriceSnapshot, type RawLitellmEntry } from '../src/snapshot.ts'

const GENERATED_AT = Date.UTC(2026, 8, 20)

function snap(entries: RawLitellmEntry[]): PriceSnapshot {
  return { fetchedAt: GENERATED_AT, source: 'test', entries }
}

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
    ]) {
      expect(models.has(m), m).toBe(true)
    }
  })

  it('normalizes without throwing and drops budget aliases', () => {
    const entries = normalizeLitellmEntries(bundledSnapshot(), { generatedAt: GENERATED_AT })
    expect(entries.every((e) => !e.model.includes('budget'))).toBe(true)
    expect(entries.length).toBe(8)
  })
})
