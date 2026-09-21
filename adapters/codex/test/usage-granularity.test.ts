/**
 * §18 row 2 — the ~1971x risk, and §18 rows 2/3's subagent accounting.
 *
 * A single Codex usage record carries the per-call numbers NEXT TO the running totals;
 * folding the wrong field is not "87% too high", it is three orders of magnitude too high
 * (codex.md §一: Σlast 10.70B vs Σtotal 31,767B over the same 379 files).
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateUsage,
  DEFAULT_AGGREGATION,
  isSubagentThreadEvent,
  type AgentEvent,
} from '@agentlens/event-model'
import { CODEX_AGGREGATION, codexAdapter } from '../src/index.ts'
import { ctxFor, readFixture, recordsFromJsonl, resetStateFor } from './helpers.ts'

async function eventsOf(name: string): Promise<AgentEvent[]> {
  const ctx = ctxFor(name)
  resetStateFor(ctx)
  const out: AgentEvent[] = []
  for (const record of recordsFromJsonl(await readFixture(name))) {
    const result = await codexAdapter.normalize(record, ctx)
    if ('failure' in result) continue
    out.push(...result.events)
  }
  return out
}

function total(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
}

describe('usage granularity (§18 row 2)', () => {
  it('a record carrying per-call AND cumulative usage emits the per-call numbers only', async () => {
    const events = await eventsOf('per-call-and-cumulative.jsonl')
    const old = events.find((e) => e.subtype === 'token_count' && e.usage)
    expect(old?.usage).toEqual({
      inputTokens: 200, // 1200 reported − 1000 cached (§18 row 4: Codex input includes cache)
      outputTokens: 300,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      reasoningTokens: 120,
    })
    expect(old?.metadata?.per_call_field).toBe('last_token_usage')
    // The cumulative object survives for display and is NOT the emitted usage.
    expect(old?.metadata?.cumulative_usage).toEqual({
      total_token_usage: {
        input_tokens: 48000,
        cached_input_tokens: 40000,
        cache_write_input_tokens: 0,
        output_tokens: 3000,
        reasoning_output_tokens: 900,
        total_tokens: 51000,
      },
      model_context_window: 272000,
    })
    expect(total(old!.usage!)).toBe(1620)
    // The wrong field would have been 31x larger on this one row alone.
    expect(51000 / total(old!.usage!)).toBeGreaterThan(30)
  })

  it('the new three-level format also emits only `usage`, keeping turn_/thread_ as display', async () => {
    const events = await eventsOf('per-call-and-cumulative.jsonl')
    const fresh = events.find((e) => e.subtype === 'token_usage_record')
    expect(fresh?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 400,
      cacheReadTokens: 4800,
      cacheWriteTokens: 200,
      reasoningTokens: 0,
    })
    expect(fresh?.metadata?.per_call_field).toBe('usage')
    const cumulative = fresh?.metadata?.cumulative_usage as Record<string, { input_tokens?: number }>
    expect(cumulative.turn_token_usage?.input_tokens).toBe(6200)
    expect(cumulative.thread_token_usage?.input_tokens).toBe(54000)
    // `response_id` is the only genuine request id Codex has (§18 row 1).
    expect(fresh?.requestId).toBe('resp_00kq3x9abcd')
    expect(events.find((e) => e.subtype === 'token_count')?.requestId).toBeNull()
  })

  it('folding every usage row of the fixture equals Σ last_token_usage, not Σ total', async () => {
    const events = (await eventsOf('per-call-and-cumulative.jsonl')).filter((e) => e.usage)
    expect(events).toHaveLength(2)
    const perCall = aggregateUsage(events, CODEX_AGGREGATION)
    expect(perCall.mode).toBe('last_call_sum')
    expect(perCall.usage).toEqual({
      inputTokens: 400,
      outputTokens: 700,
      cacheReadTokens: 5800,
      cacheWriteTokens: 200,
      reasoningTokens: 120,
    })
    // The conservative default (request_max) cannot inflate here either: each row is its
    // own group because requestId is NULL unless the source really carries one.
    expect(aggregateUsage(events, DEFAULT_AGGREGATION).usage).toEqual(perCall.usage)
    // What a cumulative-fold would have produced, for the record: 51000 + 57900 input-side.
    expect(perCall.usage.inputTokens + perCall.usage.cacheReadTokens).toBeLessThan(7000)
  })

  it('placeholder and zero-usage rows never become ghost generations (§一 风险 5)', async () => {
    const events = await eventsOf('placeholder-usage.jsonl')
    const ghostly = events.filter((e) => e.subtype === 'placeholder-usage')
    expect(ghostly.map((e) => e.rawSeq)).toEqual([2, 3, 4])
    expect(ghostly.every((e) => e.usage === null && e.usageSource === 'missing' && e.status === 'error')).toBe(true)
    expect(events.filter((e) => e.type === 'generation.end' && e.usage)).toHaveLength(1)
    // seq 5: no usage object at all → a counted generation with missing usage, no numbers.
    const absent = events.find((e) => e.rawSeq === 5)
    expect(absent?.usage).toBeNull()
    expect(absent?.usageSource).toBe('missing')
    // seq 7: real tokens under a `<unknown>` model → keep the tokens, drop the model, flag it.
    const placeholderModel = events.find((e) => e.rawSeq === 7)
    expect(placeholderModel?.usage?.inputTokens).toBe(100)
    expect(placeholderModel?.model).toBeNull()
    expect(placeholderModel?.metadata?.model_placeholder).toBe('<unknown>')
  })

  it('subagent threads are marked so totals can exclude them (ccusage parity, +77%)', async () => {
    const sub = await eventsOf('subagent-thread.jsonl')
    expect(sub.every((e) => isSubagentThreadEvent(e))).toBe(true)
    expect(sub[0]?.type).toBe('subagent.start')
    expect(sub[0]?.metadata?.parent_thread_id).toBe('01JCACHEBBBBBBBBBBBBBBBBBB')
    const parent = await eventsOf('parent-thread.jsonl')
    expect(parent.some((e) => isSubagentThreadEvent(e))).toBe(false)
    expect(CODEX_AGGREGATION.subagentsIncluded).toBe(false)

    const child = await eventsOf('child-thread.jsonl')
    const parentEvents = await eventsOf('parent-thread.jsonl')
    const both = [...parentEvents, ...child]
    const withSubagents = aggregateUsage(both.filter((e) => e.usage))
    const without = aggregateUsage(both.filter((e) => e.usage && !isSubagentThreadEvent(e)))
    expect(withSubagents.usage.inputTokens).toBe(500 + 100)
    expect(without.usage.inputTokens).toBe(500)
  })
})
