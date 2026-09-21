/**
 * §8 billing modes as a read model.
 *
 * The cube exposes one cost metric — `cost_api_equiv` — because that is the
 * only number derivable from tokens alone. "Actual cash" is a property of the
 * agent's declared billing mode, not of the tokens, so the server folds the
 * cube's per-agent API-equivalent through §8's table:
 *
 *   api          -> actual = api-equivalent
 *   subscription -> actual = 0 (the plan fee is flat, not per-token)
 *   local        -> actual = 0 (tokens have a notional price, cost is zero)
 *
 * An unpriced slice stays `null`: §8 bans reading an unknown price as $0.
 */
import { query, type QueryFilter } from '@agentlens/query'
import type { BillingMode } from '@agentlens/pricing'
import type { ServerCtx } from './types.ts'
import { rowsOf } from './resolve.ts'

export interface CostSlice {
  agentId: string
  billingMode: BillingMode
  apiEquivalentUsd: number | null
  actualUsd: number | null
  /** §18 row 1: cost the agent reported for itself (OpenCode/WorkBuddy); null = it logs none. */
  reportedUsd: number | null
}

export interface CostView {
  pricingConfigured: boolean
  apiEquivalentUsd: number | null
  actualUsd: number | null
  reportedUsd: number | null
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

export function costView(ctx: ServerCtx, filter?: QueryFilter): CostView {
  const modeFor = ctx.billingModeFor ?? ((): BillingMode => 'api')
  // §18 row 1: reported cost needs no price table, so it is folded even when
  // pricing is not configured — it is the agent's own number, not ours.
  const reported = query(ctx.db, { metrics: ['cost_reported'], dims: ['agent'], filter }, ctx.cubeDeps)
  const reportedByAgent = new Map(reported.rows.map((r) => [String(r.agent), numOrNull(r.cost_reported)]))
  const reportedTotal = usd([...reportedByAgent.values()])
  if (!ctx.priceResolver) {
    return {
      pricingConfigured: false,
      apiEquivalentUsd: null,
      actualUsd: null,
      reportedUsd: reportedTotal,
      apiEquivalentPartial: reportedByAgent.size > 0 && [...reportedByAgent.values()].some((v) => v === null),
      actualPartial: false,
      unpricedAgents: [],
      perAgent: [...reportedByAgent.keys()].map((agentId) => ({
        agentId,
        billingMode: modeFor(agentId),
        apiEquivalentUsd: null,
        actualUsd: null,
        reportedUsd: reportedByAgent.get(agentId) ?? null,
      })),
      basis: 'no price table injected — api-equivalent and actual are n/a (§8: an unknown price must never render as $0)',
    }
  }
  const res = query(ctx.db, { metrics: ['cost_api_equiv'], dims: ['agent'], filter }, ctx.cubeDeps)
  const perAgent: CostSlice[] = res.rows.map((r) => {
    const agentId = String(r.agent ?? '')
    const billingMode = modeFor(agentId)
    const api = r.cost_api_equiv === null || r.cost_api_equiv === undefined ? null : Number(r.cost_api_equiv)
    return {
      agentId,
      billingMode,
      apiEquivalentUsd: api,
      actualUsd: api === null ? null : billingMode === 'api' ? api : 0,
      reportedUsd: reportedByAgent.get(agentId) ?? null,
    }
  })
  return {
    pricingConfigured: true,
    apiEquivalentUsd: usd(perAgent.map((s) => s.apiEquivalentUsd)),
    actualUsd: usd(perAgent.map((s) => s.actualUsd)),
    reportedUsd: reportedTotal,
    apiEquivalentPartial: perAgent.some((s) => s.apiEquivalentUsd === null),
    actualPartial: perAgent.some((s) => s.actualUsd === null),
    unpricedAgents: perAgent.filter((s) => s.apiEquivalentUsd === null).map((s) => s.agentId),
    perAgent,
    basis:
      'api-equivalent = tokens x price (cube, per-agent §18 fold); actual = billing mode applied to it (subscription/local real cash is 0); reported = the agent own cost field when it has one',
  }
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}

/** Models present in the data with no price at their last-seen date (§11 pricing gap line). */
export function missingPriceModels(
  ctx: ServerCtx,
): { provider: string; model: string; lastSeen: number | null }[] {
  if (!ctx.priceResolver) return []
  const rows = rowsOf(
    ctx.db,
    `SELECT m.provider AS provider, m.name AS name,
            (SELECT MAX(e.timestamp) FROM events e WHERE e.model_rowid = m.rowid) AS last_seen
     FROM models m`,
  )
  return rows
    .filter((r) => ctx.priceResolver!(String(r.provider ?? ''), String(r.name ?? ''), Number(r.last_seen ?? ctx.now())) === null)
    .map((r) => ({
      provider: String(r.provider ?? ''),
      model: String(r.name ?? ''),
      lastSeen: r.last_seen === null || r.last_seen === undefined ? null : Number(r.last_seen),
    }))
}
