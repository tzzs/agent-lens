/**
 * §8/§18 row 1: the grand totals a cost read returns must not depend on whether the caller
 * also asked for rows.
 *
 * The engine now prices ONE bucket read and merges the caller's dims away for the totals,
 * instead of running the same statement a second time with no dims. That is only the same
 * computation while `computeCost` is linear in tokens — merge before pricing vs price each
 * half and add. So this file states the property as the observable equality (grouped totals
 * == the dims-less call, which never goes through the merge) and walks it across every shape
 * the price table can hold: a fully priced entry, each bucket missing on its own, the
 * `PRICE_MISSING` sentinel vs an absent reasoning price, a model with no entry at all,
 * zero-token buckets, NULL token columns, and the three billing modes.
 *
 * The day pricing stops being linear, this suite is where the merge stops being allowed.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { PRICE_MISSING, type BillingMode, type PriceEntry } from '@agentlens/pricing'
import { query, foldPasses, resetFoldPasses, type QueryDeps } from '@agentlens/query'
import { hexSeed } from './fixtures.ts'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 8, 10)

/** Two projects × two models × two days, plus the shapes that used to break a merge. */
function events(): AgentEvent[] {
  const out: AgentEvent[] = []
  const push = (over: Partial<AgentEvent>, i: number): void => {
    out.push(hexSeed({ timestamp: T0 + i * DAY, requestId: `r${out.length}`, ...over }, `bucket-${out.length}`))
  }
  for (const project of ['proj-a', 'proj-b']) {
    for (const model of ['priced-full', 'priced-partial', 'no-entry']) {
      push({ projectId: project, model: { provider: 'p1', name: model }, usage: { inputTokens: 1_000_000, outputTokens: 2_000_000, cacheReadTokens: 3_000_000, cacheWriteTokens: 4_000_000, reasoningTokens: 500_000 } }, 0)
      // Same (model, day) under the other project: the merge's whole point.
      push({ projectId: project, model: { provider: 'p1', name: model }, usage: { inputTokens: 250_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }, 1)
    }
    // A zero-token bucket: skipped on its own, and it must not change the merged price.
    push({ projectId: project, model: { provider: 'p1', name: 'priced-full' }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }, 1)
    // NULL tokens: `usageOf` reads them as zero, so a merge writing 0 cannot move a number.
    push({ projectId: project, model: { provider: 'p1', name: 'priced-full' }, usage: undefined, usageSource: 'missing' }, 0)
    // A reported cost on one row only: §18 row 1 picks the report over the pricing per request.
    push({ projectId: project, model: { provider: 'p1', name: 'priced-full' }, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, costReported: 0.42, costSource: 'reported' }, 1)
  }
  return out
}

function store(): DatabaseSync {
  const db = openDatabase(':memory:')
  migrate(db)
  insertEvents(db, events())
  return db
}

const entry = (over: Partial<PriceEntry> = {}): PriceEntry => ({
  provider: 'p1',
  model: 'priced-full',
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  reasoningPerMTok: 15,
  effectiveFrom: 0,
  source: 'litellm',
  ...over,
})

/**
 * Every verdict `computeCost` can be handed, keyed by what makes it different.
 *
 * `numeric` says whether that shape leaves the grand total a NUMBER. It matters: a bucket
 * with no price NULLs the whole total (§8), so comparing grouped against unmerged over a
 * gap shape only proves NULL equals NULL — which is why the shapes below price every model
 * the fixture spends tokens on, and leave the gap cases to the separate §8 suite. A merge
 * test that cannot fail numerically is not a merge test.
 */
const RESOLVERS: { name: string; numeric: boolean; resolve: (p: string, m: string) => PriceEntry | null }[] = [
  { name: 'all priced', numeric: true, resolve: (_p, model) => entry({ model }) },
  { name: 'reasoning billed as output', numeric: true, resolve: (_p, model) => entry({ model, reasoningPerMTok: null }) },
  { name: 'local mode, priced', numeric: true, resolve: (_p, model) => entry({ model }) },
  // Gap shapes: the total is NULL by rule, so these pin agreement, not arithmetic.
  { name: 'one model unpriced', numeric: false, resolve: (_p, model) => (model === 'no-entry' ? null : entry({ model })) },
  { name: 'input missing', numeric: false, resolve: (_p, model) => entry({ model, inputPerMTok: PRICE_MISSING }) },
  { name: 'cacheWrite missing', numeric: false, resolve: (_p, model) => entry({ model, cacheWritePerMTok: PRICE_MISSING }) },
  { name: 'reasoning missing', numeric: false, resolve: (_p, model) => entry({ model, reasoningPerMTok: PRICE_MISSING }) },
  { name: 'nothing priced', numeric: false, resolve: () => null },
]

const MODES: BillingMode[] = ['api', 'subscription', 'local']

const COST_METRICS = ['cost_api_equiv', 'cost_total', 'cost_reported'] as const

describe('a cost read prices one bucket pass, however many grains ask for it (§8)', () => {
  for (const shape of RESOLVERS) {
    for (const mode of MODES) {
      it(`${shape.name} / ${mode}: grouped totals equal the dims-less read`, () => {
        const db = store()
        const deps: QueryDeps = { priceResolver: shape.resolve, billingModeFor: () => mode }
        const grouped = query(db, { metrics: [...COST_METRICS], dims: ['project'] }, deps)
        const flat = query(db, { metrics: [...COST_METRICS], dims: [] }, deps)
        // The assertion that matters: merging the caller's dims away is the same computation
        // as never having grouped them.
        expect(grouped.totals).toEqual(flat.totals)
        if (shape.numeric && mode === 'api') {
          // And here it is arithmetic, not two NULLs agreeing: a merge that dropped one
          // project's tokens would move these digits.
          expect(typeof grouped.totals.cost_api_equiv).toBe('number')
          expect(grouped.totals.cost_api_equiv).toBeGreaterThan(0)
          expect(grouped.totals.cost_total).not.toBeNull()
        }
        db.close()
      })

      it(`${shape.name} / ${mode}: truncating the rows leaves the totals alone`, () => {
        const db = store()
        const deps: QueryDeps = { priceResolver: shape.resolve, billingModeFor: () => mode }
        const one = query(db, { metrics: [...COST_METRICS], dims: ['project'], limit: 1 }, deps)
        const flat = query(db, { metrics: [...COST_METRICS], dims: [] }, deps)
        expect(one.truncated).toBe(true)
        expect(one.totals).toEqual(flat.totals)
        db.close()
      })
    }
  }

  it('costs one bucket read per metric, not one per grain', () => {
    const db = store()
    const priced = RESOLVERS.find((r) => r.name === 'all priced')!.resolve
    const deps: QueryDeps = { priceResolver: priced, billingModeFor: () => 'api' }
    resetFoldPasses()
    query(db, { metrics: [...COST_METRICS], dims: ['project'] }, deps)
    expect(foldPasses().costBuckets, 'api-equiv + the unreported half, once each').toBe(2)
    resetFoldPasses()
    query(db, { metrics: [...COST_METRICS], dims: ['project', 'model'] }, deps)
    expect(foldPasses().costBuckets, 'a finer grain costs no extra pass').toBe(2)
    db.close()
  })
})
