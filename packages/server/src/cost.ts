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
import { costFloor, costPortionsByAgent, query, windowDaysOf, type QueryFilter } from '@agentlens/query'
import { actualUsdFor, isMissingPrice, parseModelKey, planCostFor, type BillingMode, type PriceEntry } from '@agentlens/pricing'
import type { DatabaseSync } from 'node:sqlite'
import type { PriceResolver, ServerCtx } from './types.ts'
import { rowsOf } from './resolve.ts'
import type { CostBasisCode } from './notes.ts'

export interface CostSlice {
  agentId: string
  billingMode: BillingMode
  apiEquivalentUsd: number | null
  actualUsd: number | null
  /** §18 row 1: cost the agent reported for itself (OpenCode/WorkBuddy); null = it logs none. */
  reportedUsd: number | null
  /** §8 cash attributable to a declared plan fee, prorated over this window; null = nothing to count. */
  planCostUsd: number | null
  /** True when this agent's models do not all bill at `billingMode`, so a single label would mislead. */
  mixedBilling: boolean
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
  basisCode: CostBasisCode
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
 * §8's billing-mode table, called straight from its owner in `@agentlens/pricing` rather than
 * restated here. It used to be a projection written a second time, because a per-agent aggregate
 * has no single `PriceEntry` to hand `computeCost`; that made two files hold one rule, and the
 * only thing keeping them honest was a test comparing them. There is now one implementation, and
 * what this file adds is the per-(agent, model) fold around it, which is a different question.
 */
export { actualUsdFor, planCostFor }

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
  // §18 row 1 NULLs a whole agent's cost when any of its never-reported slices has no price.
  // That is the right answer to "what did this agent cost" and a bad one for a floor: the rest
  // of that agent's tokens ARE priced, and a headline that drops them printed `≥ $0.00` next to
  // a Models table showing $3.20 for the same rows — an under-read of a known amount, which is
  // §8's worst direction and the one §19 already fixed for the reported slice.
  // So when any agent-grain fact is missing, the same metrics fold once more at model grain and
  // the knowable portion becomes the floor. A complete answer still passes through untouched
  // (a `subscription` agent's real $0 must not be rewritten into "unknown"), and every fallback
  // keeps its `*Partial` flag, so the number stays a floor rather than pretending to be a total.
  // Two different "something is missing" sets: an agent whose *price* is absent (what the UI
  // calls unpriced, and what makes api-equivalent/actual a partial figure), and an agent whose
  // fused total is NULL (which also loses the priced part of it from the headline floor).
  const gappedAgents = ctx.priceResolver
    ? res.rows.filter((r) => numOrNull(r.cost_api_equiv) === null).map((r) => String(r.agent ?? ''))
    : []
  // Cash resolves per (agent, model) now, so the model rows are needed on every priced read,
  // not only on a gapped one. They ride the SAME stage-1 materialisation the agent-grain query
  // above used (`fold-cache.ts` shares one per request), so this is one more stage-2 scan and
  // not one more fold over `events`.
  const portion = ctx.priceResolver ? costPortionsByAgent(ctx.db, filter, ctx.cubeDeps) : new Map()
  // The plan fee, prorated over exactly the window being priced, and counted once per agent:
  // the fee buys the plan, so two of its models must not double it. `null` = nothing to count
  // (not on a plan, no fee declared, or a window with no known end — an unknown period is not a
  // zero-length one, and prorating over "all time" would print one month's fee as the whole
  // history's bill).
  const planCostForAgent = (agentId: string, onPlan: boolean): number | null => {
    if (!onPlan || !ctx.billingPlanFor) return null
    const perMonth = ctx.billingPlanFor(agentId)
    if (perMonth === null) return null
    return planCostFor('subscription', {
      planUsdPerMonth: perMonth,
      windowDays: windowDaysOf(filter, ctx.now()),
    })
  }
  const fusedTotal = usd(
    res.rows.map((r) => {
      const strict = numOrNull(r.cost_total)
      const reported = numOrNull(r.cost_reported)
      const share = portion.get(String(r.agent ?? ''))?.total
      // Rungs, widest-first in trust: the complete fused answer, then the priced portion of it,
      // then only what the agent itself logged.
      return costFloor(costFloor(strict, share), reported)
    }),
  )
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
        planCostUsd: null,
        mixedBilling: false,
        reportedUsd: numOrNull(r.cost_reported),
        totalUsd: numOrNull(r.cost_total),
      })),
      basisCode: 'noPriceTable',
    }
  }
  const perAgent: CostSlice[] = res.rows.map((r) => {
    const agentId = String(r.agent ?? '')
    const billingMode = modeFor(agentId)
    const apiStrict = numOrNull(r.cost_api_equiv)
    const slice = portion.get(agentId)
    // The priced portion of a gapped agent, never a guess at the rest of it.
    const api = apiStrict ?? slice?.api ?? null
    // Cash is summed per model because a billing mode now is per model: one Claude install on a
    // subscription with a metered model has to cost the plan's fee PLUS that model's tokens, and
    // folding the agent first would apply whichever mode happened to be the default to both.
    // `apiStrict` non-null means every model priced out, so the model rows cover the same money.
    const modes = slice
      ? [...slice.models.keys()].map((key) => modeFor(agentId, ...parseModelKey(key)))
      : [billingMode]
    const marginal = slice
      ? usd([...slice.models.values()].map((share, i) => actualUsdFor(share.api, modes[i]!)))
      : actualUsdFor(api, billingMode)
    const planCostUsd = planCostForAgent(agentId, modes.includes('subscription'))
    return {
      agentId,
      billingMode,
      apiEquivalentUsd: api,
      // A plan's cash is not its tokens priced — that is the $0 marginal answer above. It is the
      // fee, counted once per agent here, because the fee buys the plan and not a seat per model.
      actualUsd: marginal === null ? null : marginal + (planCostUsd ?? 0),
      planCostUsd,
      mixedBilling: new Set(modes).size > 1,
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
    apiEquivalentPartial: gappedAgents.length > 0 || perAgent.some((s) => s.apiEquivalentUsd === null),
    actualPartial: gappedAgents.length > 0 || perAgent.some((s) => s.actualUsd === null),
    unpricedAgents: gappedAgents,
    perAgent,
    basisCode: 'fusedFormula',
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

/** A model priced at its own last-seen date, plus who answered. */
export interface ModelPrice extends ModelSpend {
  buckets: string[]
  /**
   * Which source the table answered with (§8), or null when it answered nothing. A model the
   * resolution never saw carries no provenance either way: the row is not "litellm-priced",
   * it is simply not described by this pass.
   */
  source: PriceEntry['source'] | null
}

/** The one key the §8 gap set and its readers join on; a model name may contain `:`. */
export function unpricedModelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * The single pass that answers "what is this model's price, and where did it come from".
 * Both halves of `/api/models` — each row's `priced`/`priceSource` and the `unpriced` list —
 * read it, because they are two views of one resolution and a second lookup per surface is
 * exactly how the same model came to read priced on one screen and gapped on another (§14).
 */
export function modelPrices(db: DatabaseSync, priceFor: PriceResolver, now: number): ModelPrice[] {
  return modelSpend(db, now).map((m) => {
    const entry = priceFor(m.provider, m.model, m.lastSeen)
    return { ...m, buckets: unpricedBuckets(entry, m), source: entry?.source ?? null }
  })
}

/** The §8 gap predicate, stated once: a row whose spent buckets lack a price. */
export function isGapped(m: { buckets: string[] }): boolean {
  return m.buckets.length > 0
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
export function gappedModels(prices: readonly ModelPrice[]): ModelPrice[] {
  const byKey = new Map<string, ModelPrice>()
  for (const m of prices) {
    if (!isGapped(m)) continue
    const key = unpricedModelKey(m.provider, m.model)
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, { ...m, buckets: m.buckets })
      continue
    }
    seen.events += m.events
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) seen[f] += m[f]
    seen.lastSeen = Math.max(seen.lastSeen ?? 0, m.lastSeen ?? 0)
    seen.buckets = [...new Set([...seen.buckets, ...m.buckets])].sort()
  }
  return [...byKey.values()]
}

/**
 * The same join, for the rows: a model behind several tiers is gapped when ANY tier row is
 * (each tier row only spent its own tokens, so only it can be missing that bucket's price),
 * and it has one source because the lookup that answered it ignores tier.
 */
export function priceVerdictsByModel(
  prices: readonly ModelPrice[],
): Map<string, { gapped: boolean; source: PriceEntry['source'] | null }> {
  const out = new Map<string, { gapped: boolean; source: PriceEntry['source'] | null }>()
  for (const m of prices) {
    const key = unpricedModelKey(m.provider, m.model)
    const seen = out.get(key) ?? { gapped: false, source: null }
    out.set(key, { gapped: seen.gapped || isGapped(m), source: seen.source ?? m.source })
  }
  return out
}

/** The §8 unpriced set, from a fresh resolution (§11's pricing gap line). */
export function unpricedModels(db: DatabaseSync, priceFor: PriceResolver, now: number): UnpricedModel[] {
  return gappedModels(modelPrices(db, priceFor, now))
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
