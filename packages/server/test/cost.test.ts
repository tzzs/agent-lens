/**
 * The §8 read model on top of the §18 row 1 fused metric: `costView.totalUsd`
 * must come from the cube's `cost_total`, not from the route adding a reported
 * cost onto a priced estimate of the same work, and `parseSpec` is the only
 * place the wire vocabulary (metric names, the subagent switch) is validated.
 *
 * The last two blocks are the §14 half: this file is where the served surface's copy of
 * §8's unpriced set and of §8's billing-mode table is pinned to `packages/pricing`, which
 * is the rule the cube itself prices with. Both used to be restated per surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { PRICE_MISSING, computeCost, type BillingMode, type PriceEntry } from '@agentlens/pricing'
import { createContext } from '../src/app.ts'
import { actualUsdFor, costView, missingPriceModels, modelSpend, unpricedBuckets } from '../src/cost.ts'
import { parseSpec } from '../src/request-spec.ts'
import type { PriceResolver } from '../src/types.ts'
import { TEST_PRICE, testPriceResolver } from './helpers.ts'

function ev(id: string, over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'cli',
    sourceId: 'src-cost',
    sessionId: 'sess-cost',
    projectId: 'proj-cost',
    timestamp: 1_700_000_000_000,
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 0,
    rawOffset: 0,
    ...over,
  } as AgentEvent
}

const MODEL = { provider: 'anthropic', name: 'test-model' } // TEST_PRICE: 1 USD per 1M tokens
const usage = (t: number) => ({ inputTokens: t, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })

const events: AgentEvent[] = [
  // OpenCode-shaped row: its reported cost and its tokens describe the SAME work.
  // 2M input would price at $2; the agent says it cost $0.40.
  ev('oc1', { agentId: 'opencode', requestId: 'oc-r1', model: MODEL, usage: usage(2_000_000), costReported: 0.4, costSource: 'reported' }),
  // A subagent thread that reported its own slice: excludable via the §18 row 3 switch.
  ev('oc2', { agentId: 'opencode', requestId: 'oc-r2', model: MODEL, usage: usage(1_000_000), costReported: 0.1, costSource: 'reported', metadata: { subagentThread: true } }),
  // Claude-shaped row: no report, only priceable tokens.
  ev('cc1', { requestId: 'cc-r1', model: MODEL, usage: usage(1_000_000) }),
]

let db: DatabaseSync
beforeAll(() => {
  db = openDatabase(':memory:')
  migrate(db)
  insertEvents(db, events)
})
afterAll(() => db.close())

const ctx = () => createContext({ db, now: () => 1_700_000_100_000, priceResolver: testPriceResolver })

describe('costView reads the fused cost from the cube (§18 row 1)', () => {
  it('totalUsd is reported-where-reported + priced-where-not, never the hand-added pair', () => {
    const view = costView(ctx())
    const oc = view.perAgent.find((s) => s.agentId === 'opencode')
    const cc = view.perAgent.find((s) => s.agentId === 'claude-code')
    expect(oc?.apiEquivalentUsd).toBeCloseTo(3, 10) // every token priced, unchanged
    expect(oc?.reportedUsd).toBeCloseTo(0.5, 10) // raw SUM, unchanged
    expect(oc?.totalUsd).toBeCloseTo(0.5, 10) // reports exist: no priced slice for opencode
    expect(cc?.totalUsd).toBeCloseTo(1, 10) // no report: priced
    expect(view.totalUsd).toBeCloseTo(1.5, 10) // NOT 0.5+3+1=4.5 (the double count the fusion forbids)
    expect(view.totalPartial).toBe(false)
    expect(view.basis).toContain('cost_total')
  })

  it('the subagent switch flows through to the fused figure', () => {
    const ex = costView(ctx(), { includeSubagentThreads: false })
    const opencode = ex.perAgent.find((s) => s.agentId === 'opencode')
    expect(opencode?.totalUsd).toBeCloseTo(0.4, 10) // oc2 dropped, its report cannot be added twice
    expect(ex.reportedUsd).toBeCloseTo(0.4, 10)
    expect(ex.totalUsd).toBeCloseTo(1.4, 10)
  })
})

describe('parseSpec wire vocabulary', () => {
  const sp = (q: string) => new URLSearchParams(q)

  it('cost_total is a real metric now, orderable like any other', () => {
    const spec = parseSpec(sp('metrics=cost_total&order=metric:cost_total:desc'), db)
    expect(spec.metrics).toEqual(['cost_total'])
    expect(spec.order).toBe('metric:cost_total:desc')
  })

  it('subagents=exclude|include sets the cube filter; anything else is a 400', () => {
    expect(parseSpec(sp('subagents=exclude'), db).filter?.includeSubagentThreads).toBe(false)
    expect(parseSpec(sp('subagents=include'), db).filter?.includeSubagentThreads).toBe(true)
    expect(parseSpec(sp('metrics=events'), db).filter?.includeSubagentThreads).toBeUndefined() // default untouched
    expect(() => parseSpec(sp('subagents=sometimes'), db)).toThrow(/subagents/)
  })
})

/**
 * The whole point of `unpricedBuckets`/`modelSpend` living once is that both surfaces answer
 * from them; the audited half was that `missingPriceModels` only asked "is there an entry?",
 * so a model whose entry lacks a price for a bucket its events DID spend was a gap in the
 * cube's money (`n/a`) and not a gap on screen. §8 forbids that pairing.
 */
describe('§8 unpriced set is the spent-bucket rule, not the null-entry rule (defect 3)', () => {
  const bucket = (over: Partial<PriceEntry>): PriceEntry => ({ ...TEST_PRICE, ...over })
  const spend = (over: Record<string, number> = {}) =>
    ({
      provider: 'anthropic',
      model: 'm',
      lastSeen: 1,
      events: 1,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      ...over,
    })

  it('names exactly the buckets that have no price, and only when the model spent them', () => {
    expect(unpricedBuckets(bucket({}), spend({ input: 5 }))).toEqual([])
    expect(unpricedBuckets(null, spend({ input: 5 }))).toEqual(['price entry'])
    expect(unpricedBuckets(bucket({ cacheReadPerMTok: PRICE_MISSING }), spend({ input: 5 }))).toEqual([])
    expect(unpricedBuckets(bucket({ cacheReadPerMTok: PRICE_MISSING }), spend({ input: 5, cacheRead: 9 }))).toEqual(['cacheRead'])
    expect(unpricedBuckets(bucket({ inputPerMTok: PRICE_MISSING, outputPerMTok: PRICE_MISSING }), spend({ input: 1, output: 1 }))).toEqual([
      'input',
      'output',
    ])
  })

  it('treats an absent reasoning price as "bill it as output" and the sentinel as a gap', () => {
    // The bug this replaces: `reasoningPerMTok === PRICE_MISSING` is NaN compared to NaN, so
    // the sentinel case never fired and the CLI's set disagreed with the cube's `n/a`.
    expect(unpricedBuckets(bucket({ reasoningPerMTok: null }), spend({ reasoning: 40 }))).toEqual([])
    expect(unpricedBuckets(bucket({ reasoningPerMTok: PRICE_MISSING }), spend({ reasoning: 40 }))).toEqual(['reasoning'])
  })

  it('agrees with computeCost, the rule the cube prices with, on every shape above', () => {
    const usageOf = (s: ReturnType<typeof spend>) => ({
      inputTokens: s.input,
      outputTokens: s.output,
      cacheReadTokens: s.cacheRead,
      cacheWriteTokens: s.cacheWrite,
      reasoningTokens: s.reasoning,
    })
    const shapes: Array<[PriceEntry | null, ReturnType<typeof spend>]> = [
      [bucket({}), spend({ input: 5 })],
      [null, spend({ input: 5 })],
      [bucket({ cacheReadPerMTok: PRICE_MISSING }), spend({ input: 5 })],
      [bucket({ cacheReadPerMTok: PRICE_MISSING }), spend({ cacheRead: 5 })],
      [bucket({ reasoningPerMTok: null }), spend({ reasoning: 5 })],
      [bucket({ reasoningPerMTok: PRICE_MISSING }), spend({ reasoning: 5 })],
      [bucket({ outputPerMTok: PRICE_MISSING }), spend({ input: 1, output: 1 })],
    ]
    for (const [entry, m] of shapes) {
      expect(unpricedBuckets(entry, m).length > 0, `buckets vs gap for ${JSON.stringify(m)}`).toBe(
        computeCost(usageOf(m), entry, 'api').gap,
      )
    }
  })

  it('lists a bucket-level gap in the served report, which used to need a missing entry', () => {
    const pricedDb = openDatabase(':memory:')
    migrate(pricedDb)
    const row = (id: string, model: string, output: number): AgentEvent =>
      ev(id, { model: { provider: 'anthropic', name: model }, usage: { ...usage(1_000_000), outputTokens: output }, requestId: id })
    insertEvents(pricedDb, [row('g1', 'full', 100), row('g2', 'half-priced', 100), row('g3', 'unknown-model', 100)])
    const resolver: PriceResolver = (_p, model) =>
      model === 'full' ? { ...TEST_PRICE } : model === 'half-priced' ? { ...TEST_PRICE, outputPerMTok: PRICE_MISSING } : null
    const seen = missingPriceModels(createContext({ db: pricedDb, now: () => 1_700_000_100_000, priceResolver: resolver })).map((m) => m.model)
    expect(seen).toEqual(['half-priced', 'unknown-model'])
    // And the model with no spend at all cannot manufacture a gap out of an absent bucket.
    expect(modelSpend(pricedDb, 1).find((m) => m.model === 'full')?.events).toBe(1)
    pricedDb.close()
  })
})

/**
 * §8's billing-mode table is stated once, in `packages/pricing`'s `computeCost`. The route
 * cannot call it there (a per-agent aggregate has no single `PriceEntry`), so `actualUsdFor`
 * is a projection of it — and this is what stops the projection from becoming a third copy.
 */
describe('§8 billing fold stays pricing\'s rule (defect 4)', () => {
  const modes: BillingMode[] = ['api', 'subscription', 'local']
  const usage1M = { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

  it('actual cash matches computeCost for every mode, priced or not', () => {
    for (const mode of modes) {
      expect(actualUsdFor(2, mode), mode).toBe(computeCost(usage1M, { ...TEST_PRICE }, mode).actualUsd)
    }
  })

  it('an unpriced amount never folds into $0, in any mode (§8)', () => {
    for (const mode of modes) {
      expect(actualUsdFor(null, mode), mode).toBeNull()
      expect(computeCost(usage1M, null, mode).actualUsd).toBeNull()
    }
  })

  it('costView reaches the fold through it, so the totals move with the declared mode', () => {
    const view = costView(createContext({ db, now: () => 1_700_000_100_000, priceResolver: testPriceResolver, billingModeFor: () => 'subscription' }))
    expect(view.perAgent.every((s) => s.actualUsd === 0)).toBe(true)
    expect(view.apiEquivalentUsd).toBeGreaterThan(0)
  })
})
