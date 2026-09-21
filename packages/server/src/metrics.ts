/**
 * Shared cube-row shaping: metric names are the §7 whitelist, so the entity
 * pages all ask for the same columns and cannot disagree about what "tokens"
 * means. Cost stays `null` when unpriced (§8) — this helper never coerces it to 0.
 */
import type { Metric, Row } from '@agentlens/query'

const COST_METRICS: readonly string[] = ['cost_api_equiv', 'cost_reported']

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
] as const satisfies readonly Metric[]

export function numOr(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}

export function metricFields(r: Row): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const m of METRICS) out[m] = COST_METRICS.includes(m) ? numOr(r[m]) : Number(r[m] ?? 0)
  return out
}
