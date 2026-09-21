/**
 * §18 row 2 through this adapter: the fold is declared, not guessed, and the declared
 * fold is what makes the Pi numbers right.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGGREGATION,
  aggregateUsage,
  sumUsage,
  type AgentEvent,
  type Usage,
} from '@agentlens/event-model'
import { PI_AGGREGATION } from '../src/index.ts'
import { SCENARIOS, eventsOf } from './helpers.ts'

const total = (u: Usage) =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens

describe('aggregation policy (§18 row 2)', () => {
  it('the adapter declares request_max and matches the conservative default', () => {
    expect(PI_AGGREGATION).toEqual({ mode: 'request_max', subagentsIncluded: true })
    expect(PI_AGGREGATION.mode).toBe(DEFAULT_AGGREGATION.mode)
  })

  it('usage always rides exactly one event type, so the group is well-formed', async () => {
    for (const name of SCENARIOS) {
      const events = await eventsOf(name)
      for (const e of events) {
        if (e.usage) expect(e.type, `${name} put usage on a ${e.type} row`).toBe('generation.end')
        else expect(e.usageSource).toBe('missing')
      }
    }
  })

  it('a response restated under the same responseId collapses to one copy under the declared fold', async () => {
    const events = await eventsOf('shared-usage.jsonl')
    const usageEvents = events.filter((e): e is AgentEvent & { usage: Usage } => e.usage !== null)
    expect(usageEvents).toHaveLength(2)
    const perEvent = sumUsage(usageEvents.map((e) => e.usage))
    const folded = aggregateUsage(events, PI_AGGREGATION)

    expect(folded.groups).toBe(1)
    expect(folded.usage).toEqual({
      inputTokens: 100,
      outputTokens: 500,
      cacheReadTokens: 9000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
    // The per-event sum the naive reader would produce is exactly double (§4.4 row 2).
    expect(total(perEvent)).toBe(2 * total(folded.usage))
  })

  it('totalTokens is never folded in, and the four buckets stay disjoint (§18 row 4)', async () => {
    const events = await eventsOf('session-trace.jsonl')
    const usageEvent = events.find((e) => e.usage)
    expect(usageEvent?.metadata?.reported_fields).toEqual(['cacheRead', 'cacheWrite', 'input', 'output'])
    expect(usageEvent?.metadata?.unmapped_fields).toEqual(['totalTokens'])
    expect(usageEvent?.metadata?.cache_write_reported).toBe(true)
    expect(usageEvent?.metadata?.reasoning_tokens_absent).toBe(true)
    expect(usageEvent?.metadata?.input_includes_cache_read).toBe(false)
    // input and cache are disjoint buckets: the grand total is their sum, and the
    // 20168-token roll-up in `totalTokens` is not part of it.
    expect(total(usageEvent!.usage!)).toBe(120 + 2048 + 18000)
    expect(aggregateUsage(events, PI_AGGREGATION).usage.cacheWriteTokens).toBe(0)
  })

  it('cost is reported, not computed: Pi ships USD per response (pi.md §三)', async () => {
    const events = await eventsOf('session-trace.jsonl')
    const usageEvents = events.filter((e) => e.usage)
    expect(usageEvents.map((e) => e.costReported)).toEqual([0.0215, 0.0015])
    expect(usageEvents.every((e) => e.costSource === 'reported')).toBe(true)
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) {
        // The adapter owns no price table, so a computed cost would be a lie (§18 row 1).
        expect(e.costSource, `${name} claimed a computed cost`).not.toBe('computed')
      }
    }
  })
})
