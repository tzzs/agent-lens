import { describe, expect, it } from 'vitest'
import { normalizeLitellmEntries, loadSnapshot, bundledSnapshot, PricingDataError, type PriceSnapshot, type RawLitellmEntry } from '../src/snapshot.ts'
import { PricingTable } from '../src/table.ts'

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
