/**
 * The fold cache must be a pure optimisation.
 *
 * `query()` has two read paths for stage 2: the inline `req` CTE joined back to `events` for
 * the representative row, and a materialised temp table that already carries those columns.
 * Both compute the same §18 fold, and the entire point of the cache is that no caller can
 * tell which one ran — so this compares them row-for-row over the whole dim × metric × filter
 * matrix instead of trusting that they were written to match.
 *
 * Each case also asserts the cache actually materialised something. Without that, a bug that
 * quietly makes the cached path fall through to the inline one would make every assertion
 * below pass vacuously.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import type { PriceEntry } from '@agentlens/pricing'
import { createFoldCache, query, DIMS, METRICS, type QueryDeps, type QuerySpec } from '@agentlens/query'
import { hexSeed } from './fixtures.ts'

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

function seeded(): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  const day = 86_400_000
  const t0 = 1_750_000_000_000 - 3 * day
  const events: AgentEvent[] = []
  // Four agents, two of them declaring a non-default §18 fold, so the CASE arms of the stage-1
  // key are exercised rather than only its default.
  const agents = ['claude-code', 'qoder', 'codex', 'opencode']
  agents.forEach((agentId, ai) => {
    for (let d = 0; d < 4; d++) {
      const timestamp = t0 + d * day + ai * 1000
      // One API response split over three records repeating the same usage: the MAX-per-request
      // fold is the whole reason stage 1 exists, so the fixture has to contain it.
      for (let b = 0; b < 3; b++) {
        events.push(
          hexSeed(
            {
              agentId,
              hostId: `h${ai % 2}`,
              projectId: `proj-${ai}`,
              sessionId: `sess-${ai}-${d}`,
              threadId: ai === 2 ? `thread-${d}` : null,
              requestId: `req-${ai}-${d}`,
              timestamp,
              type: 'generation.end',
              // qoder's second day is an UNPRICED model, so the §18 row 1 fusion has to
              // produce its NULL-not-zero answer for a never-reported, unpriceable slice.
              model:
                ai === 1 && d === 1
                  ? { provider: 'anthropic', name: 'unpriced-model' }
                  : { provider: 'anthropic', name: 'test-model' },
              usage: { inputTokens: 100 + b, outputTokens: 20 + b, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 0 },
              durationMs: 500 + b,
              usageSource: 'reported',
              status: d === 3 && b === 2 ? 'error' : 'ok',
              // Two agents report their own cost, under opposite §18 policies: claude-code
              // folds per request_id (so a report repeated across an API response's block
              // rows counts ONCE), opencode counts every row (so the same repetition counts
              // every time). The duplicate rows carry different reports, so both directions
              // of "the per-agent policy applies to a report exactly as it does to tokens".
              costReported: ai === 0 || ai === 3 ? 0.01 * (d + 1) + b * 0.001 : null,
              rawSeq: b,
            },
            `${agentId}:${d}:${b}`,
          ),
        )
      }
      // Rows with no request_id: each is its own stage-1 group, which is the case the
      // representative-row join is easiest to get wrong.
      events.push(
        hexSeed(
          {
            agentId,
            hostId: `h${ai % 2}`,
            projectId: `proj-${ai}`,
            sessionId: `sess-${ai}-${d}`,
            timestamp,
            type: 'tool.start',
            capability: { type: 'tool', name: b0(ai) },
            durationMs: 12 + ai,
            usageSource: 'missing',
            status: 'ok',
            rawSeq: 90 + d,
            metadata: ai === 1 && d === 2 ? { subagentThread: true, cwd: '/repo/x' } : { cwd: '/repo/x' },
          },
          `${agentId}:${d}:plain`,
        ),
      )
    }
  })
  insertEvents(db, events)
  return db
}

const TOOL_NAMES = ['Bash', 'Read', 'Edit', 'Grep'] as const
const b0 = (n: number): string => TOOL_NAMES[n % TOOL_NAMES.length] ?? 'Bash'

const DEPS: QueryDeps = {
  priceResolver: (p, m) => (p === 'anthropic' && m === 'test-model' ? PRICE : null),
  aggregation: {
    codex: { mode: 'per_record_sum', subagentsIncluded: true },
    opencode: { mode: 'last_call_sum', subagentsIncluded: true },
  },
}

const tempTableCount = (db: DatabaseSync): number =>
  (db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all() as { name: string }[]).length

describe('fold materialisation is numerically invisible', () => {
  const db = seeded()

  /** Every dim on its own, and a few pairs — the cache changes which relation each reads. */
  const dimSpecs: QuerySpec[] = [
    ...DIMS.map((d) => ({ dims: [d], metrics: ['events', 'tokens_total', 'cost_api_equiv'] as QuerySpec['metrics'] })),
    { dims: ['day', 'agent', 'model'], metrics: ['tokens_total', 'tokens_input', 'duration', 'cost_api_equiv'] },
    { dims: ['project', 'host', 'session'], metrics: ['events', 'sessions', 'tokens_cache_write'] },
    { dims: ['capability_type', 'capability_name'], metrics: ['events', 'tokens_total', 'cost_reported'] },
    { dims: [], metrics: ['tokens_total', 'tokens_input', 'duration', 'cost_api_equiv', 'events', 'sessions'] },
  ]

  for (const spec of dimSpecs) {
    it(`matches the inline CTE for dims=[${(spec.dims ?? []).join(',')}] metrics=[${(spec.metrics ?? []).join(',')}]`, () => {
      const inline = query(db, spec, DEPS)
      const cache = createFoldCache(db)
      const materialised = query(db, spec, { ...DEPS, foldCache: cache })
      expect(cache.names().length, 'the cached path must actually materialise a fold').toBeGreaterThan(0)
      expect(materialised.rows).toEqual(inline.rows)
      expect(materialised.totals).toEqual(inline.totals)
      expect(materialised.columns).toEqual(inline.columns)
      expect(materialised.truncated).toBe(inline.truncated)
      cache.dispose()
      expect(tempTableCount(db), 'dispose() must leave no temp table behind').toBe(0)
    })
  }

  const filterCases: [string, QuerySpec][] = [
    ['model filter (stage 1 keeps its models join)', { dims: ['agent'], metrics: ['tokens_total'], filter: { model: ['test-model'] } }],
    ['provider filter', { dims: ['agent'], metrics: ['tokens_total', 'cost_api_equiv'], filter: { provider: ['anthropic'] } }],
    ['unpriced model filter (cost stays null, never 0)', { dims: ['agent'], metrics: ['cost_api_equiv'], filter: { model: ['nope'] } }],
    ['status filter narrows the fold itself', { dims: ['capability_type'], metrics: ['events', 'tokens_total'], filter: { status: ['error'] } }],
    ['subagent threads excluded before folding', { dims: ['agent'], metrics: ['tokens_total', 'duration'], filter: { includeSubagentThreads: false } }],
    ['since window', { dims: ['day'], metrics: ['tokens_total', 'sessions'], filter: { since: '30d' } }],
    ['since + until + agent', { dims: ['session'], metrics: ['events', 'tokens_output'], filter: { since: '30d', until: '20d', agent: ['codex'] } }],
    ['order and limit keep cutting the same rows', { dims: ['agent'], metrics: ['tokens_total', 'cost_api_equiv'], order: 'metric:cost_api_equiv:desc', limit: 2 }],
  ]

  for (const [label, spec] of filterCases) {
    it(`matches for ${label}`, () => {
      const inline = query(db, spec, DEPS)
      const cache = createFoldCache(db)
      const materialised = query(db, spec, { ...DEPS, foldCache: cache })
      expect(materialised.rows).toEqual(inline.rows)
      expect(materialised.totals).toEqual(inline.totals)
      cache.dispose()
    })
  }

  it('one cache serves every call in a scope and still answers each one correctly', () => {
    // The dashboard case: the same window asked eight different ways. The shared fold is the
    // entire point, so assert the reuse as well as the agreement.
    const cache = createFoldCache(db)
    const deps: QueryDeps = { ...DEPS, foldCache: cache }
    const specs: QuerySpec[] = [
      { dims: ['day'], metrics: ['tokens_total', 'cost_api_equiv'] },
      { dims: ['agent'], metrics: ['tokens_total', 'cost_api_equiv', 'duration'] },
      { dims: ['project'], metrics: ['events', 'sessions', 'tokens_input'] },
      { dims: ['model'], metrics: ['tokens_total'] },
    ]
    for (const spec of specs) {
      expect(query(db, spec, deps).rows).toEqual(query(db, spec, DEPS).rows)
      expect(query(db, spec, deps).totals).toEqual(query(db, spec, DEPS).totals)
    }
    expect(cache.names()).toHaveLength(1)
    cache.dispose()
    expect(tempTableCount(db)).toBe(0)
  })

  it('a different filter gets its own fold rather than reusing a wrong one', () => {
    const cache = createFoldCache(db)
    const deps: QueryDeps = { ...DEPS, foldCache: cache }
    query(db, { dims: ['agent'], metrics: ['tokens_total'] }, deps)
    query(db, { dims: ['agent'], metrics: ['tokens_total'], filter: { agent: ['codex'] } }, deps)
    query(db, { dims: ['agent'], metrics: ['tokens_total'], filter: { since: '30d' } }, deps)
    expect(cache.names()).toHaveLength(3)
    cache.dispose()
  })

  it('a pure event-count query materialises nothing', () => {
    // `events`/`sessions`/`cost_reported` are raw-event metrics: a spec that never touches a
    // token or cost metric must not pay for a fold it does not read.
    const cache = createFoldCache(db)
    query(db, { dims: ['agent'], metrics: ['events', 'sessions', 'cost_reported'] }, { ...DEPS, foldCache: cache })
    expect(cache.names()).toHaveLength(0)
    cache.dispose()
  })

  it('totals: false still agrees with the inline path', () => {
    for (const spec of [
      { dims: ['agent'], metrics: ['tokens_total', 'cost_api_equiv'] },
      { dims: ['day', 'host'], metrics: ['events', 'tokens_output'] },
    ] as QuerySpec[]) {
      const withFlag = { ...spec, totals: false }
      const cache = createFoldCache(db)
      expect(query(db, withFlag, { ...DEPS, foldCache: cache }).rows).toEqual(query(db, withFlag, DEPS).rows)
      cache.dispose()
    }
  })

  it('covers every metric at once without drifting', () => {
    const spec: QuerySpec = { dims: ['agent', 'day'], metrics: [...METRICS] }
    const inline = query(db, spec, DEPS)
    const cache = createFoldCache(db)
    expect(query(db, spec, { ...DEPS, foldCache: cache })).toEqual(inline)
    cache.dispose()
  })

  /**
   * The §18 row 1 fusion is the newest thing stage 1 carries: `rep_cost` must survive the
   * round trip through the materialised fold, including its NULL, because stage 2 finds the
   * never-reported requests with `WHERE r.rep_cost IS NULL`. If that predicate misfired the
   * cached path would price reports a second time on top of themselves — a cost number that
   * looks plausible and is simply wrong.
   */
  describe('cost_total (reported > computed, resolved per request)', () => {
    const FUSION_METRICS = ['cost_total', 'cost_api_equiv', 'cost_reported', 'events', 'tokens_total'] as const

    it('the fixture actually produces reported, computed and mixed costs', () => {
      // Guards the whole block below: an all-NULL cost_total would make every cached-vs-inline
      // comparison pass while proving nothing.
      const rows = query(db, { dims: ['agent'], metrics: [...FUSION_METRICS] }, DEPS).rows as Record<string, unknown>[]
      const values = rows.map((r) => r.cost_total)
      expect(values.some((v) => typeof v === 'number' && v > 0), `expected some priced cost, got ${JSON.stringify(values)}`).toBe(true)
      expect(values.some((v) => v === null), 'expected at least one unpriceable agent to stay NULL').toBe(true)
    })

    for (const dims of [
      ['agent'],
      ['day'],
      ['project'],
      ['model'],
      ['agent', 'day'],
      [],
    ] as const) {
      it(`matches for cost_total grouped by [${dims.join(',')}]`, () => {
        const spec: QuerySpec = { dims: [...dims], metrics: [...FUSION_METRICS] }
        const inline = query(db, spec, DEPS)
        const cache = createFoldCache(db)
        const cached = query(db, spec, { ...DEPS, foldCache: cache })
        expect(cache.names().length).toBeGreaterThan(0)
        expect(cached.rows).toEqual(inline.rows)
        expect(cached.totals).toEqual(inline.totals)
        cache.dispose()
      })
    }

    /**
     * The pair that proves the §18 per-agent policy reaches the report column, not just the
     * token columns. Both agents report the same-shaped numbers on the same-shaped duplicate
     * rows; only their fold differs, so only one of them should collapse. A materialised fold
     * that lost `rep_cost`, or lost the MAX on it, would break the first case and is exactly
     * what the cached/inline comparison below cannot see on its own (both would be wrong alike).
     */
    it('applies each agent’s fold policy to its reported cost', () => {
      const spec: QuerySpec = { dims: ['agent'], metrics: [...FUSION_METRICS] }
      const fused = (label: 'inline' | 'cached', agent: string): Record<string, unknown> => {
        const cache = label === 'cached' ? createFoldCache(db) : null
        const row = query(db, spec, cache ? { ...DEPS, foldCache: cache } : DEPS).rows.find(
          (r) => String(r.agent) === agent,
        ) as Record<string, unknown>
        cache?.dispose()
        return row
      }
      for (const label of ['inline', 'cached'] as const) {
        const folded = fused(label, 'claude-code') // request_max: one report per request
        expect(Number(folded.cost_total), `${label}: report folded once per request`).toBeLessThan(Number(folded.cost_reported))
        const perRow = fused(label, 'opencode') // last_call_sum: every row counted
        expect(Number(perRow.cost_total), `${label}: sum-mode report counts each row`).toBeCloseTo(Number(perRow.cost_reported), 10)
      }
      // The two policies must actually differ, or the fixture stopped discriminating.
      expect(Number(fused('inline', 'claude-code').cost_total)).not.toBeCloseTo(
        Number(fused('inline', 'opencode').cost_total),
        10,
      )
    })

    it('shares one fold between cost_total and cost_api_equiv in the same request', () => {
      const cache = createFoldCache(db)
      const deps: QueryDeps = { ...DEPS, foldCache: cache }
      query(db, { dims: ['agent'], metrics: ['cost_total', 'tokens_total'] }, deps)
      query(db, { dims: ['day'], metrics: ['cost_api_equiv', 'tokens_total'] }, deps)
      expect(cache.names()).toHaveLength(1)
      cache.dispose()
    })
  })
})
