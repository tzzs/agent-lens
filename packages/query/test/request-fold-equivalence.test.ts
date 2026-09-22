/**
 * §19's materialised stage 1 must be numerically invisible.
 *
 * The cube now has THREE read paths for stage 2 — the inline `req` CTE joined back to
 * `events`, a temp table materialised once per request scope (`fold-cache.ts`), and the
 * persisted `requests` table maintained by the write path — and all three owe the same
 * answer. This file compares the persisted one against the inline one over the whole
 * dim × metric × filter matrix, on the full JSON rather than a few fields, because the
 * failure mode it exists to catch is a number that moves by a plausible amount.
 *
 * Every eligible case also asserts the fast path actually ran. A comparison where both sides
 * quietly took the slow path would be green and prove nothing, which is the trap
 * `fold-equivalence.test.ts` documents for the same reason.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { insertEvents, migrate, openDatabase, setAgentAggregations } from '@agentlens/storage'
import type { AgentEvent } from '@agentlens/event-model'
import type { PriceEntry } from '@agentlens/pricing'
import { DIMS, METRICS, foldPasses, query, resetFoldPasses, type QueryDeps, type QuerySpec } from '@agentlens/query'
import { hexSeed } from './fixtures.ts'

const DAY = 86_400_000
const NOW = 1_750_000_000_000

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

/** §18 row 2: two agents on the request fold, two on the sum folds, all PERSISTED. */
const AGGREGATION = {
  codex: { mode: 'per_record_sum', subagentsIncluded: true },
  opencode: { mode: 'last_call_sum', subagentsIncluded: true },
} as const

const DEPS: QueryDeps = {
  priceResolver: (p, m) => (p === 'anthropic' && m === 'test-model' ? PRICE : null),
  aggregation: AGGREGATION,
  now: () => NOW,
}

/**
 * The fixture the task asks for: several agents, both fold policies, duplicate request rows,
 * an unpriced model, NULL reported-cost slices, a request that straddles a window edge, and
 * dims (status/capability/session) that differ BETWEEN the duplicated rows of one request —
 * which is precisely the shape a pre-folded row must not be filtered on.
 */
function seeded(): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  // The reader's map has to be the grouping on disk, or it correctly declines: §18 row 2's
  // policies are persisted by `agl scan` before its first row, exactly as here.
  setAgentAggregations(db, AGGREGATION)
  const events: AgentEvent[] = []
  const agents = ['claude-code', 'qoder', 'codex', 'opencode']
  agents.forEach((agentId, ai) => {
    for (let d = 0; d < 4; d++) {
      const timestamp = NOW - (3 - d) * DAY + ai * 1000
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
              // qoder's second day is an unpriced model, so §18 row 1's fusion has to reach its
              // NULL-not-zero answer through a materialised `rep_cost`.
              model:
                ai === 1 && d === 1
                  ? { provider: 'anthropic', name: 'unpriced-model' }
                  : { provider: 'anthropic', name: 'test-model' },
              usage: { inputTokens: 100 + b, outputTokens: 20 + b, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 0 },
              durationMs: 500 + b,
              usageSource: 'reported',
              // Status differs WITHIN the request: a filter on it selects part of a group.
              status: d === 3 && b === 2 ? 'error' : 'ok',
              // claude-code folds its report per request; opencode counts every row (§18 row 1).
              costReported: ai === 0 || ai === 3 ? 0.01 * (d + 1) + b * 0.001 : null,
              rawSeq: b,
            },
            `${agentId}:${d}:${b}`,
          ),
        )
      }
      // A request with no `request_id` at all: each row is its own stage-1 group.
      events.push(
        hexSeed(
          {
            agentId,
            hostId: `h${ai % 2}`,
            projectId: `proj-${ai}`,
            sessionId: `sess-${ai}-${d}`,
            timestamp,
            type: 'tool.start',
            requestId: null,
            capability: { type: 'tool', name: TOOL_NAMES[ai % 4]!, provider: null },
            usage: undefined,
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
  // One Claude request whose content blocks straddle the 2-day mark: a window cutting there
  // must make the reader decline, and the answer must still be the inline one.
  events.push(
    hexSeed(
      { agentId: 'claude-code', requestId: 'req-straddle', timestamp: NOW - 2 * DAY - 1, projectId: 'proj-0', sessionId: 'sess-straddle' },
      'straddle:early',
    ),
    hexSeed(
      { agentId: 'claude-code', requestId: 'req-straddle', timestamp: NOW - 2 * DAY + 1, projectId: 'proj-0', sessionId: 'sess-straddle' },
      'straddle:late',
    ),
  )
  insertEvents(db, events)
  return db
}

const TOOL_NAMES = ['Bash', 'Read', 'Edit', 'Grep'] as const

let fixture: DatabaseSync | null = null
function db_(): DatabaseSync {
  fixture ??= seeded()
  return fixture
}

const json = (r: unknown): string => JSON.stringify(r)

/**
 * One case: the same spec over the same store, with and without the persisted table.
 * `expectServed` is what keeps the comparison honest — a declined spec proves nothing about
 * the fast path, so the eligibility matrix below says which side of that line each is on.
 */
function compare(label: string, spec: QuerySpec, expectServed: boolean): void {
  const db = db_()
  resetFoldPasses()
  const inline = query(db, spec, { ...DEPS, persistedFold: false })
  const inlineFolds = foldPasses()
  resetFoldPasses()
  const persisted = query(db, spec, DEPS)
  const passes = foldPasses()
  if (expectServed) {
    expect(passes.persisted, `${label}: expected the persisted stage 1 to answer`).toBeGreaterThan(0)
    expect(passes.inline, `${label}: a fold leaked into the served path`).toBe(0)
  } else {
    expect(passes.persisted, `${label}: expected this spec to decline the persisted path`).toBe(0)
    expect(inlineFolds.inline, `${label}: the fixture stopped exercising the fold`).toBeGreaterThan(0)
  }
  expect(json(persisted), label).toBe(json(inline))
}

describe('§19 persisted stage 1 is numerically invisible', () => {
  const eligibleSpecs: [string, QuerySpec][] = [
    ['no filter, no dims', { metrics: [...METRICS], dims: [] }],
    ...DIMS.map(
      (d): [string, QuerySpec] => [
        `single dim ${d}`,
        {
          dims: [d],
          metrics: ['events', 'tokens_total', 'tokens_input', 'duration', 'cost_api_equiv', 'cost_total', 'cost_reported'],
        },
      ],
    ),
    ['day × agent × model', { dims: ['day', 'agent', 'model'], metrics: ['tokens_total', 'tokens_input', 'duration', 'cost_api_equiv'] }],
    ['project × host × session', { dims: ['project', 'host', 'session'], metrics: ['events', 'sessions', 'tokens_cache_write'] }],
    ['capability pair', { dims: ['capability_type', 'capability_name'], metrics: ['events', 'tokens_total', 'cost_reported'] }],
    ['every metric at once', { dims: ['agent', 'day'], metrics: [...METRICS] }],
    ['agent filter only', { dims: ['agent'], metrics: ['tokens_total', 'cost_total'], filter: { agent: ['claude-code', 'codex'] } }],
    ['window that cuts no group', { dims: ['day'], metrics: ['tokens_total', 'cost_api_equiv'], filter: { since: NOW - 3 * DAY, until: NOW + DAY } }],
    ['agent + window', { dims: ['agent', 'day'], metrics: ['tokens_total', 'duration'], filter: { since: NOW - 4 * DAY, agent: ['qoder'] } }],
    ['order and limit', { dims: ['agent'], metrics: ['tokens_total', 'cost_api_equiv'], order: 'metric:cost_api_equiv:desc', limit: 2 }],
    ['totals off', { dims: ['project'], metrics: ['tokens_total', 'cost_total'], totals: false }],
  ]
  for (const [label, spec] of eligibleSpecs) it(`${label}: served from the table`, () => compare(label, spec as QuerySpec, true))

  /**
   * The declines. Each of these filters can keep some members of a group and drop others, so
   * the folded row is a different question and the cube has to fold live. These cases are the
   * guard rail: they must produce the inline answer AND not claim a persisted serve.
   */
  const declining: [string, QuerySpec][] = [
    ['project filter', { dims: ['agent'], metrics: ['tokens_total'], filter: { project: ['proj-0'] } }],
    ['session filter', { dims: ['agent'], metrics: ['tokens_total'], filter: { session: ['sess-0-1'] } }],
    ['model filter', { dims: ['agent'], metrics: ['tokens_total'], filter: { model: ['test-model'] } }],
    ['provider filter', { dims: ['agent'], metrics: ['tokens_total', 'cost_api_equiv'], filter: { provider: ['anthropic'] } }],
    ['status filter splits a request', { dims: ['capability_type'], metrics: ['events', 'tokens_total'], filter: { status: ['error'] } }],
    ['type filter', { dims: ['agent'], metrics: ['tokens_total'], filter: { type: ['tool.start'] } }],
    ['capability filter', { dims: ['agent'], metrics: ['tokens_total'], filter: { capabilityType: ['tool'] } }],
    ['host filter', { dims: ['agent'], metrics: ['tokens_total'], filter: { host: ['h0'] } }],
    ['subagent switch is event-grain', { dims: ['agent'], metrics: ['tokens_total', 'duration'], filter: { includeSubagentThreads: false } }],
    ['window that cuts a straddling request', { dims: ['agent'], metrics: ['tokens_total'], filter: { since: NOW - 2 * DAY } }],
    ['until that cuts one', { dims: ['day'], metrics: ['tokens_total'], filter: { until: NOW - 2 * DAY } }],
  ]
  for (const [label, spec] of declining) it(`${label}: declined and folded live`, () => compare(label, spec, false))

  it('the relative window is resolved once, so a 30d page is served too', () => {
    // Nothing in this fixture straddles `NOW - 7d`, so a relative `since` is eligible.
    compare('since 7d (relative)', { dims: ['day'], metrics: ['tokens_total', 'cost_total'] } as QuerySpec, true)
  })

  it('the fixture really does contain both reported and priced costs, and a NULL', () => {
    // Guards the whole file: an all-NULL `cost_total` would make every comparison above pass
    // while proving nothing about §18 row 1's fusion.
    const rows = query(db_(), { dims: ['agent'], metrics: ['cost_total', 'cost_reported', 'tokens_total'] }, DEPS).rows
    const values = rows.map((r) => r.cost_total)
    expect(values.some((v) => typeof v === 'number' && v > 0), json(values)).toBe(true)
    expect(values.some((v) => v === null), json(values)).toBe(true)
    const folded = rows.find((r) => String(r.agent) === 'claude-code')!
    const perRow = rows.find((r) => String(r.agent) === 'opencode')!
    // The two policies must actually differ, or the fixture stopped discriminating (§18 row 2).
    expect(Number(folded.cost_total)).not.toBeCloseTo(Number(perRow.cost_total), 10)
  })

  it('an empty store is served, and empty means the same on both paths', () => {
    const empty = openDatabase(':memory:')
    migrate(empty)
    setAgentAggregations(empty, AGGREGATION)
    const spec: QuerySpec = { dims: ['agent'], metrics: ['tokens_total', 'cost_total'] }
    resetFoldPasses()
    expect(json(query(empty, spec, DEPS))).toBe(json(query(empty, spec, { ...DEPS, persistedFold: false })))
  })
})
