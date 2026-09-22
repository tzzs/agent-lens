/**
 * §18 row 2 and §三 through this adapter: the fold is declared, the declared fold is what
 * makes the numbers right, and the store's five-fold token duplication is what makes the
 * declaration necessary.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGGREGATION,
  aggregateUsage,
  sumUsage,
  type AgentEvent,
  type Usage,
} from '@agentlens/event-model'
import { ZCODE_AGGREGATION, zcodeAdapter } from '../src/index.ts'
import { NON_SOURCE_TABLES, TABLE_MODEL_USAGE } from '../src/record.ts'
import {
  FIXTURE_MODEL_USAGE,
  FIXTURE_SESSION_TARGET,
  FIXTURE_TURN_USAGE,
  buildHost,
  modelUsageColumnTotals,
  turnUsageTotal,
  type BuiltHost,
} from '../fixtures/build-host.ts'
import { scanAll, scanSource } from './helpers.ts'

async function withHost(fn: (host: BuiltHost) => Promise<void>): Promise<void> {
  const host = await buildHost({ subdir: 'cli/db' })
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

const grandTotal = (u: Usage): number =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens

describe('aggregation policy (§18 row 2)', () => {
  it('declares per_record_sum with subagents included, and the constant is frozen', () => {
    expect(ZCODE_AGGREGATION).toEqual({ mode: 'per_record_sum', subagentsIncluded: true })
    expect(Object.isFrozen(ZCODE_AGGREGATION)).toBe(true)
    expect(zcodeAdapter.aggregation).toBe(ZCODE_AGGREGATION)
    // It is NOT the conservative default, so the difference has to be asserted deliberately.
    expect(ZCODE_AGGREGATION.mode).not.toBe(DEFAULT_AGGREGATION.mode)
  })

  it('usage always rides exactly one event type, so the fold has one source of numbers', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      for (const e of events) {
        if (e.usage) expect(e.type, `usage rode a ${e.type} row`).toBe('generation.end')
        else expect(e.usageSource).toBe('missing')
      }
    })
  })

  it('the errored and cancelled calls stay on the ledger at zero, not dropped', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, TABLE_MODEL_USAGE)
      const failed = events.filter((e) => e.status === 'error')
      expect(failed).toHaveLength(2)
      for (const e of failed) {
        expect(e.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
        expect(typeof e.errorFingerprint).toBe('string')
        expect(String(e.errorFingerprint)).toMatch(/^[0-9a-f]{64}$/)
      }
      // §五: one `error_type` class per fingerprint family, `rate_limited` vs `cancelled`.
      expect(new Set(failed.map((e) => e.errorFingerprint)).size).toBe(2)
    })
  })

  it('the §三 step-finish copy rides no usage at all', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'part')
      const stepFinish = events.filter((e) => e.subtype === 'step-finish')
      expect(stepFinish).toHaveLength(2)
      for (const e of stepFinish) {
        expect(e.type).toBe('unknown')
        expect(e.usage).toBe(null)
        expect(e.usageSource).toBe('missing')
        expect(e.metadata?.duplicate_of).toBe('model_usage')
      }
      // The drift evidence itself: the same totals as the `model_usage` rows, in metadata.
      const rollup = stepFinish[0]?.metadata?.rollup as { tokens: Record<string, number & { read?: number }> }
      expect(JSON.stringify(rollup.tokens)).toContain('26496')
    })
  })

  it('restated totals never reach usage (§四)', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      const totals = modelUsageColumnTotals()
      for (const e of events) {
        if (!e.usage) continue
        const u = e.usage
        // `computed_total_tokens` is `input + output`, so a usage that contained it twice
        // over would show up here as an input larger than the raw column.
        expect(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens).toBeLessThanOrEqual(totals.input)
        const meta = e.metadata?.rollup as
          | { computed_total_tokens?: number | null; provider_total_tokens?: number | null }
          | undefined
        // `provider_total_tokens` is a nullable column (§五's error rows carry NULL), so the
        // rollup is number-or-null — and in either case it lives in metadata, never in usage.
        expect(meta?.computed_total_tokens === null || typeof meta?.computed_total_tokens === 'number').toBe(true)
        expect(meta?.provider_total_tokens === null || typeof meta?.provider_total_tokens === 'number').toBe(true)
        // `usage` has exactly the five token fields; no rollup column can slip in.
        expect(Object.keys(u)).toEqual([
          'inputTokens',
          'outputTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
          'reasoningTokens',
        ])
        // The rollup is a RESTATEMENT, so it must equal the buckets it was computed from —
        // once. If `computed_total` had been folded into `inputTokens`, the sum of the
        // buckets would exceed it, which is the double count §三/§四 forbid.
        const grand = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
        expect(grand).toBe(meta?.computed_total_tokens)
        if (u.cacheReadTokens > 0) expect(u.inputTokens).toBeLessThan(Number(meta?.computed_total_tokens))
      }
    })
  })

  it('the rollup tables are not sources and their numbers are not in usage (§三)', async () => {
    await withHost(async (host) => {
      expect(NON_SOURCE_TABLES).toContain('turn_usage')
      expect(NON_SOURCE_TABLES).toContain('session_target')
      const { events } = await scanAll(host.dbPath)
      const sum = sumUsage(events.flatMap((e) => (e.usage ? [e.usage] : [])))
      // Reading `turn_usage` as a sixth source would add exactly this much again.
      const turnTotal = turnUsageTotal()
      const modelTotal = modelUsageColumnTotals().computedTotal
      expect(turnTotal).toBe(modelTotal)
      expect(sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheWriteTokens).toBe(modelTotal)
      expect(sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheWriteTokens).not.toBe(modelTotal * 2)
      // And no event came from a rollup table.
      expect(new Set(events.map((e) => e.metadata?.table))).toEqual(
        new Set(['session', 'message', 'part', 'model_usage', 'tool_usage']),
      )
      expect(FIXTURE_SESSION_TARGET).toHaveLength(2)
      expect(FIXTURE_TURN_USAGE).toHaveLength(2)
    })
  })

  it('the declared fold reproduces the sum over generation.end exactly', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      const rows = events.filter((e) => e.usage)
      const folded = aggregateUsage(events, ZCODE_AGGREGATION)
      expect(folded.groups).toBe(rows.length)
      expect(folded.usage).toEqual(sumUsage(rows.map((e) => e.usage as Usage)))
      // One row per request, so the conservative default cannot inflate this adapter either:
      // MAX-per-request and SUM-per-row agree to the token.
      expect(aggregateUsage(events, DEFAULT_AGGREGATION).usage).toEqual(folded.usage)
    })
  })

  it('subagent rows are additive work that the declared policy keeps', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      const sub = events.filter((e) => e.metadata?.subagentThread === true && e.usage)
      expect(sub).toHaveLength(1)
      const all = aggregateUsage(events, ZCODE_AGGREGATION).usage
      const withoutSub = aggregateUsage(
        events.filter((e) => e.metadata?.subagentThread !== true),
        ZCODE_AGGREGATION,
      ).usage
      // Excluding flagged rows would delete 5,200 tokens of real spend, i.e. the 9.3% ccusage
      // includes in its headline (§四).
      expect(grandTotal(all) - grandTotal(withoutSub)).toBe(5_200)
    })
  })

  it('cost is never claimed as reported, on any event (§18 row 1)', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      expect(events.length).toBeGreaterThan(30)
      for (const e of events) {
        expect(e.costReported).toBeNull()
        expect(e.costSource).toBe('none')
        expect(e.costSource).not.toBe('computed')
        expect(e.credits ?? null).toBe(null)
      }
      const anyCostColumn = events.filter((e) => {
        const rollup = e.metadata?.rollup as { cost_column_value?: unknown } | undefined
        return rollup && rollup.cost_column_value === 0
      })
      expect(anyCostColumn.length).toBeGreaterThan(0)
    })
  })
})

describe('tool-call accounting', () => {
  it('one tool_usage row is one tool.end, never a second tool.result', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'tool_usage')
      expect(events.every((e) => e.type === 'tool.end')).toBe(true)
      expect(events.filter((e) => e.type === 'tool.result')).toHaveLength(0)
      expect(new Set(events.map((e) => e.metadata?.call_id)).size).toBe(events.length)
      // No cross-source parent: §5.2 forbids the query that would be needed to set one.
      expect(events.every((e) => e.parentEventId === null)).toBe(true)
    })
  })

  it('pairs with part tool.start through metadata.call_id, both ways visible', async () => {
    await withHost(async (host) => {
      const starts = (await scanSource(host.dbPath, 'part')).events.filter((e) => e.metadata?.call_id)
      const ends = (await scanSource(host.dbPath, 'tool_usage')).events
      const startIds = new Set(starts.map((e) => e.metadata?.call_id))
      const endIds = new Set(ends.map((e) => e.metadata?.call_id))
      // 1,851/1,851 measured 1:1; the fixture seeds one row on each side of the mismatch.
      expect([...endIds].filter((c) => startIds.has(c))).toHaveLength(7)
      expect([...endIds].filter((c) => !startIds.has(c))).toEqual(['call_fixture_orphan_1'])
      // `Skill` has a `skill.invoke` and `WebFetch` a `tool.start` with no ledger row yet.
      expect([...startIds].filter((c) => !endIds.has(c))).toEqual(['call_fixture_skill_1', 'call_fixture_fetch_1'])
    })
  })

  it('carries the §五 side-effect columns no other adapter has', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'tool_usage')
      const write = events.find((e) => e.metadata?.call_id === 'call_fixture_write_1')
      expect(write?.metadata).toMatchObject({
        side_effect_scope: 'workspace',
        read_only: false,
        destructive: true,
        exit_code: 0,
        truncated: false,
      })
      const read = events.find((e) => e.metadata?.call_id === 'call_fixture_read_1')
      expect(read?.metadata).toMatchObject({ read_only: true, destructive: false, truncated: true })
      const errored = events.find((e) => e.status === 'error')
      expect(errored?.metadata?.exit_code).toBe(null)
      expect(errored?.metadata?.error_type).toBe('tool_execution_failed')
      const running = events.find((e) => e.metadata?.status === 'running')
      expect(running?.status).toBe('unknown')
    })
  })
})
