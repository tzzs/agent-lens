/**
 * The mini-reconciliation inside the unit suite.
 *
 * §四's real reconciliation runs against the live store through `reconcile-zcode-ccusage.mjs`
 * and a snapshot baseline, which this package may not touch. What the suite CAN do is run
 * the same arithmetic over a synthetic store whose totals are pinned, so the identity the
 * production mapping is trusted with — "summing `usage` reproduces the store's own column
 * sums once, and only once" — is exercised on every test run.
 *
 * The numbers below are the fixture's, derived from `fixtures/build-host.ts` and written out
 * literally so a seed edit that changes the shape cannot pass by moving both sides.
 */
import { describe, expect, it } from 'vitest'
import { aggregateUsage, sumUsage, type Usage } from '@agentlens/event-model'
import { ZCODE_AGGREGATION } from '../src/index.ts'
import {
  FIXTURE_MODEL_USAGE,
  FIXTURE_SESSION_TARGET,
  FIXTURE_TURN_USAGE,
  buildHost,
  modelUsageColumnTotals,
  turnUsageTotal,
} from '../fixtures/build-host.ts'
import { scanAll } from './helpers.ts'

describe('fixture totals are the §四 identity in miniature', () => {
  it('summing usage equals summing input−cache_read, cache_read and output', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      const { events } = await scanAll(host.dbPath)
      const totals = modelUsageColumnTotals(FIXTURE_MODEL_USAGE)

      // The fixture's raw columns, pinned.
      expect(totals).toEqual({
        input: 36_817,
        output: 2_408,
        cacheRead: 30_888,
        cacheCreation: 300,
        providerTotal: 39_225,
        computedTotal: 39_225,
      })

      const summed = sumUsage(events.flatMap((e) => (e.usage ? [e.usage as Usage] : [])))
      expect(summed).toEqual({
        // uncached input = input − cache_read − cache_creation
        inputTokens: 5_629,
        outputTokens: 2_408,
        cacheReadTokens: 30_888,
        cacheWriteTokens: 300,
        reasoningTokens: 0,
      })
      expect(summed.inputTokens).toBe(totals.input - totals.cacheRead - totals.cacheCreation)

      // §四's identity over the mapped buckets: they re-add to the store's own total once.
      const grand = (u: Usage): number =>
        u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
      expect(grand(summed)).toBe(totals.computedTotal)
      expect(summed.inputTokens + summed.outputTokens + summed.cacheReadTokens + summed.cacheWriteTokens).toBe(
        totals.computedTotal,
      )
      // The wrong direction (Anthropic-style copy, as the OpenCode adapter must do it) would
      // overstate exactly the cached share.
      expect(totals.input + totals.cacheRead + totals.cacheCreation).toBe(68_005)
      expect(grand(summed)).toBeLessThan(totals.input + totals.cacheRead + totals.cacheCreation)
    } finally {
      await host.close()
    }
  })

  it('the declared fold reaches the same headline as the row sum', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      const { events } = await scanAll(host.dbPath)
      const folded = aggregateUsage(events, ZCODE_AGGREGATION)
      expect(folded.mode).toBe('per_record_sum')
      expect(folded.groups).toBe(FIXTURE_MODEL_USAGE.length)
      expect(folded.usage.inputTokens + folded.usage.outputTokens + folded.usage.cacheReadTokens + folded.usage.cacheWriteTokens).toBe(
        39_225,
      )
    } finally {
      await host.close()
    }
  })

  it('each ignored rollup restates the same 39,225, so reading it would double the bill', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      const { events } = await scanAll(host.dbPath)
      const fromUsage = aggregateUsage(events, ZCODE_AGGREGATION).usage
      const grand = (u: Usage): number =>
        u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
      const usageTotal = grand(fromUsage)

      // §三 copies #4 and #5, seeded as exact sums of #1.
      expect(turnUsageTotal(FIXTURE_TURN_USAGE)).toBe(usageTotal)
      expect(FIXTURE_SESSION_TARGET.reduce((n, t) => n + t.tokensUsed, 0)).toBe(usageTotal)
      expect(usageTotal).toBe(39_225)
      // Had all three been sources, the "same" session would report triple the spend.
      expect(usageTotal * 3).toBe(117_675)
    } finally {
      await host.close()
    }
  })

  it('per-turn rollups match the turns they summarize', async () => {
    const host = await buildHost({ subdir: 'cli/db' })
    try {
      const { events } = await scanAll(host.dbPath)
      const byTurn = new Map<string, number>()
      for (const e of events) {
        if (!e.usage) continue
        const turn = String(e.metadata?.turn_id)
        byTurn.set(turn, (byTurn.get(turn) ?? 0) + e.usage.inputTokens + e.usage.outputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens)
      }
      // `turn_usage` sums per turn exactly, which is what makes it a rollup and not a record.
      expect(byTurn.get('turn_fixture_root_0001')).toBe(34_025)
      expect(byTurn.get('turn_fixture_child_001')).toBe(5_200)
    } finally {
      await host.close()
    }
  })
})
