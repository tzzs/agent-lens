import { describe, expect, it } from 'vitest'
import {
  aggregateRequestTokens,
  dedupeByRequestId,
  sumUsage,
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
