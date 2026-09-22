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
  /**
   * `openrouter` is the gap-filling fallback (§8): it may price a model no other source
   * prices, never one litellm already does, because OpenRouter's published rate is the price
   * of one routed reseller rather than the vendor list price costs are quoted at.
   */
  source: 'litellm' | 'openrouter' | 'override' | 'manual'
  url?: string
}

export type BillingMode = 'api' | 'subscription' | 'local'

/**
 * Sentinel for "no source has this price". Absent must stay distinguishable
 * from 0: §8 forbids rendering unknown prices as $0 ($0 reads as "free local model").
 */
export const PRICE_MISSING = Number.NaN

export function isMissingPrice(v: number | null | undefined): boolean {
  return v == null || Number.isNaN(v)
}
