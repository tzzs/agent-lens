export interface PriceEntry {
  provider: string
  model: string
  tier?: string | null
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
  reasoningPerMTok?: number | null
  /** ms epoch; lookup picks the greatest effectiveFrom <= occurredAt (§8: historical cost must be reproducible). */
  effectiveFrom: number
  source: 'litellm' | 'override' | 'manual'
  url?: string
}

export type BillingMode = 'api' | 'subscription' | 'local'

/**
 * Sentinel for "litellm has no such price". Absent must stay distinguishable
 * from 0: §8 forbids rendering unknown prices as $0 ($0 reads as "free local model").
 */
export const PRICE_MISSING = Number.NaN

export function isMissingPrice(v: number | null | undefined): boolean {
  return v == null || Number.isNaN(v)
}
