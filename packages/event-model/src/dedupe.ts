/**
 * §1.5-1 / §3.1 aggregation invariant — the single most important correctness rule.
 *
 * One upstream API response is split into several log records per content block,
 * and every duplicate record carries the SAME usage object. A plain SUM over
 * events inflates token counts (~1.87x on the measured machine). The verified
 * correct semantics (0.0% deviation vs ccusage over 15 days, see
 * docs/research/claude-code.md §五) are: group by `request_id`, take the
 * element-wise MAX per token field inside the group, then SUM across groups.
 */
import type { AgentEvent, Usage } from './types.ts'

export const ZERO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
})

export interface RequestUsage {
  requestId: string | null
  usage: Usage
  eventIds: string[]
}

function copyUsage(u: Usage): Usage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    reasoningTokens: u.reasoningTokens,
  }
}

function maxUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
  }
}

export function sumUsage(usages: readonly Usage[]): Usage {
  const total = copyUsage(ZERO_USAGE)
  for (const u of usages) {
    total.inputTokens += u.inputTokens
    total.outputTokens += u.outputTokens
    total.cacheReadTokens += u.cacheReadTokens
    total.cacheWriteTokens += u.cacheWriteTokens
    total.reasoningTokens += u.reasoningTokens
  }
  return total
}

/**
 * Groups events by `request_id` and reduces each group's usage to the
 * element-wise max. Events with a null/undefined `request_id` each form their
 * own group (keyed by event id) so they are never dropped nor multiplied.
 */
export function dedupeByRequestId(events: readonly AgentEvent[]): RequestUsage[] {
  interface Group {
    requestId: string | null
    usage: Usage
    hasUsage: boolean
    eventIds: string[]
  }
  const groups = new Map<string, Group>()
  for (const e of events) {
    const hasRequest = e.requestId != null && e.requestId !== ''
    const key = hasRequest ? `\u0000r\u0000${e.requestId}` : `\u0000e\u0000${e.id}`
    let g = groups.get(key)
    if (!g) {
      g = { requestId: hasRequest ? (e.requestId as string) : null, usage: copyUsage(ZERO_USAGE), hasUsage: false, eventIds: [] }
      groups.set(key, g)
    }
    g.eventIds.push(e.id)
    if (e.usage) {
      g.usage = g.hasUsage ? maxUsage(g.usage, e.usage) : copyUsage(e.usage)
      g.hasUsage = true
    }
  }
  return [...groups.values()].map((g) => ({ requestId: g.requestId, usage: g.usage, eventIds: g.eventIds }))
}

function grandTotal(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
}

/**
 * Reports both the deduped aggregate and the naive per-event sum so callers
 * (doctor, §11 "request_id dedup active") can show how much inflation was
 * avoided. inflationRatio = naive total / deduped total (1 when deduped is 0).
 */
export function aggregateRequestTokens(events: readonly AgentEvent[]): {
  deduped: Usage
  naive: Usage
  inflationRatio: number
} {
  const naive = sumUsage(events.flatMap((e) => (e.usage ? [e.usage] : [])))
  const deduped = sumUsage(dedupeByRequestId(events).map((g) => g.usage))
  const d = grandTotal(deduped)
  return { deduped, naive, inflationRatio: d === 0 ? 1 : grandTotal(naive) / d }
}
