import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, AggregationPolicy, Usage } from '@agentlens/event-model'
import { aggregateRequestTokens, aggregateUsage, UnknownAggregationError } from '@agentlens/event-model'
import { hexSeed } from './fixtures.ts'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import type { PriceEntry } from '@agentlens/pricing'
import { bucketTs, costFloor, costPortionsByAgent, query, resolveSince, UnknownDimError, UnknownMetricError, type QuerySpec } from '@agentlens/query'

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

describe('totals: false (§7, the per-request cost of the grand-total fold)', () => {
  const db = (): DatabaseSync =>
    seeded(
      [100, 300, 200].map((v, i) =>
        hexSeed(
          {
            sessionId: `s${i}`,
            projectId: `p${i}`,
            requestId: `rq${i}`,
            usage: { inputTokens: v, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
          `t${i}`,
        ),
      ),
    )

  it('drops only `totals`; rows, order and truncated stay byte-identical', () => {
    const spec: QuerySpec = { metrics: ['tokens_input'], dims: ['project'], order: 'metric:tokens_input:desc', limit: 2 }
    const withTotals = query(db(), spec)
    const without = query(db(), { ...spec, totals: false })
    expect(without.rows).toEqual(withTotals.rows)
    expect(without.truncated).toBe(withTotals.truncated)
    expect(without.columns).toEqual(withTotals.columns)
    // Empty, not zero-filled: an omitted total must never read as a measured 0 (§5.2).
    expect(without.totals).toEqual({})
    expect(withTotals.totals.tokens_input).toBe(600)
  })

  it('defaults to computing totals, so an omitted flag changes nothing', () => {
    const a = query(db(), { metrics: ['tokens_input'], dims: ['project'] })
    const b = query(db(), { metrics: ['tokens_input'], dims: ['project'], totals: true })
    expect(b.totals).toEqual(a.totals)
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

describe('costPortionsByAgent — the priced half of a window a gap NULLs (§8/§14)', () => {
  const usage: Usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  const db = seeded([
    hexSeed({ agentId: 'a1', requestId: 'p1', usage, model: { provider: 'anthropic', name: 'test-model' } }, 'p1'),
    hexSeed({ agentId: 'a1', requestId: 'p2', usage, model: { provider: 'anthropic', name: 'unpriced-model' } }, 'p2'),
    hexSeed({ agentId: 'a2', requestId: 'p3', usage, model: { provider: 'anthropic', name: 'unpriced-model' } }, 'p3'),
  ])

  it('sums what prices out, per agent, and invents nothing where nothing prices', () => {
    const portions = costPortionsByAgent(db, {}, { priceResolver: resolver })
    // a1's window is half priced: the gap drops out of the floor, the $3 does not.
    expect(portions.get('a1')).toEqual({ api: 3, total: 3 })
    expect(portions.get('a2'), 'an agent with no priced slice has no floor').toEqual({ api: null, total: null })
    // The complete answer stays NULL at agent grain — this map is a floor, not a relaxed §18 row 1.
    expect(query(db, { metrics: ['cost_api_equiv'], dims: ['agent'] }, { priceResolver: resolver }).rows).toEqual([
      { agent: 'a1', cost_api_equiv: null },
      { agent: 'a2', cost_api_equiv: null },
    ])
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

// §18 row 2: the fold is declared per adapter and applied by the cube — the caller of
// query() never chooses a dedupe rule.
describe('§18 per-agent aggregation policy', () => {
  const u = (inputTokens: number, outputTokens = 0): Usage => ({
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  })
  // Claude Code / Qoder: one response split per content block, usage repeated.
  const claudeRows = (): AgentEvent[] =>
    [0, 1, 2].map((i) => hexSeed({ agentId: 'claude-code', sessionId: 's-cc', requestId: 'cc-1', usage: u(100, 10) }, `cc${i}`))
  // Codex: three distinct per-call usage rows for the same response, no duplication.
  const codexRows = (): AgentEvent[] =>
    [10, 20, 30].map((v, i) => hexSeed({ agentId: 'codex', sessionId: 's-cx', requestId: 'cd-1', usage: u(v) }, `cx${i}`))

  const POLICIES: Record<string, AggregationPolicy> = {
    'claude-code': { mode: 'request_max', subagentsIncluded: true },
    codex: { mode: 'last_call_sum', subagentsIncluded: false },
  }

  const byAgent = (aggregation?: Record<string, AggregationPolicy>) => {
    const events = [...claudeRows(), ...codexRows()]
    const db = seeded(events)
    const res = query(db, { metrics: ['tokens_input'], dims: ['agent'] }, { aggregation })
    const map = Object.fromEntries(res.rows.map((r) => [r.agent as string, r.tokens_input as number]))
    return { map, res, events }
  }

  it('gives each agent its own correct total under its declared policy', () => {
    const { map, res, events } = byAgent(POLICIES)
    expect(map).toEqual({ 'claude-code': 100, codex: 60 })
    expect(res.totals.tokens_input).toBe(160)
    // The SQL cube and the in-memory reference implementation must agree per agent.
    for (const [agentId, policy] of Object.entries(POLICIES)) {
      const rows = events.filter((e) => e.agentId === agentId)
      expect(aggregateUsage(rows, policy).usage.inputTokens).toBe(map[agentId])
    }
  })

  // Documents the failure mode the per-agent routing exists to prevent: either global
  // policy is wrong for one of the two agents, and "wrong" goes in BOTH directions.
  it('one global request_max silently drops codex per-call rows', () => {
    const { map } = byAgent({
      'claude-code': { mode: 'request_max', subagentsIncluded: true },
      codex: { mode: 'request_max', subagentsIncluded: true },
    })
    expect(map).toEqual({ 'claude-code': 100, codex: 30 }) // 60 lost, not an inflation
  })

  it('one global per_record_sum re-inflates claude duplicated rows', () => {
    const { map } = byAgent({
      'claude-code': { mode: 'per_record_sum', subagentsIncluded: true },
      codex: { mode: 'per_record_sum', subagentsIncluded: true },
    })
    expect(map).toEqual({ 'claude-code': 300, codex: 60 }) // the 1.87x-class bug, exactly 3x here
  })

  it('a missing policy entry falls back to DEFAULT_AGGREGATION (request_max)', () => {
    const { map, res } = byAgent(undefined)
    expect(map).toEqual({ 'claude-code': 100, codex: 30 }) // conservative, but still the fallback fold
    expect(res.totals.tokens_input).toBe(130)
    // Partial map: only codex declared, claude-code still folded by the default.
    expect(byAgent({ codex: { mode: 'per_record_sum', subagentsIncluded: false } }).map).toEqual({
      'claude-code': 100,
      codex: 60,
    })
  })

  it('folding is grouped per agent, so a shared request_id across agents never merges', () => {
    const events = [
      hexSeed({ agentId: 'a1', requestId: 'shared', usage: u(5) }, 'sh1'),
      hexSeed({ agentId: 'a2', requestId: 'shared', usage: u(7) }, 'sh2'),
    ]
    const res = query(seeded(events), { metrics: ['tokens_input'], dims: ['agent'] })
    expect(Object.fromEntries(res.rows.map((r) => [r.agent as string, r.tokens_input as number]))).toEqual({
      a1: 5,
      a2: 7,
    })
    expect(res.totals.tokens_input).toBe(12)
  })

  it('an unknown mode throws through the cube, never falls back', () => {
    const db = seeded(codexRows())
    expect(() =>
      query(db, { metrics: ['tokens_input'] }, {
        aggregation: { codex: { mode: 'sum_all' as never, subagentsIncluded: false } },
      }),
    ).toThrow(UnknownAggregationError)
  })

  it('agent dim routing keeps host/hook dims working unchanged', () => {
    const events = [
      ...claudeRows().slice(0, 1),
      hexSeed({ agentId: 'codex', hostId: 'codex', type: 'hook.fire', capability: { type: 'hook', name: 'PreToolUse:Bash' } }, 'cxhook'),
    ]
    const res = query(seeded(events), { metrics: ['events'], dims: ['host', 'hook'], filter: { agent: ['codex'] }, order: 'dim:host:asc' })
    expect(res.rows.map((r) => `${r.host}/${r.hook}:${r.events}`)).toEqual(['codex/PreToolUse:Bash:1'])
    const all = query(seeded(events), { metrics: ['events'], dims: ['hook'], order: 'dim:hook:asc' })
    expect(all.rows.map((r) => `${r.hook}:${r.events}`)).toEqual([':1', 'PreToolUse:Bash:1'])
  })
})

describe('§18 includeSubagentThreads filter', () => {
  const u = (inputTokens: number): Usage => ({
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  })
  const sub = { subagentThread: true }
  const events = (): AgentEvent[] => [
    // Same request as the parent row, but bigger: if the filter ran AFTER folding the
    // subagent's MAX would still set the ceiling, so 100 below can only mean pre-fold.
    hexSeed({ requestId: 'r-sub', sessionId: 's-sub', usage: u(100) }, 'sp1'),
    hexSeed({ requestId: 'r-sub', sessionId: 's-sub', usage: u(500), metadata: sub }, 'sp2'),
    hexSeed({ requestId: 'r-plain', sessionId: 's-sub', usage: u(5), metadata: { subagentThread: false } }, 'sp3'),
  ]

  it('default true keeps today\'s numbers byte-identical', () => {
    const db = seeded(events())
    const def = query(db, { metrics: ['tokens_input', 'events'] })
    expect(def.totals).toEqual({ tokens_input: 505, events: 3 })
    expect(query(db, { metrics: ['tokens_input', 'events'], filter: {} }).totals).toEqual(def.totals)
    expect(query(db, { metrics: ['tokens_input'], filter: { includeSubagentThreads: true } }).totals.tokens_input).toBe(505)
  })

  it('false drops exactly the flagged rows, before folding', () => {
    const db = seeded(events())
    const res = query(db, { metrics: ['tokens_input', 'events'], filter: { includeSubagentThreads: false } })
    expect(res.totals).toEqual({ tokens_input: 105, events: 2 }) // 100 + 5, one row dropped
    const perThread = query(db, { metrics: ['tokens_input'], dims: ['session'], filter: { includeSubagentThreads: false } })
    expect(perThread.rows).toHaveLength(1)
    expect(perThread.rows[0]?.tokens_input).toBe(105)
    // headline total changed: 505 -> 105
    expect(res.totals.tokens_input).toBeLessThan(505)
  })
})

describe('§18 thread dim', () => {
  const u = (inputTokens: number): Usage => ({
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  })
  const events = [
    hexSeed({ threadId: 't1', requestId: 'tr1', usage: u(10) }, 'th1'),
    hexSeed({ threadId: 't1', requestId: 'tr2', usage: u(20) }, 'th2'),
    hexSeed({ threadId: 't2', requestId: 'tr3', usage: u(30) }, 'th3'),
    hexSeed({ threadId: null, usage: u(40) }, 'th4'),
  ]

  it('groups events by thread_id, with nulls in their own bucket', () => {
    const res = query(seeded(events), { metrics: ['tokens_input', 'events'], dims: ['thread'], order: 'dim:thread:asc' })
    expect(res.rows.map((r) => `${r.thread}:${r.tokens_input}/${r.events}`)).toEqual([':40/1', 't1:30/2', 't2:30/1'])
    expect(res.totals.tokens_input).toBe(100)
    expect(res.columns).toContain('thread')
  })
})

describe('§18 cost_reported metric', () => {
  const usage = (inputTokens: number): Usage => ({
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  })
  const PRICE_ROW = { provider: 'anthropic', name: 'test-model' }

  it('sums raw reported rows, outside the dedupe path', () => {
    const events = [
      // One request split in two: tokens fold to ONE group, reported cost stays per row.
      hexSeed({ requestId: 'cost-1', usage: usage(1000), costReported: 0.4, costSource: 'reported', model: PRICE_ROW }, 'rp1'),
      hexSeed({ requestId: 'cost-1', usage: usage(1000), costReported: 0.4, costSource: 'reported', model: PRICE_ROW }, 'rp2'),
      hexSeed({ requestId: 'cost-2', usage: usage(10), model: PRICE_ROW }, 'rp3'), // reported nothing
    ]
    const res = query(seeded(events), { metrics: ['cost_reported', 'tokens_input', 'events'] })
    expect(res.totals.cost_reported).toBeCloseTo(0.8, 10)
    expect(res.totals.tokens_input).toBe(1010) // folded: cost-1 counted once
    expect(res.totals.events).toBe(3)
  })

  it('stays NULL when no row reported a cost, never 0', () => {
    const db = seeded([hexSeed({ requestId: 'n1', usage: usage(10) }, 'nr1'), hexSeed({ requestId: 'n2' }, 'nr2')])
    const res = query(db, { metrics: ['cost_reported'] })
    expect(res.totals.cost_reported).toBeNull()
    const dimmed = query(db, { metrics: ['cost_reported'], dims: ['session'] })
    expect(dimmed.rows.every((r) => r.cost_reported === null)).toBe(true)
    const empty = query(seeded([]), { metrics: ['cost_reported'] })
    expect(empty.totals.cost_reported).toBeNull()
  })

  it('is a separate metric from cost_api_equiv and is never added into it', () => {
    const events = [
      // priced usage -> computed estimate; reported cost is a different number entirely.
      hexSeed({ requestId: 'sep1', usage: usage(1_000_000), costReported: 0.25, costSource: 'reported', model: PRICE_ROW }, 'sep1'),
      // zero tokens, only a reported cost: the computed metric must not pick it up.
      hexSeed({ requestId: 'sep2', usage: null, costReported: 0.5, costSource: 'reported', model: PRICE_ROW }, 'sep2'),
    ]
    const res = query(seeded(events), { metrics: ['cost_reported', 'cost_api_equiv'] }, { priceResolver: resolver })
    expect(res.totals.cost_reported).toBeCloseTo(0.75, 10)
    expect(res.totals.cost_api_equiv).toBe(3) // 1M input x $3/M, no 0.25/0.5 folded in
    expect(res.columns).toEqual(['cost_reported', 'cost_api_equiv'])
    // Per row the same separation holds: a reported-only row keeps its cost out of the estimate.
    const dimmed = query(
      seeded([hexSeed({ requestId: 'sep2', usage: null, costReported: 0.5, costSource: 'reported', model: PRICE_ROW, sessionId: 'only-reported' }, 'sep2')]),
      { metrics: ['cost_reported', 'cost_api_equiv'], dims: ['session'] },
      { priceResolver: resolver },
    )
    expect(dimmed.rows[0]?.cost_reported).toBeCloseTo(0.5, 10)
    expect(dimmed.rows[0]?.cost_api_equiv).toBeNull() // zero tokens: nothing priced, and 0.5 did not leak in
  })
})

describe('§18 row 1 fused cost_total metric', () => {
  const usage = (inputTokens: number): Usage => ({
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  })
  const PRICE_ROW = { provider: 'anthropic', name: 'test-model' }
  const UNPRICED = { provider: 'anthropic', name: 'no-such-model' }
  const reported = (v: number) => ({ costReported: v, costSource: 'reported' as const })

  // One OpenCode-shaped event: its reported cost and its tokens describe the SAME work.
  // A caller must never have to pick a metric and risk adding 3 + 0.25 for it (§18 row 1).
  it('reported cost wins per request; only the never-reported part is priced from tokens', () => {
    const events = [
      hexSeed({ requestId: 'fuse-1', usage: usage(1_000_000), ...reported(0.25), model: PRICE_ROW }, 'fu1'),
      // Duplicate row of the SAME request reporting the same number: folded once under request_max.
      hexSeed({ requestId: 'fuse-1', usage: usage(1_000_000), ...reported(0.25), model: PRICE_ROW }, 'fu1b'),
      // Reported nothing: this is the only slice the price table may charge for.
      hexSeed({ requestId: 'fuse-2', usage: usage(1_000_000), model: PRICE_ROW }, 'fu2'),
    ]
    const res = query(
      seeded(events),
      { metrics: ['cost_total', 'cost_reported', 'cost_api_equiv'] },
      { priceResolver: resolver },
    )
    expect(res.totals.cost_total).toBeCloseTo(3.25, 10) // 0.25 reported + 3.00 priced; not 3.50, not 0.50
    expect(res.totals.cost_reported).toBeCloseTo(0.5, 10) // raw SUM: today's semantics, untouched
    expect(res.totals.cost_api_equiv).toBeCloseTo(6, 10) // prices every token, untouched
    expect(res.columns).toEqual(['cost_total', 'cost_reported', 'cost_api_equiv'])
  })

  it('honours the agent-declared stage-1 policy: per_record_sum counts every reported row', () => {
    const events = [
      hexSeed({ agentId: 'opencode', requestId: 'dup', usage: usage(10), ...reported(0.4), model: PRICE_ROW }, 'oc1'),
      hexSeed({ agentId: 'opencode', requestId: 'dup', usage: usage(20), ...reported(0.4), model: PRICE_ROW }, 'oc2'),
    ]
    const res = query(seeded(events), { metrics: ['cost_total'] }, {
      priceResolver: resolver,
      aggregation: { opencode: { mode: 'per_record_sum', subagentsIncluded: false } },
    })
    expect(res.totals.cost_total).toBeCloseTo(0.8, 10) // each per-call row is its own group
    const folded = query(seeded(events), { metrics: ['cost_total'] }, { priceResolver: resolver })
    expect(folded.totals.cost_total).toBeCloseTo(0.4, 10) // request_max (the fallback) folds the dup once
  })

  it('NULL when a group has neither a report nor priced tokens — never 0 (§8)', () => {
    const db = seeded([hexSeed({ requestId: 'nz', sessionId: 'no-cost', usage: null }, 'nz1')])
    expect(query(db, { metrics: ['cost_total'] }).totals.cost_total).toBeNull()
    const dimmed = query(db, { metrics: ['cost_total'], dims: ['session'] })
    expect(dimmed.rows[0]?.cost_total).toBeNull()
    expect(query(seeded([]), { metrics: ['cost_total'] }).totals.cost_total).toBeNull()
  })

  it('an unpriced never-reported slice keeps the fused figure NULL, even beside a reported one', () => {
    const events = [
      hexSeed({ requestId: 'up1', sessionId: 'mixed', usage: usage(10), ...reported(0.25), model: PRICE_ROW }, 'upr'),
      hexSeed({ requestId: 'up2', sessionId: 'mixed', usage: usage(10), model: UNPRICED }, 'upn'),
    ]
    const res = query(seeded(events), { metrics: ['cost_total'], dims: ['session'] }, { priceResolver: resolver })
    expect(res.rows[0]?.cost_total).toBeNull() // 0.25 + unknown is unknown, not a floor
    expect(res.totals.cost_total).toBeNull()
    const alone = query(seeded([events[0]!]), { metrics: ['cost_total'] }, { priceResolver: resolver })
    expect(alone.totals.cost_total).toBeCloseTo(0.25, 10) // reported-only still fuses
  })

  it('no price table: reported part still fuses; an unreported token slice forces NULL, not silence', () => {
    const rep = hexSeed({ requestId: 'np1', usage: usage(10), ...reported(0.5), model: PRICE_ROW }, 'np1')
    const unreported = hexSeed({ requestId: 'np2', sessionId: 'np', usage: usage(10), model: PRICE_ROW }, 'np2')
    expect(query(seeded([rep]), { metrics: ['cost_total'] }).totals.cost_total).toBeCloseTo(0.5, 10)
    expect(query(seeded([rep, unreported]), { metrics: ['cost_total'] }).totals.cost_total).toBeNull()
  })

  it('groups per dim and totals coherently', () => {
    const events = [
      hexSeed({ agentId: 'a1', requestId: 'g1', usage: usage(1_000_000), ...reported(0.25), model: PRICE_ROW }, 'g1'),
      hexSeed({ agentId: 'a2', requestId: 'g2', usage: usage(1_000_000), model: PRICE_ROW }, 'g2'),
    ]
    const res = query(seeded(events), { metrics: ['cost_total'], dims: ['agent'] }, { priceResolver: resolver })
    expect(Object.fromEntries(res.rows.map((r) => [r.agent, r.cost_total]))).toMatchObject({ a1: 0.25, a2: 3 })
    expect(res.totals.cost_total).toBeCloseTo(3.25, 10)
  })

  it('the §18 row 3 subagent switch drops a flagged row reported cost before folding', () => {
    const events = [
      hexSeed({ requestId: 'sa1', usage: usage(10), ...reported(0.25), model: PRICE_ROW }, 'sa1'),
      hexSeed({ requestId: 'sa2', usage: usage(10), ...reported(0.5), model: PRICE_ROW, metadata: { subagentThread: true } }, 'sa2'),
    ]
    const both = query(seeded(events), { metrics: ['cost_total'] }, { priceResolver: resolver })
    expect(both.totals.cost_total).toBeCloseTo(0.75, 10)
    const ex = query(seeded(events), { metrics: ['cost_total'], filter: { includeSubagentThreads: false } }, { priceResolver: resolver })
    expect(ex.totals.cost_total).toBeCloseTo(0.25, 10)
  })

  it('§8 keeps 实际花费 and 等价 API 价值 apart per declared billing mode', () => {
    const events = [
      hexSeed({ agentId: 'api-agent', requestId: 'bm1', usage: usage(1_000_000), model: PRICE_ROW }, 'bm1'),
      hexSeed({ agentId: 'sub-agent', requestId: 'bm2', usage: usage(1_000_000), model: PRICE_ROW }, 'bm2'),
      hexSeed({ agentId: 'local-agent', requestId: 'bm3', usage: usage(1_000_000), model: PRICE_ROW }, 'bm3'),
    ]
    const deps = {
      priceResolver: resolver,
      billingModeFor: (agent: string) =>
        agent === 'sub-agent' ? ('subscription' as const) : agent === 'local-agent' ? ('local' as const) : ('api' as const),
    }
    const res = query(seeded(events), { metrics: ['cost_total', 'cost_api_equiv'], dims: ['agent'] }, deps)
    const byAgent = new Map(res.rows.map((r) => [String(r.agent), r]))
    expect(byAgent.get('api-agent')?.cost_total).toBe(3)
    // A subscription's cash flow is the plan fee and a local model costs nothing per token,
    // so both read $0 here — which is exactly why the other column exists (§8).
    expect(byAgent.get('sub-agent')?.cost_total).toBe(0)
    expect(byAgent.get('local-agent')?.cost_total).toBe(0)
    expect(byAgent.get('sub-agent')?.cost_api_equiv).toBe(3)
    expect(byAgent.get('local-agent')?.cost_api_equiv).toBe(3)
    expect(res.totals.cost_total).toBe(3)
    expect(res.totals.cost_api_equiv).toBe(9)
  })
})

/** §8/§14: the floor under a NULL fused total, shared by both surfaces. */
describe('costFloor (§8)', () => {
  it('leaves a complete answer untouched', () => {
    expect(costFloor(1.25, 0.4)).toBe(1.25)
    expect(costFloor(0, 5)).toBe(0) // a real $0 (subscription/local) is not "unknown"
  })

  it('falls back to the money the agents reported when a slice had no price', () => {
    expect(costFloor(null, 0.42)).toBe(0.42)
  })

  it('stays null when nothing at all is known, so n/a survives n/a', () => {
    expect(costFloor(null, null)).toBeNull()
  })
})
