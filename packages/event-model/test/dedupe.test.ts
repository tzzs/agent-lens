import { describe, expect, it } from 'vitest'
import {
  aggregateRequestTokens,
  aggregateUsage,
  dedupeByRequestId,
  DEFAULT_AGGREGATION,
  isSubagentThreadEvent,
  sumUsage,
  UnknownAggregationError,
  ZERO_USAGE,
} from '../src/dedupe.ts'
import { makeEvent, usage } from './helpers.ts'

describe('dedupeByRequestId', () => {
  it('collapses one API response split into 3 records repeating identical usage to one copy', () => {
    const shared = usage({ inputTokens: 1000, outputTokens: 250, cacheReadTokens: 8000 })
    const events = [
      makeEvent({ requestId: 'req-a', usage: shared }),
      makeEvent({ requestId: 'req-a', usage: { ...shared } }),
      makeEvent({ requestId: 'req-a', usage: { ...shared } }),
    ]
    const groups = dedupeByRequestId(events)
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect(group.requestId).toBe('req-a')
    expect(group.usage).toEqual(shared)
    expect(group.eventIds).toEqual(events.map((e) => e.id))
  })

  it('takes the element-wise MAX, not the first block (output_tokens is cumulative)', () => {
    const events = [
      makeEvent({ requestId: 'req-b', usage: usage({ inputTokens: 500, outputTokens: 10 }) }),
      makeEvent({ requestId: 'req-b', usage: usage({ inputTokens: 500, outputTokens: 35 }) }),
      makeEvent({ requestId: 'req-b', usage: usage({ inputTokens: 400, outputTokens: 20, cacheWriteTokens: 7 }) }),
    ]
    const group = dedupeByRequestId(events)[0]!
    expect(group.usage).toEqual(usage({ inputTokens: 500, outputTokens: 35, cacheWriteTokens: 7 }))
  })

  it('sums across different request_ids instead of merging them', () => {
    const agg = aggregateRequestTokens([
      makeEvent({ requestId: 'req-1', usage: usage({ inputTokens: 100, outputTokens: 10 }) }),
      makeEvent({ requestId: 'req-2', usage: usage({ inputTokens: 200, outputTokens: 20 }) }),
    ])
    expect(agg.deduped).toEqual(usage({ inputTokens: 300, outputTokens: 30 }))
    expect(agg.inflationRatio).toBe(1)
  })

  it('counts each null-requestId event exactly once', () => {
    const events = [
      makeEvent({ requestId: null, usage: usage({ inputTokens: 50 }) }),
      makeEvent({ requestId: undefined, usage: usage({ inputTokens: 70 }) }),
      makeEvent({ requestId: null, usage: usage({ inputTokens: 50 }) }),
    ]
    const groups = dedupeByRequestId(events)
    expect(groups).toHaveLength(3)
    expect(groups.every((g) => g.requestId === null)).toBe(true)
    const agg = aggregateRequestTokens(events)
    expect(agg.deduped.inputTokens).toBe(170)
    expect(agg.inflationRatio).toBe(1)
  })

  it('never mutates the usage objects it was given', () => {
    const first = usage({ inputTokens: 10, outputTokens: 5 })
    const second = usage({ inputTokens: 3, outputTokens: 9 })
    dedupeByRequestId([
      makeEvent({ requestId: 'req-m', usage: first }),
      makeEvent({ requestId: 'req-m', usage: second }),
    ])
    expect(first).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
    expect(second.outputTokens).toBe(9)
  })
})

describe('aggregateRequestTokens', () => {
  it('reports the inflation a naive per-event sum would have caused', () => {
    const shared = usage({ inputTokens: 100, outputTokens: 40 })
    const events = [
      makeEvent({ requestId: 'req-x', usage: { ...shared } }),
      makeEvent({ requestId: 'req-x', usage: { ...shared } }),
      makeEvent({ requestId: 'req-x', usage: { ...shared } }),
      makeEvent({ requestId: 'req-y', usage: usage({ inputTokens: 60, outputTokens: 10 }) }),
      makeEvent({ requestId: 'req-y', usage: usage({ inputTokens: 60, outputTokens: 10 }) }),
    ]
    const agg = aggregateRequestTokens(events)
    expect(agg.deduped).toEqual(usage({ inputTokens: 160, outputTokens: 50 }))
    expect(agg.naive).toEqual(usage({ inputTokens: 420, outputTokens: 140 }))
    expect(agg.inflationRatio).toBeCloseTo(560 / 210, 10)
  })

  it('ignores events without usage and returns ratio 1 for empty input', () => {
    const agg = aggregateRequestTokens([makeEvent({ requestId: 'req-z', usage: null })])
    expect(agg.deduped).toEqual(ZERO_USAGE)
    expect(agg.naive).toEqual(ZERO_USAGE)
    expect(agg.inflationRatio).toBe(1)
    expect(aggregateRequestTokens([]).inflationRatio).toBe(1)
  })
})

describe('sumUsage', () => {
  it('sums element-wise', () => {
    expect(
      sumUsage([
        usage({ inputTokens: 1, reasoningTokens: 2 }),
        usage({ inputTokens: 3, outputTokens: 4 }),
      ]),
    ).toEqual(usage({ inputTokens: 4, outputTokens: 4, reasoningTokens: 2 }))
  })
})

// §18 (measurement round two): the fold is declared per adapter, not a global invariant.
describe('aggregateUsage (§18 per-adapter policy)', () => {
  // Claude Code / Qoder shape: ONE response, three content-block records repeating the usage.
  const duplicated = [
    makeEvent({ requestId: 'p-1', usage: usage({ inputTokens: 100, outputTokens: 20 }) }),
    makeEvent({ requestId: 'p-1', usage: usage({ inputTokens: 100, outputTokens: 20 }) }),
    makeEvent({ requestId: 'p-1', usage: usage({ inputTokens: 100, outputTokens: 20 }) }),
  ]
  // Codex shape: three DISTINCT per-call usages, all logged under one response id.
  const perCall = [
    makeEvent({ requestId: 'c-1', usage: usage({ inputTokens: 10 }) }),
    makeEvent({ requestId: 'c-1', usage: usage({ inputTokens: 20 }) }),
    makeEvent({ requestId: 'c-1', usage: usage({ inputTokens: 30 }) }),
  ]

  it('request_max folds 3 identical rows to 1 while per_record_sum sums the same 3 to 3', () => {
    const folded = aggregateUsage(duplicated, { mode: 'request_max', subagentsIncluded: true })
    const summed = aggregateUsage(duplicated, { mode: 'per_record_sum', subagentsIncluded: true })
    // Asserted side by side on the SAME input: a future edit cannot silently swap the modes.
    expect(folded).toEqual({
      usage: usage({ inputTokens: 100, outputTokens: 20 }),
      groups: 1,
      mode: 'request_max',
    })
    expect(summed).toEqual({
      usage: usage({ inputTokens: 300, outputTokens: 60 }),
      groups: 3,
      mode: 'per_record_sum',
    })
    expect(summed.usage.inputTokens).toBe(folded.usage.inputTokens * 3)
  })

  it('per_record_sum keeps distinct per-call rows that request_max would drop', () => {
    expect(aggregateUsage(perCall, { mode: 'per_record_sum', subagentsIncluded: false }).usage).toEqual(
      usage({ inputTokens: 60 }),
    )
    // MAX-per-request on Codex rows silently LOSES two calls (60 -> 30): the §18 reason the
    // policy is per adapter instead of one global rule.
    expect(aggregateUsage(perCall, { mode: 'request_max', subagentsIncluded: false }).usage).toEqual(
      usage({ inputTokens: 30 }),
    )
  })

  it("last_call_sum is per_record_sum at this layer: a metadata-marked cumulative row is not re-added", () => {
    // The adapter's job was to map `total_token_usage` OUT of `usage`; the row keeps the
    // marker only. If a cumulative number ever reached `usage` here, the two modes would
    // diverge, so asserting they agree proves the boundary.
    const rows = [
      ...perCall,
      makeEvent({
        requestId: 'c-1',
        usage: usage({ inputTokens: 60 }),
        metadata: { cumulativeUsageField: 'total_token_usage', subagentThread: false },
      }),
    ]
    const lastCall = aggregateUsage(rows, { mode: 'last_call_sum', subagentsIncluded: false })
    const perRecord = aggregateUsage(rows, { mode: 'per_record_sum', subagentsIncluded: false })
    expect(lastCall).toEqual({ ...perRecord, mode: 'last_call_sum' })
    // 10+20+30+60: the marked row counts once, and nothing multiplies.
    expect(lastCall.usage.inputTokens).toBe(120)
    expect(lastCall.groups).toBe(4)
  })

  it('ignores usage-less events under every mode', () => {
    const rows = [makeEvent({ requestId: 'u-1', usage: null }), makeEvent({ usage: undefined })]
    for (const mode of ['request_max', 'per_record_sum', 'last_call_sum'] as const) {
      const res = aggregateUsage(rows, { mode, subagentsIncluded: true })
      expect(res).toEqual({ usage: ZERO_USAGE, groups: 0, mode })
    }
  })

  it('defaults to DEFAULT_AGGREGATION, which is request_max', () => {
    expect(DEFAULT_AGGREGATION).toEqual({ mode: 'request_max', subagentsIncluded: true })
    expect(aggregateUsage(duplicated)).toEqual(aggregateUsage(duplicated, DEFAULT_AGGREGATION))
  })

  it('throws UnknownAggregationError on an unknown mode instead of falling back', () => {
    const bogus = { mode: 'sum_everything', subagentsIncluded: true } as unknown as Parameters<
      typeof aggregateUsage
    >[1]
    expect(() => aggregateUsage(duplicated, bogus)).toThrow(UnknownAggregationError)
    expect(() => aggregateUsage(duplicated, bogus)).toThrow(/request_max/)
  })
})

describe('isSubagentThreadEvent', () => {
  it('reads the marker from an in-memory metadata object', () => {
    expect(isSubagentThreadEvent(makeEvent({ metadata: { subagentThread: true } }))).toBe(true)
    expect(isSubagentThreadEvent(makeEvent({ metadata: { subagentThread: false } }))).toBe(false)
    expect(isSubagentThreadEvent(makeEvent({ metadata: { other: true } }))).toBe(false)
    expect(isSubagentThreadEvent(makeEvent({ metadata: null }))).toBe(false)
    expect(isSubagentThreadEvent(makeEvent({}))).toBe(false)
  })

  it('reads the marker from SQLite\'s JSON text form', () => {
    const fromDb = makeEvent({ metadata: { subagentThread: true } })
    const asText = { ...fromDb, metadata: JSON.stringify({ subagentThread: true }) } as unknown as typeof fromDb
    expect(isSubagentThreadEvent(asText)).toBe(true)
    const notSub = { ...fromDb, metadata: '{"subagentThread":false}' } as unknown as typeof fromDb
    expect(isSubagentThreadEvent(notSub)).toBe(false)
    const broken = { ...fromDb, metadata: 'not json' } as unknown as typeof fromDb
    expect(isSubagentThreadEvent(broken)).toBe(false)
  })
})
