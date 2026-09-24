import type { Usage } from '@agentlens/event-model'
import { isMissingPrice, type BillingMode, type PriceEntry } from './price-types.ts'

/** A calendar month averaged, so a monthly fee prorates against a 31-day window and a 28-day one alike. */
export const DAYS_PER_MONTH = 365.25 / 12

/**
 * The plan fee spread over the window being priced, or `null` when there is nothing to spread.
 *
 * A subscription is paid for a PERIOD, so it answers only to an aggregate over a known window:
 * one request is not a billing period, and a fraction of a monthly fee attached to a single
 * generation would be a number that merely looks like an answer.
 */
export function planCostFor(
  mode: BillingMode,
  plan?: { planUsdPerMonth: number | null; windowDays: number | null },
): number | null {
  if (mode !== 'subscription' || !plan) return null
  const { planUsdPerMonth, windowDays } = plan
  if (planUsdPerMonth === null || windowDays === null) return null
  return planUsdPerMonth * (windowDays / DAYS_PER_MONTH)
}

/**
 * §8's one statement of what cash a priced amount costs, at whatever grain calls it.
 *
 * `api` pays its tokens. `subscription` and `local` pay nothing PER TOKEN — that $0 is real, and
 * it is what `cost_total` prices an unreported slice of a plan-covered request at, so changing it
 * to "unknown" would NULL the fusion for every subscription agent.
 *
 * What a plan does cost is its fee, and that is a period amount rather than a token amount. An
 * aggregate therefore passes the window and the declared fee, and the fee rides ON TOP of the
 * $0 marginal cash; `packages/server/src/cost.ts` reports both halves separately so a surface can
 * say "本次用量不额外计费（月费未填）" instead of quietly presenting $0 as the whole bill.
 */
export function actualUsdFor(
  apiEquivalentUsd: number | null,
  mode: BillingMode,
  plan?: { planUsdPerMonth: number | null; windowDays: number | null },
): number | null {
  // Unknown price stays unknown in every mode: declaring a mode is not a price (§8).
  if (apiEquivalentUsd === null) return null
  if (mode === 'api') return apiEquivalentUsd
  return planCostFor(mode, plan) ?? 0
}

export interface CostBreakdown {
  /** Cash the mode actually costs: token cash for `api`, no marginal cash for a plan or local run; null when unpriced. */
  actualUsd: number | null
  /** tokens x list price in every mode — §8's "equivalent API value", shown beside actual. */
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
  if (!entry || bucketPrices(usage, entry).some(isMissingPrice)) {
    // Unknown price is null, never 0: $0 renders as "free local model" and silently
    // understates spend (§8). That holds in every mode, `local` included — declaring a
    // mode is not a price.
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
  // §8's table, through its one owner. No window is passed because one request is not a
  // billing period: a subscription's cash is a plan fee over a month, which only an
  // aggregate can prorate (`packages/server/src/cost.ts` does that at its own grain).
  const actual = actualUsdFor(api, mode)
  return { actualUsd: actual, apiEquivalentUsd: api, mode, pricedAt: entry.effectiveFrom, gap: false }
}

export function formatUsd(v: number | null): string {
  if (v == null) return 'n/a'
  if (v === 0) return '$0.00'
  const digits = Math.abs(v) < 1 ? 4 : 2
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}
