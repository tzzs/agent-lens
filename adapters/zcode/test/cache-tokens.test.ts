/**
 * §18 row 4 in its fifth dialect, and the one measurement this adapter must never lose:
 * ZCode spells its cache columns like Anthropic but counts like Codex — `input_tokens`
 * ALREADY CONTAINS `cache_read_input_tokens`. Mapping it field to field, the way the
 * OpenCode adapter correctly does, would bill the cached tokens twice.
 *
 * docs/research/zcode.md §四, over all 1,395 real rows:
 *   computed_total == input + output          1395/1395   ← the containment proof
 *   computed_total == input + output + cache     40/1395   ← exactly the cache_read=0 rows
 *   cache_read <= input                       1395/1395
 * and ccusage's independent split reproduces `166,230,363 − 158,848,192 = 7,382,171`.
 */
import { describe, expect, it } from 'vitest'
import { normalize } from '../src/normalize.ts'
import { usageFromModelUsage } from '../src/record.ts'
import { FIXED_NOW } from './helpers.ts'
import { FIXTURE_MODEL_USAGE, buildHost, modelUsageColumnTotals, type ModelUsageSeed } from '../fixtures/build-host.ts'
import { scanSource } from './helpers.ts'

const usageRow = (row: Record<string, unknown>) => ({
  seq: 1,
  offset: 1,
  occurredAt: FIXED_NOW,
  value: { __rowid: 1, __table: 'model_usage', status: 'completed', session_id: 's', ...row },
})

describe('the containment measurement (§四)', () => {
  it('holds on every fixture row, which is why the mapping subtracts', async () => {
    const totals = modelUsageColumnTotals()
    for (const seed of FIXTURE_MODEL_USAGE) {
      const cacheCreation = seed.cacheCreationInputTokens ?? 0
      // `cache_read <= input` and `cache_creation <= input`, the two containment halves.
      expect(seed.cacheReadInputTokens).toBeLessThanOrEqual(seed.inputTokens)
      expect(cacheCreation).toBeLessThanOrEqual(seed.inputTokens)
      // The identity that proves the direction: the stored total is input + output ONLY,
      // so `input` must be holding the cached buckets already.
      expect(seed.computedTotalTokens).toBe(seed.inputTokens + seed.outputTokens)
      if (seed.cacheReadInputTokens > 0) {
        expect(seed.computedTotalTokens).not.toBe(seed.inputTokens + seed.outputTokens + seed.cacheReadInputTokens)
      }
    }
    expect(totals.computedTotal).toBe(totals.input + totals.output)
  })

  it('maps input as the uncached remainder and keeps each cache bucket its own column', async () => {
    const result = await normalize(
      usageRow({
        input_tokens: 31_986,
        output_tokens: 557,
        cache_read_input_tokens: 24_960,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 0,
        computed_total_tokens: 32_543,
        provider_total_tokens: 32_543,
        logical_request_id: 'r',
      }),
      // The ctx source only affects ids, so any table name works for a unit call.
      {
        source: { id: 's', path: '/x', kind: 'sqlite', sqliteTable: 'model_usage' },
        agentId: 'zcode',
        hostId: 'zcode',
        sessionHint: null,
        resolveProject: () => null,
        now: () => FIXED_NOW,
      },
    )
    if (!('events' in result)) throw new Error('unexpected failure')
    expect(result.events[0]?.usage).toEqual({
      inputTokens: 7_026, // 31_986 − 24_960, the §四 subtraction
      outputTokens: 557,
      cacheReadTokens: 24_960,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
    // The uncached input is strictly smaller than the column, and the three buckets are
    // disjoint, so their sum is the raw input rather than twice the cached part.
    const u = result.events[0]?.usage
    expect((u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0)).toBe(31_986)
  })

  it('subtracts cache_creation too, even though this machine never uses that column', () => {
    const draft = usageFromModelUsage({
      input_tokens: 1_000,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 300,
      reasoning_tokens: 0,
      computed_total_tokens: 1_050,
    })
    expect(draft.inputTokens).toBe(500)
    expect(draft.cacheReadTokens).toBe(200)
    expect(draft.cacheWriteTokens).toBe(300)
    // The three buckets stay disjoint and re-add to the raw column exactly once.
    expect(draft.inputTokens + draft.cacheReadTokens + draft.cacheWriteTokens).toBe(1_000)
  })

  it('clamps a row whose cached buckets exceed its input instead of billing a negative', () => {
    const draft = usageFromModelUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 })
    expect(draft.inputTokens).toBe(0)
    expect(draft.cacheReadTokens).toBe(40)
    expect(draft.outputTokens).toBe(5)
    expect(draft.present).toBe(true)
  })

  it('reports absent token columns as no usage, not as a zero usage row', () => {
    expect(usageFromModelUsage({}).present).toBe(false)
    expect(usageFromModelUsage(null).present).toBe(false)
    expect(usageFromModelUsage({ status: 'completed' }).present).toBe(false)
    expect(usageFromModelUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }).present).toBe(true)
  })

  it('never lets provider_total or computed_total into usage (§四)', async () => {
    const draft = usageFromModelUsage({
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 5,
      provider_total_tokens: 110,
      computed_total_tokens: 110,
    })
    expect(draft.rollup).toEqual({ provider_total_tokens: 110, computed_total_tokens: 110 })
    expect(Object.keys(draft)).not.toContain('provider_total_tokens')
    // The four buckets re-add to the stored total exactly ONCE: `computed_total` is kept
    // beside them as evidence, never inside them.
    expect(draft.inputTokens + draft.outputTokens + draft.cacheReadTokens + draft.cacheWriteTokens).toBe(110)
    expect(draft.rollup.computed_total_tokens).toBe(110)
  })

  it('reproduces the §四 arithmetic on the fixture end to end', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      const { events } = await scanSource(host.dbPath, 'model_usage')
      const totals = modelUsageColumnTotals()
      const usage = events.filter((e) => e.usage).map((e) => e.usage as NonNullable<(typeof events)[number]['usage']>)
      expect(usage).toHaveLength(FIXTURE_MODEL_USAGE.length)
      const sum = usage.reduce(
        (acc, u) => ({
          input: acc.input + u.inputTokens,
          cacheRead: acc.cacheRead + u.cacheReadTokens,
          cacheWrite: acc.cacheWrite + u.cacheWriteTokens,
          output: acc.output + u.outputTokens,
        }),
        { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      )
      // Every cached token is in exactly one bucket.
      expect(sum.input).toBe(totals.input - totals.cacheRead - totals.cacheCreation)
      expect(sum.cacheRead).toBe(totals.cacheRead)
      expect(sum.cacheWrite).toBe(totals.cacheCreation)
      expect(sum.input + sum.cacheRead + sum.cacheWrite).toBe(totals.input)
      // The full identity: the mapped buckets re-add to the store's own total, once.
      expect(sum.input + sum.cacheRead + sum.cacheWrite + sum.output).toBe(totals.computedTotal)
      // And the reason §四's headline number is what it is: reading `input` straight across
      // would overstate uncached input by the whole cache-read total.
      expect(sum.input).toBeLessThan(totals.input)
    } finally {
      await host.close()
    }
  })
})
