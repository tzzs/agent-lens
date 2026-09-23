/**
 * §8 billing modes as a read model.
 *
 * The cube exposes the §18 row 1 cost priority as one metric — `cost_total` — so
 * this route never adds a reported cost onto a priced estimate of the same work.
 * The two underlying facts stay visible as their own columns; what is resolved in
 * SQL, not here, is which one pays for which request:
 *
 *   reported where the agent reported it, priced tokens for the never-reported part,
 *   NULL when a group has neither (§8: $0 reads as "free local model").
 *
 * "Actual cash" is a property of the agent's declared billing mode, not of the
 * tokens, so the server folds the cube's per-agent API-equivalent through §8's table —
 * via `actualUsdFor` below, the only place this file states that rule.
 */
import { costFloor, query, type QueryFilter } from '@agentlens/query'
import { isMissingPrice, type BillingMode, type PriceEntry } from '@agentlens/pricing'
import type { DatabaseSync } from 'node:sqlite'
import type { PriceResolver, ServerCtx } from './types.ts'
import { rowsOf } from './resolve.ts'

export interface CostSlice {
  agentId: string
  billingMode: BillingMode
  apiEquivalentUsd: number | null
  actualUsd: number | null
  /** §18 row 1: cost the agent reported for itself (OpenCode/WorkBuddy); null = it logs none. */
  reportedUsd: number | null
  /** §18 row 1 fused: reported-where-reported + priced-where-not, from the cube's cost_total. */
  totalUsd: number | null
}

export interface CostView {
  pricingConfigured: boolean
  apiEquivalentUsd: number | null
  actualUsd: number | null
  reportedUsd: number | null
  /** One number per §18 row 1 priority; null when any slice is unknown (§8, never 0). */
  totalUsd: number | null
  /** True when a per-agent fused slice is null: the total above is a floor, not a total. */
  totalPartial: boolean
  /** True when at least one agent is unpriced: the totals above are floors, not totals. */
  apiEquivalentPartial: boolean
  actualPartial: boolean
  /** Agents whose price is missing: the UI must render n/a, never 0. */
  unpricedAgents: string[]
  perAgent: CostSlice[]
  basis: string
}

function usd(values: (number | null)[]): number | null {
  if (values.length === 0) return null
  if (values.some((v) => v === null)) {
    // Partly unpriced: sum what IS priced but keep the flag so the UI can say
    // "at least $x / n/a for <agents>" instead of presenting a false total (§14).
    return values.reduce<number>((a, v) => a + (v ?? 0), 0)
  }
  return values.reduce<number>((a, v) => a + (v ?? 0), 0)
}

/**
 * §8's billing-mode table applied to an already-priced amount: `api` pays its tokens,
 * `subscription` and `local` pay a flat fee that is not per-token, so their cash is $0
 * while their tokens keep an API-equivalent value. `null` (no price) stays `null` — §8
 * bans reading an unknown price as $0, and a fold that turned `n/a` into free would do it
 * silently for the one agent class this row exists to describe.
 *
 * This is a PROJECTION of the normative statement in `packages/pricing`'s `computeCost`
 * (`mode === 'api' ? api : 0`), which prices one request at a time; a per-agent aggregate
 * has no single `PriceEntry` to hand it, so it cannot call it. `test/cost.test.ts` asserts
 * the two agree for all three modes and both price states, which is what keeps this from
 * becoming §8's third copy.
 */
export function actualUsdFor(apiEquivalentUsd: number | null, mode: BillingMode): number | null {
  if (apiEquivalentUsd === null) return null
  return mode === 'api' ? apiEquivalentUsd : 0
}

export function costView(ctx: ServerCtx, filter?: QueryFilter): CostView {
  // With a DB file, createContext already wired billingModeFor to the `config.json`
  // declarations (§8); this literal 'api' only stands for a DB-less in-process ctx.
  const modeFor = ctx.billingModeFor ?? ((): BillingMode => 'api')
  // One cube call carries all three cost facts (raw reported, priced, and the §18 row 1
  // fusion) so the route pays one stage-1 fold per slice, not three, and the three
  // numbers per agent cannot come from different filter/fold vintages.
  const res = query(
    ctx.db,
    { metrics: ['cost_reported', 'cost_api_equiv', 'cost_total'], dims: ['agent'], filter, totals: false },
    ctx.cubeDeps,
  )
  const reportedTotal = usd(res.rows.map((r) => numOrNull(r.cost_reported)))
  // §18 row 1 NULLs a whole agent's `cost_total` when any of its never-reported slices has no
  // price. That is the right answer for "what did this agent cost", and the wrong one for a
  // headline floor: the same agent may report a real figure for the other requests, and dropping
  // it made the top-line total read *lower* than a number the agent itself logged ($0.2114 shown
  // beside $0.4200 reported), which understates a known cost — §8's worst direction.
  // So the floor falls back to the reported slice per agent, and `totalPartial` keeps saying the
  // rest is unknown rather than pretending the sum is complete.
  const fusedTotal = usd(res.rows.map((r) => costFloor(numOrNull(r.cost_total), numOrNull(r.cost_reported))))
  const fusedPartial = res.rows.some((r) => numOrNull(r.cost_total) === null)
  if (!ctx.priceResolver) {
    return {
      pricingConfigured: false,
      apiEquivalentUsd: null,
      actualUsd: null,
      reportedUsd: reportedTotal,
      totalUsd: fusedTotal,
      totalPartial: fusedPartial,
      apiEquivalentPartial: res.rows.length > 0 && res.rows.some((r) => numOrNull(r.cost_reported) === null),
      actualPartial: false,
      unpricedAgents: [],
      perAgent: res.rows.map((r) => ({
        agentId: String(r.agent ?? ''),
        billingMode: modeFor(String(r.agent ?? '')),
        apiEquivalentUsd: null,
        actualUsd: null,
        reportedUsd: numOrNull(r.cost_reported),
        totalUsd: numOrNull(r.cost_total),
      })),
      basis: 'no price table injected — api-equivalent and actual are n/a (§8: an unknown price must never render as $0); cost_total covers only reported slices',
    }
  }
  const perAgent: CostSlice[] = res.rows.map((r) => {
    const agentId = String(r.agent ?? '')
    const billingMode = modeFor(agentId)
    const api = numOrNull(r.cost_api_equiv)
    return {
      agentId,
      billingMode,
      apiEquivalentUsd: api,
      actualUsd: actualUsdFor(api, billingMode),
      reportedUsd: numOrNull(r.cost_reported),
      totalUsd: numOrNull(r.cost_total),
    }
  })
  return {
    pricingConfigured: true,
    apiEquivalentUsd: usd(perAgent.map((s) => s.apiEquivalentUsd)),
    actualUsd: usd(perAgent.map((s) => s.actualUsd)),
    reportedUsd: reportedTotal,
    totalUsd: fusedTotal,
    totalPartial: fusedPartial,
    apiEquivalentPartial: perAgent.some((s) => s.apiEquivalentUsd === null),
    actualPartial: perAgent.some((s) => s.actualUsd === null),
    unpricedAgents: perAgent.filter((s) => s.apiEquivalentUsd === null).map((s) => s.agentId),
    perAgent,
    basis:
      'cost_total (cube, §18 row 1) = agent-reported cost where the agent reported one + priced tokens for the never-reported part, NULL when neither; api-equivalent = all tokens x price (per-agent §18 fold), actual = billing mode applied to it (subscription/local real cash is 0)',
  }
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}

/** One (provider, model) row of the store, with the buckets its own events spent. */
export interface ModelSpend {
  provider: string
  model: string
  /** When the store last saw this model; `now` when it has no dated event, so §8's effective-date lookup asks today. */
  lastSeen: number
  events: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/**
 * §11's Pricing block reads this join; it lives once here because both surfaces answer from
 * it, and the CLI and the served report used to carry two copies with two `last_seen` rules —
 * which is how the same model could read "missing price" on one screen and priced on the other.
 */
export function modelSpend(db: DatabaseSync, now: number): ModelSpend[] {
  return rowsOf(
    db,
    `SELECT m.provider AS provider, m.name AS name,
            COALESCE(MAX(e.timestamp), ?) AS last_seen, COUNT(e.id) AS events,
            COALESCE(SUM(e.input_tokens), 0) AS input, COALESCE(SUM(e.output_tokens), 0) AS output,
            COALESCE(SUM(e.cache_read_tokens), 0) AS cache_read, COALESCE(SUM(e.cache_write_tokens), 0) AS cache_write,
            COALESCE(SUM(e.reasoning_tokens), 0) AS reasoning
     FROM models m LEFT JOIN events e ON e.model_rowid = m.rowid
     GROUP BY m.rowid`,
    now,
  ).map((r) => ({
    provider: String(r.provider ?? ''),
    model: String(r.name ?? ''),
    lastSeen: Number(r.last_seen ?? now),
    events: Number(r.events ?? 0),
    input: Number(r.input ?? 0),
    output: Number(r.output ?? 0),
    cacheRead: Number(r.cache_read ?? 0),
    cacheWrite: Number(r.cache_write ?? 0),
    reasoning: Number(r.reasoning ?? 0),
  }))
}

/**
 * §8's gap rule, stated once for both surfaces: a model is unpriced when the table has no
 * entry for it at its `last_seen` date, or when a bucket this model's own events actually
 * spent has no price. The token gate is what makes the two halves agree with the cube —
 * `packages/query` skips zero-token buckets, so a model nobody used cannot manufacture an
 * `n/a` — and the `reasoning` clause mirrors `computeCost` exactly: an *absent* reasoning
 * price means "bill those tokens as output", only the `PRICE_MISSING` sentinel is a gap.
 *
 * `test/cost.test.ts` pins this predicate against `computeCost`'s own verdict for every
 * bucket, because `computeCost` is the rule this one describes.
 */
export function unpricedBuckets(entry: PriceEntry | null, m: ModelSpend): string[] {
  if (!entry) return ['price entry']
  const gaps: string[] = []
  if (m.input > 0 && isMissingPrice(entry.inputPerMTok)) gaps.push('input')
  if (m.output > 0 && isMissingPrice(entry.outputPerMTok)) gaps.push('output')
  if (m.cacheRead > 0 && isMissingPrice(entry.cacheReadPerMTok)) gaps.push('cacheRead')
  if (m.cacheWrite > 0 && isMissingPrice(entry.cacheWritePerMTok)) gaps.push('cacheWrite')
  if (m.reasoning > 0 && entry.reasoningPerMTok != null && isMissingPrice(entry.reasoningPerMTok)) gaps.push('reasoning')
  return gaps
}

export interface UnpricedModel extends ModelSpend {
  /** Which of this model's spent buckets have no price; `['price entry']` when the table has no row for it. */
  buckets: string[]
}

/** The one key the §8 gap set and its readers join on; a model name may contain `:`. */
export function unpricedModelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * The §8 unpriced set: the models whose cost the cube renders as `n/a`, never as $0.
 *
 * A SET, keyed the way every reader joins it — `models` is unique on
 * `(provider, name, tier)` while the price lookup ignores tier, so one model behind four
 * tiers is one gap, not four. Handing readers the per-tier rows made the Models banner
 * render the same `(provider, model)` four times, which Svelte rejects as a duplicate
 * `{#each}` key and the count overstates by the tier fan-out.
 */
export function unpricedModels(db: DatabaseSync, priceFor: PriceResolver, now: number): UnpricedModel[] {
  const byKey = new Map<string, UnpricedModel>()
  for (const m of modelSpend(db, now)) {
    const buckets = unpricedBuckets(priceFor(m.provider, m.model, m.lastSeen), m)
    if (buckets.length === 0) continue
    const key = unpricedModelKey(m.provider, m.model)
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, { ...m, buckets })
      continue
    }
    seen.events += m.events
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) seen[f] += m[f]
    seen.lastSeen = Math.max(seen.lastSeen ?? 0, m.lastSeen ?? 0)
    seen.buckets = [...new Set([...seen.buckets, ...buckets])].sort()
  }
  return [...byKey.values()]
}

/** Models present in the data with no price at their last-seen date (§11 pricing gap line). */
export function missingPriceModels(ctx: ServerCtx): { provider: string; model: string; lastSeen: number | null }[] {
  if (!ctx.priceResolver) return []
  return unpricedModels(ctx.db, ctx.priceResolver, ctx.now()).map((m) => ({
    provider: m.provider,
    model: m.model,
    lastSeen: m.lastSeen,
  }))
}
