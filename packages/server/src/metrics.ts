/**
 * Shared cube-row shaping: metric names are the §7 whitelist, so the entity
 * pages all ask for the same columns and cannot disagree about what "tokens"
 * means. Cost stays `null` when unpriced (§8) — this helper never coerces it to 0.
 */
import type { Metric, Row } from '@agentlens/query'

/** Metrics whose NULL is a fact, so `metricFields` must not coerce it into a measured 0. */
const NULLABLE_METRICS: readonly string[] = [
  // No computed figure exists for an unpriced model (§8: n/a, never $0).
  'cost_api_equiv',
  'cost_reported',
  // §18 rows 1-2: no credit economy at all is not "burned zero credits".
  'credits',
]

export const METRICS = [
  'events',
  'sessions',
  'tokens_total',
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'tokens_reasoning',
  'duration',
  'cost_api_equiv',
  /** §18 row 1: cost the agent itself logged; never added to the api-equivalent figure. */
  'cost_reported',
  /** §18 rows 1-2: plan credits, the only usage signal a credit-billed agent writes. Not dollars. */
  'credits',
] as const satisfies readonly Metric[]

export function numOr(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}

export function metricFields(r: Row): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const m of METRICS) out[m] = NULLABLE_METRICS.includes(m) ? numOr(r[m]) : Number(r[m] ?? 0)
  return out
}
