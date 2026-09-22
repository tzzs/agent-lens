/**
 * GET /api/models — the price-gap surface (§8, §11 Pricing).
 *
 * Model rows come from the cube (deduped tokens + api-equivalent cost); the
 * priced flag comes from the injected price table at each model's last-seen
 * date, because §8 requires historical cost to be reproducible rather than
 * priced-at-today.
 */
import { query } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { costView, missingPriceModels, unpricedModelKey } from './cost.ts'
import { METRICS, numOr } from './metrics.ts'
import { parseFilter } from './request-spec.ts'

export interface ModelRow {
  provider: string
  model: string
  events: number
  sessions: number
  tokensTotal: number
  costApiEquiv: number | null
  /** null = pricing not configured in this build (the UI must not read that as "unpriced"). */
  priced: boolean | null
}

export interface ModelsResponse {
  filter: unknown
  rows: ModelRow[]
  totals: Record<string, number | null>
  truncated: boolean
  pricingConfigured: boolean
  unpriced: { provider: string; model: string; lastSeen: number | null }[]
  cost: ReturnType<typeof costView>
  note: string
}

export function models(ctx: ServerCtx, sp: URLSearchParams): ModelsResponse {
  const filter = parseFilter(sp, ctx.db)
  const res = query(ctx.db, { metrics: [...METRICS], dims: ['provider', 'model'], filter }, ctx.cubeDeps)
  const gaps = missingPriceModels(ctx)
  // One key builder for both sides of the lookup: they used to differ (`::` here, `\u0000`
  // below), so every row read `priced: true` no matter what the §8 gap set said.
  const gapKeys = new Set(gaps.map((g) => unpricedModelKey(g.provider, g.model)))
  return {
    filter,
    rows: res.rows.map((r) => ({
      provider: String(r.provider ?? ''),
      model: String(r.model ?? ''),
      events: Number(r.events ?? 0),
      sessions: Number(r.sessions ?? 0),
      tokensTotal: Number(r.tokens_total ?? 0),
      costApiEquiv: numOr(r.cost_api_equiv),
      priced: ctx.priceResolver ? !gapKeys.has(unpricedModelKey(String(r.provider ?? ''), String(r.model ?? ''))) : null,
    })),
    totals: res.totals,
    truncated: res.truncated,
    pricingConfigured: Boolean(ctx.priceResolver),
    unpriced: gaps,
    cost: costView(ctx, filter),
    note: 'cost shown as n/a when a model has no price: §8 forbids reading an unknown price as $0',
  }
}
