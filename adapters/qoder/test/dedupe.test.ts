/**
 * The request_max declaration (§18 row 2) and the fold behaviour it licenses,
 * exercised through the shared dedupe helpers so the adapter and the query
 * cube agree on one implementation.
 */
import { describe, expect, it } from 'vitest'
import { aggregateRequestTokens, dedupeByRequestId, deriveSourceId, type AgentEvent, type NormalizeCtx, type RawRecord } from '@agentlens/event-model'
import { QODER_AGGREGATION } from '../src/index.ts'
import { normalize } from '../src/normalize.ts'
import { ctxFor, readFixture, recordsFromJsonl } from './helpers.ts'

describe('aggregation policy', () => {
  it('declares request_max with subagents included', () => {
    expect(QODER_AGGREGATION).toEqual({ mode: 'request_max', subagentsIncluded: true })
  })
})

describe('request_max fold', () => {
  it('one usage per request_id ⇒ fold is the identity (measured Qoder shape)', async () => {
    const ctx = ctxFor('assistant-credits.jsonl')
    const records = recordsFromJsonl(await readFixture('assistant-credits.jsonl'))
    const events: AgentEvent[] = (await normalize(records[0]! as RawRecord, ctx as NormalizeCtx) as { events: AgentEvent[] }).events
    const withUsage = events.filter((e) => e.usage)
    const agg = aggregateRequestTokens(withUsage)
    expect(agg.deduped).toEqual(withUsage[0]!.usage)
    expect(agg.inflationRatio).toBe(1)
  })

  it('duplicated usage across blocks of one request folds to one copy (drift guard)', async () => {
    const ctx = ctxFor('assistant-credits.jsonl')
    const records = recordsFromJsonl(await readFixture('assistant-credits.jsonl'))
    const r = await normalize(records[0]! as RawRecord, ctx as NormalizeCtx)
    const gen = (r as { events: AgentEvent[] }).events.find((e) => e.type === 'generation.end')!
    // Future fork drift: the same response split across 3 records, each
    // repeating the usage object with the same request_id.
    const drift: AgentEvent[] = [gen, { ...gen, id: 'x2', rawSeq: 2 }, { ...gen, id: 'x3', rawSeq: 3 }]
    const agg = aggregateRequestTokens(drift)
    expect(agg.naive.inputTokens).toBe(gen.usage!.inputTokens * 3)
    expect(agg.deduped).toEqual(gen.usage)
    expect(dedupeByRequestId(drift)).toHaveLength(1)
    expect(agg.inflationRatio).toBeCloseTo(3)
  })

  it('events without request_id are each their own group — never dropped, never merged', () => {
    const a = { id: 'a', requestId: null, usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } as AgentEvent
    const b = { ...a, id: 'b' }
    const agg = aggregateRequestTokens([a, b])
    expect(agg.deduped.inputTokens).toBe(10)
    expect(dedupeByRequestId([a, b])).toHaveLength(2)
  })
})
