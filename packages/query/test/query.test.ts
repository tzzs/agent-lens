import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, Usage } from '@agentlens/event-model'
import { aggregateRequestTokens } from '@agentlens/event-model'
import { hexSeed } from './fixtures.ts'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import type { PriceEntry } from '@agentlens/pricing'
import { bucketTs, query, resolveSince, UnknownDimError, UnknownMetricError } from '@agentlens/query'

function seeded(events: AgentEvent[]): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  insertEvents(db, events)
  return db
}

const PRICE: PriceEntry = {
  provider: 'anthropic',
  model: 'test-model',
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  reasoningPerMTok: null,
  effectiveFrom: 0,
  source: 'manual',
}
const resolver = (provider: string, model: string): PriceEntry | null =>
  provider === 'anthropic' && model === 'test-model' ? PRICE : null

describe('§3.1 aggregation invariant', () => {
  // One API response split across several records repeating identical usage:
  // the naive per-event sum inflates (measured 1.87x). Both numbers are
  // asserted so a refactor cannot silently flip the cube back to SUM-over-events.
  const split = (requestId: string, usage: Usage, n: number): AgentEvent[] =>
    Array.from({ length: n }, (_, i) =>
      hexSeed({ requestId, usage, type: 'generation.end', sessionId: 's1' }, `${requestId}:${i}`),
    )

  it('token metrics equal the deduped MAX-per-request total, not the naive sum', () => {
    const usage: Usage = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 10, reasoningTokens: 5 }
    const events = [...split('r1', usage, 3), ...split('r2', usage, 2)]
    const db = seeded(events)
    const res = query(db, {
      metrics: ['tokens_total', 'tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write', 'tokens_reasoning'],
    })
    expect(res.totals).toEqual({
      tokens_total: (100 + 40 + 1000 + 10 + 5) * 2,
      tokens_input: 200,
      tokens_output: 80,
      tokens_cache_read: 2000,
      tokens_cache_write: 20,
      tokens_reasoning: 10,
    })
    // naive sum would be 5 identical duplicates of r1 + 2 of… assert the naive number:
    const agg = aggregateRequestTokens(events)
    expect(agg.naive.inputTokens).toBe(500) // 5 events x 100
    expect(agg.deduped.inputTokens).toBe(200)
    const naiveTotal = agg.naive.inputTokens + agg.naive.outputTokens + agg.naive.cacheReadTokens + agg.naive.cacheWriteTokens + agg.naive.reasoningTokens
    expect(res.totals.tokens_total).not.toBe(naiveTotal)
    expect(res.totals.tokens_total).toBe(1155 * 2)
  })

  it('NULL request_id rows are their own group of one, never merged together', () => {
    const usage: Usage = { inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const events = [
      hexSeed({ sessionId: 'sx', usage, requestId: null, type: 'generation.end' }, 'ga'),
      hexSeed({ sessionId: 'sx', usage, requestId: undefined, type: 'generation.end' }, 'gb'),
      hexSeed({ sessionId: 'sx', usage: null, type: 'message.user' }, 'm1'),
    ]
    const db = seeded(events)
    const res = query(db, { metrics: ['tokens_input', 'events'] })
    expect(res.totals.tokens_input).toBe(14) // each counted exactly once
    expect(res.totals.events).toBe(3)
  })
})

describe('non-token metrics', () => {
  const events = [
    hexSeed({ sessionId: 's1', type: 'session.start', durationMs: 10 }, 'e1'),
    hexSeed({ sessionId: 's1', type: 'tool.end', durationMs: 25, capability: { type: 'tool', name: 'Bash' } }, 'e2'),
    hexSeed({ sessionId: 's2', type: 'message.user' }, 'e3'),
  ]
  it('events / sessions / duration', () => {
    const db = seeded(events)
    const res = query(db, { metrics: ['events', 'sessions', 'duration'] })
    expect(res.totals).toEqual({ events: 3, sessions: 2, duration: 35 })
  })
})

describe('dims', () => {
  const mk = (): AgentEvent[] => [
    hexSeed({ sessionId: 's1', projectId: 'p1', agentId: 'claude-code', hostId: 'claude-code', model: { provider: 'anthropic', name: 'test-model' }, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requestId: 'r1' }, 'a1'),
    hexSeed({ sessionId: 's1', projectId: 'p1', agentId: 'claude-code', hostId: 'claude-desktop', model: { provider: 'anthropic', name: 'test-model' }, usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requestId: 'r2' }, 'a2'),
    hexSeed({ sessionId: 's2', projectId: 'p2', agentId: 'codex', hostId: 'codex', model: { provider: 'openai', name: 'gpt-test' }, usage: { inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requestId: 'r3' }, 'a3'),
    hexSeed({ sessionId: 's2', projectId: 'p2', agentId: 'codex', hostId: 'codex', type: 'hook.fire', capability: { type: 'hook', name: 'PreToolUse:Bash' } }, 'a4'),
  ]

  it('host dim (measurement-added)', () => {
    const db = seeded(mk())
    const res = query(db, { metrics: ['tokens_input'], dims: ['host'] })
    const map = Object.fromEntries(res.rows.map((r) => [r.host as string, r.tokens_input as number]))
    expect(map).toEqual({ 'claude-code': 10, 'claude-desktop': 20, codex: 30 })
  })

  it('hook dim (measurement-added): only hook events carry a name', () => {
    const db = seeded(mk())
    const res = query(db, { metrics: ['events'], dims: ['hook'], order: 'dim:hook:asc' })
    expect(res.rows.map((r) => r.hook)).toEqual(['', 'PreToolUse:Bash'])
  })

  it('model dim groups tokens via the models join', () => {
    const db = seeded(mk())
    const res = query(db, { metrics: ['tokens_input', 'tokens_output'], dims: ['model'] })
    const map = Object.fromEntries(res.rows.map((r) => [r.model as string, r.tokens_input as number]))
    expect(map).toEqual({ 'test-model': 30, 'gpt-test': 30, '': 0 }) // '' bucket = events with no model (the hook fire)
  })

  it('two-dim combo project x agent', () => {
    const db = seeded(mk())
    const res = query(db, { metrics: ['events', 'tokens_input'], dims: ['project', 'agent'] })
    const keys = res.rows.map((r) => `${r.project}/${r.agent}:${r.tokens_input}`).sort()
    expect(keys).toEqual(['p1/claude-code:30', 'p2/codex:30'])
  })

  it('day dim buckets by UTC date and matches bucketTs', () => {
    const t = Date.UTC(2026, 8, 15, 13, 0)
    const db = seeded([hexSeed({ timestamp: t, sessionId: 'sd' }, 'd1')])
    const res = query(db, { metrics: ['events'], dims: ['day'] })
    expect(res.rows[0]?.day).toBe('2026-09-15')
    expect(bucketTs(t, 'day')).toBe(Date.UTC(2026, 8, 15))
    expect(bucketTs(t, 'week')).toBe(Date.UTC(2026, 8, 14)) // Monday
    expect(bucketTs(t, 'month')).toBe(Date.UTC(2026, 8, 1))
  })
})

describe('filters', () => {
  const mk = (): AgentEvent[] => [
    hexSeed({ sessionId: 's1', agentId: 'a', status: 'ok', timestamp: Date.UTC(2026, 8, 10), requestId: 'r1', usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }, 'f1'),
    hexSeed({ sessionId: 's2', agentId: 'b', status: 'error', timestamp: Date.UTC(2026, 8, 20) }, 'f2'),
  ]

  it('since/until/agent/status', () => {
    const db = seeded(mk())
    expect(query(db, { filter: { since: Date.UTC(2026, 8, 15) } }).totals.events).toBe(1)
    expect(query(db, { filter: { until: Date.UTC(2026, 8, 15) } }).totals.events).toBe(1)
    expect(query(db, { filter: { agent: ['a'] } }).totals.events).toBe(1)
    expect(query(db, { filter: { agent: ['a', 'b'] } }).totals.events).toBe(2)
    expect(query(db, { filter: { status: ['error'] }, metrics: ['tokens_input'] }).totals.tokens_input).toBe(0)
  })

  it('resolveSince forms', () => {
    const now = Date.UTC(2026, 8, 21, 12)
    expect(resolveSince('7d', now)).toBe(now - 7 * 86_400_000)
    expect(resolveSince('24h', now)).toBe(now - 86_400_000)
    expect(resolveSince('30m', now)).toBe(now - 1_800_000)
    expect(resolveSince('2026-09-01', now)).toBe(Date.UTC(2026, 8, 1))
    expect(resolveSince('20260901', now)).toBe(Date.UTC(2026, 8, 1))
    expect(() => resolveSince('last tuesday')).toThrow()
  })

  it('SQL-injection-shaped filter values are parameterised, not interpolated', () => {
    const db = seeded(mk())
    const res = query(db, { filter: { agent: ["' OR 1=1--"] } , metrics: ['events'] })
    expect(res.totals.events).toBe(0)
    expect(res.rows).toEqual([])
    const res2 = query(db, { filter: { status: ["x'); DROP TABLE events;--"] }, metrics: ['events'] })
    expect(res2.totals.events).toBe(0)
    // table still there:
    expect(query(db, { metrics: ['events'] }).totals.events).toBe(2)
  })
})

describe('order / limit / truncated', () => {
  const mk = (): AgentEvent[] =>
    [100, 300, 200].map((v, i) =>
      hexSeed(
        {
          sessionId: `s${i}`,
          projectId: `p${i}`,
          requestId: `rq${i}`,
          usage: { inputTokens: v, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        },
        `o${i}`,
      ),
    )

  it('metric desc + limit truncates', () => {
    const db = seeded(mk())
    const res = query(db, { metrics: ['tokens_input'], dims: ['project'], order: 'metric:tokens_input:desc', limit: 2 })
    expect(res.rows.map((r) => r.tokens_input)).toEqual([300, 200])
    expect(res.truncated).toBe(true)
    expect(res.totals.tokens_input).toBe(600) // totals ignore limit
  })

  it('dim asc orders by dim value', () => {
    const db = seeded(mk())
    const res = query(db, { metrics: ['tokens_input'], dims: ['project'], order: 'dim:project:asc' })
    expect(res.rows.map((r) => r.project)).toEqual(['p0', 'p1', 'p2'])
    expect(res.truncated).toBe(false)
  })
})

describe('whitelist validation', () => {
  const db = seeded([hexSeed({}, 'w1')])
  it('unknown metric throws UnknownMetricError', () => {
    expect(() => query(db, { metrics: ['tokens_gold' as never] })).toThrow(UnknownMetricError)
  })
  it('unknown dim throws UnknownDimError', () => {
    expect(() => query(db, { dims: ['moon' as never] })).toThrow(UnknownDimError)
  })
})

describe('cost via injected priceResolver', () => {
  const usage: Usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  const events = [
    hexSeed({ requestId: 'cr1', usage, model: { provider: 'anthropic', name: 'test-model' }, timestamp: Date.UTC(2026, 8, 10) }, 'c1'),
    hexSeed({ requestId: 'cr1', usage, model: { provider: 'anthropic', name: 'test-model' }, timestamp: Date.UTC(2026, 8, 10) }, 'c2'), // duplicate block, same usage
    hexSeed({ requestId: 'cr2', usage, model: { provider: 'anthropic', name: 'unpriced-model' }, timestamp: Date.UTC(2026, 8, 11) }, 'c3'),
  ]

  it('cost derives from deduped tokens per (model, date); gaps dominate as null', () => {
    const db = seeded(events)
    const res = query(db, { metrics: ['cost_api_equiv'], dims: ['model'] }, { priceResolver: resolver })
    const byModel = Object.fromEntries(res.rows.map((r) => [r.model as string, r.cost_api_equiv]))
    expect(byModel['test-model']).toBe(3) // 1M input x $3/M, deduped once despite 2 events
    expect(byModel['unpriced-model']).toBeNull()
    expect(res.totals.cost_api_equiv).toBeNull() // null dominates, never $0 (§8)
  })

  it('billingModeFor: subscription reports $0 real, but api-equivalent keeps value in its own bucket only', () => {
    const db = seeded([hexSeed({ requestId: 'sub1', usage, model: { provider: 'anthropic', name: 'test-model' }, agentId: 'claude-sub' }, 'sub1')])
    const res = query(db, {
      metrics: ['cost_api_equiv'],
      dims: ['agent'],
    }, { priceResolver: resolver, billingModeFor: (a) => (a === 'claude-sub' ? 'subscription' : 'api') })
    // cost_api_equiv is the API-equivalent value; subscription mode's actualUsd ($0) is not a cube metric.
    expect(res.rows[0]?.cost_api_equiv).toBe(3)
  })
})
