import type { Usage } from '@agentlens/event-model'
import { isMissingPrice, type BillingMode, type PriceEntry } from './price-types.ts'

export interface CostBreakdown {
  actualUsd: number | null
  apiEquivalentUsd: number | null
  mode: BillingMode
  pricedAt: number | null
  gap: boolean
}

const bucketPrices = (u: Usage, e: PriceEntry): number[] => {
  const prices: number[] = [e.inputPerMTok, e.outputPerMTok]
  if (u.cacheReadTokens > 0) prices.push(e.cacheReadPerMTok)
  if (u.cacheWriteTokens > 0) prices.push(e.cacheWritePerMTok)
  // Reasoning tokens only need a dedicated price when litellm lists one; otherwise
  // they are billed as output (Anthropic) — absence is not a gap there.
  if (u.reasoningTokens > 0 && e.reasoningPerMTok != null) prices.push(e.reasoningPerMTok)
  return prices
}

/** Full precision internally; presentation is `formatUsd`'s job. */
export function computeCost(usage: Usage, entry: PriceEntry | null, mode: BillingMode): CostBreakdown {
  if (mode === 'local') {
    return { actualUsd: 0, apiEquivalentUsd: 0, mode, pricedAt: null, gap: false }
  }
  if (!entry || bucketPrices(usage, entry).some(isMissingPrice)) {
    // Unknown price is null, never 0: $0 renders as "free local model" and silently
    // understates spend (§8).
    return { actualUsd: null, apiEquivalentUsd: null, mode, pricedAt: entry?.effectiveFrom ?? null, gap: true }
  }
  // term() keeps zero-token buckets out of the math: 0 x PRICE_MISSING would be NaN.
  const term = (tokens: number, perMTok: number | null | undefined): number =>
    tokens > 0 ? (tokens * (perMTok as number)) / 1_000_000 : 0
  const api =
    term(usage.inputTokens, entry.inputPerMTok) +
    term(usage.outputTokens, entry.outputPerMTok) +
    term(usage.cacheReadTokens, entry.cacheReadPerMTok) +
    term(usage.cacheWriteTokens, entry.cacheWritePerMTok) +
    (entry.reasoningPerMTok != null ? term(usage.reasoningTokens, entry.reasoningPerMTok) : 0)
  // Subscription real cash flow is the flat plan fee, not per-token spend (§8 table).
  const actual = mode === 'subscription' ? 0 : api
  return { actualUsd: actual, apiEquivalentUsd: api, mode, pricedAt: entry.effectiveFrom, gap: false }
}

export function formatUsd(v: number | null): string {
  if (v == null) return 'n/a'
  if (v === 0) return '$0.00'
  const digits = Math.abs(v) < 1 ? 4 : 2
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}
