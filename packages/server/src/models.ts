/**
 * GET /api/models — the price-gap surface (§8, §11 Pricing).
 *
 * Model rows come from the cube (deduped tokens + api-equivalent cost); the `priced` flag and
 * the `priceSource` provenance marker come from the injected price table at each model's
 * last-seen date, because §8 requires historical cost to be reproducible rather than
 * priced-at-today. One `modelPrices` pass answers the rows and the gap list together, so the
 * two views of that resolution cannot contradict each other (§14).
 */
import { query } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { costView, gappedModels, modelPrices, priceVerdictsByModel, unpricedModelKey } from './cost.ts'
import { METRICS, numOr } from './metrics.ts'
import { parseFilter } from './request-spec.ts'
import type { ModelNoteCode } from './notes.ts'

export interface ModelRow {
  provider: string
  model: string
  events: number
  sessions: number
  tokensTotal: number
  costApiEquiv: number | null
  /** null = pricing not configured in this build (the UI must not read that as "unpriced"). */
  priced: boolean | null
  /**
   * Which price source stands behind `costApiEquiv` at the model's last-seen date (§8), or
   * null when pricing is off or the resolution did not describe this model. `openrouter`
   * means the number is a reseller route price, not the vendor list price.
   */
  priceSource: 'litellm' | 'openrouter' | 'override' | 'manual' | null
}

export interface ModelsResponse {
  filter: unknown
  rows: ModelRow[]
  totals: Record<string, number | null>
  truncated: boolean
  pricingConfigured: boolean
  unpriced: { provider: string; model: string; lastSeen: number | null }[]
  cost: ReturnType<typeof costView>
  noteCode: ModelNoteCode
}

export function models(ctx: ServerCtx, sp: URLSearchParams): ModelsResponse {
  const filter = parseFilter(sp, ctx.db)
  const res = query(ctx.db, { metrics: [...METRICS], dims: ['provider', 'model'], filter }, ctx.cubeDeps)
  const prices = ctx.priceResolver ? modelPrices(ctx.db, ctx.priceResolver, ctx.now()) : null
  const verdicts = priceVerdictsByModel(prices ?? [])
  return {
    filter,
    rows: res.rows.map((r) => {
      const provider = String(r.provider ?? '')
      const model = String(r.model ?? '')
      const verdict = verdicts.get(unpricedModelKey(provider, model))
      return {
        provider,
        model,
        events: Number(r.events ?? 0),
        sessions: Number(r.sessions ?? 0),
        tokensTotal: Number(r.tokens_total ?? 0),
        costApiEquiv: numOr(r.cost_api_equiv),
        // Not being described by the resolution is not a gap either — same verdict the
        // gap-set membership gave, kept so this route cannot start reporting a hole as a price.
        priced: prices === null ? null : verdict?.gapped !== true,
        priceSource: verdict?.source ?? null,
      }
    }),
    totals: res.totals,
    truncated: res.truncated,
    pricingConfigured: Boolean(ctx.priceResolver),
    unpriced: (prices ? gappedModels(prices) : []).map((m) => ({ provider: m.provider, model: m.model, lastSeen: m.lastSeen })),
    cost: costView(ctx, filter),
    noteCode: 'naMeansUnpriced',
  }
}
