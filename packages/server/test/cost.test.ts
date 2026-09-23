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
import { actualUsdFor, costView, missingPriceModels, modelSpend, unpricedBuckets, unpricedModels } from '../src/cost.ts'
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
    // Which sentence explains the figure; the sentence itself (and the fact that it
    // names `cost_total`) lives in the message catalog, tested in apps/web.
    expect(view.basisCode).toBe('fusedFormula')
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

  it('counts a model once however many tiers its rows come in under', () => {
    // `models` is unique on (provider, name, tier) and the price lookup ignores tier, so the
    // same unpriced model arrives as one spend row per tier. The set has to fold them: the
    // Models page keys its banner on (provider, model) and a per-tier list is a duplicate key
    // there — a real store had one GLM model listed four times and the page never rendered.
    const db = openDatabase(':memory:')
    migrate(db)
    const tiered = (id: string, tier: string, input: number): AgentEvent =>
      ev(id, {
        model: { provider: 'bigmodel', name: 'GLM-5.3-Flash', tier },
        usage: { ...usage(input), outputTokens: 10 },
        requestId: id,
      })
    insertEvents(db, [
      tiered('t1', 'plan-a', 1_000_000),
      tiered('t2', 'plan-b', 2_000_000),
      tiered('t3', 'plan-c', 3_000_000),
      ev('priced', { model: { provider: 'anthropic', name: 'full', tier: 'x' }, usage: { ...usage(500), outputTokens: 5 }, requestId: 'priced' }),
    ])
    const resolver: PriceResolver = (_p, model) => (model === 'full' ? { ...TEST_PRICE } : null)
    const ctx = createContext({ db, now: () => 1_700_000_100_000, priceResolver: resolver })
    expect(modelSpend(db, 1).filter((m) => m.model === 'GLM-5.3-Flash')).toHaveLength(3)
    const gaps = missingPriceModels(ctx)
    expect(gaps.map((g) => `${g.provider}/${g.model}`)).toEqual(['bigmodel/GLM-5.3-Flash'])
    // The merged row still carries the whole model's spend, not one tier's.
    const merged = unpricedModels(db, resolver, 1_700_000_100_000)
    expect(merged.map((m) => m.model)).toEqual(['GLM-5.3-Flash'])
    expect(merged[0]?.events).toBe(3)
    expect(merged[0]?.input).toBe(6_000_000)
    db.close()
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

/**
 * §8's worst direction is understating a figure the agent itself logged. §18 row 1 NULLs an
 * agent's `cost_total` when any never-reported slice of it has no price — correct for "what did
 * this agent cost", but the headline used to drop that agent's *reported* money along with the
 * unpriceable slice, so the top line read lower than a number already known.
 */
describe('§8 the headline floor does not fall below a reported cost', () => {
  let mixedDb: DatabaseSync
  beforeAll(() => {
    mixedDb = openDatabase(':memory:')
    migrate(mixedDb)
    insertEvents(
      mixedDb,
      [
        ev('mixed-reported', { agentId: 'opencode', requestId: 'mr-1', model: MODEL, usage: usage(1_000_000), costReported: 0.42, costSource: 'reported' }),
        ev('mixed-unpriced', { agentId: 'opencode', requestId: 'mr-2', model: { provider: 'nope', name: 'unobtainium' }, usage: usage(1_000_000) }),
      ],
      { contentEnabled: false },
    )
  })
  afterAll(() => mixedDb.close())

  it('keeps the reported slice in the total and marks the rest unknown', () => {
    const view = costView(createContext({ db: mixedDb, now: () => 1_700_000_100_000, priceResolver: testPriceResolver }))
    const oc = view.perAgent.find((s) => s.agentId === 'opencode')
    // Per agent the fused answer is still unknown: §18 row 1 must not be quietly relaxed.
    expect(oc?.totalUsd).toBeNull()
    expect(oc?.reportedUsd).toBeCloseTo(0.42, 10)
    // Headline: the known money survives as a floor, and says so.
    expect(view.totalUsd).not.toBeNull()
    expect(view.totalUsd!).toBeGreaterThanOrEqual(0.42)
    expect(view.totalUsd!).toBeLessThan(1.42) // the unpriced work is NOT folded in
    expect(view.totalPartial).toBe(true)
    // Which sentence explains the figure; the sentence itself (and the fact that it
    // names `cost_total`) lives in the message catalog, tested in apps/web.
    expect(view.basisCode).toBe('fusedFormula')
  })

  it('stays byte-identical when everything is priceable, so the floor adds nothing', () => {
    const whole = costView(ctx())
    expect(whole.totalUsd).toBeCloseTo(1.5, 10)
    expect(whole.totalPartial).toBe(false)
  })

  /**
   * The same under-read with nothing reported: the agent-grain fusion is NULL, so the headline
   * printed `≥ $0.00` — "we know it cost at least nothing" — while the Models table of the very
   * same store showed the priced half. An agent that reported nothing is not an agent that
   * cost nothing, and §8 forbids the number from reading lower than the knowable amount.
   */
  it('counts the priced half of a window no agent reported anything for', () => {
    const half = openDatabase(':memory:')
    migrate(half)
    insertEvents(
      half,
      [
        ev('half-priced', { agentId: 'opencode', requestId: 'hp-1', model: MODEL, usage: usage(1_000_000) }),
        ev('half-gap', {
          agentId: 'opencode',
          requestId: 'hp-2',
          model: { provider: 'nope', name: 'unobtainium' },
          usage: usage(1_000_000),
        }),
      ],
      { contentEnabled: false },
    )
    try {
      const view = costView(createContext({ db: half, now: () => 1_700_000_100_000, priceResolver: testPriceResolver }))
      const oc = view.perAgent.find((s) => s.agentId === 'opencode')
      // §18 row 1 stays intact where it is the answer to a question: per agent, the fused cost
      // is still unknown. The fallback belongs to the floor, not to the figure.
      expect(oc?.totalUsd).toBeNull()
      expect(oc?.reportedUsd).toBeNull()
      // TEST_PRICE is $1 per 1M tokens, so the priced model is exactly $1 of the $2 window.
      expect(oc?.apiEquivalentUsd).toBeCloseTo(1, 10)
      expect(view.apiEquivalentUsd).toBeCloseTo(1, 10)
      expect(view.apiEquivalentPartial).toBe(true)
      expect(view.totalUsd).toBeCloseTo(1, 10)
      expect(view.totalPartial).toBe(true)
      expect(view.actualUsd).toBeCloseTo(1, 10) // `api` mode: the estimate is the cash
      expect(view.unpricedAgents).toEqual(['opencode'])
    } finally {
      half.close()
    }
  })

  it('leaves a fully unpriced agent with no floor to invent', () => {
    const dark = openDatabase(':memory:')
    migrate(dark)
    insertEvents(
      dark,
      [ev('dark-1', { agentId: 'opencode', requestId: 'dk-1', model: { provider: 'nope', name: 'unobtainium' }, usage: usage(1_000_000) })],
      { contentEnabled: false },
    )
    try {
      const view = costView(createContext({ db: dark, now: () => 1_700_000_100_000, priceResolver: testPriceResolver }))
      // Nothing is knowable: the agent's own figures stay NULL (no invented money, §8) and the
      // headline is flagged partial, which is what tells the UI to say "at least" / "No price".
      expect(view.perAgent[0]?.totalUsd).toBeNull()
      expect(view.perAgent[0]?.apiEquivalentUsd).toBeNull()
      expect(view.totalPartial).toBe(true)
      expect(view.apiEquivalentPartial).toBe(true)
      expect(view.unpricedAgents).toEqual(['opencode'])
    } finally {
      dark.close()
    }
  })
})
