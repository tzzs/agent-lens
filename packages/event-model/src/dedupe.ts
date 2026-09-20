/**
 * §1.5-1 + §18 row 2 — the single most important correctness rule, now per-adapter.
 *
 * Claude Code (and its fork Qoder) split one upstream API response into several log
 * records per content block, and every duplicate record carries the SAME usage object.
 * A plain SUM over those events inflates token counts (~1.87x on the measured machine).
 * The verified rule for THAT family (0.0% deviation vs ccusage over 15 days, see
 * docs/research/claude-code.md §五) is: group by `request_id`, take the element-wise MAX
 * per token field inside the group, then SUM across groups.
 *
 * §18 measured that this is NOT a global invariant: Codex does not duplicate usage. Its
 * trap is granularity — per-call `last_token_usage`/`usage` rows sit next to cumulative
 * `total`/`turn`/`thread` fields, and folding the cumulative field inflates ~1971x. The
 * correct Codex rule is a plain sum over per-call rows. So the fold is declared per
 * adapter via `AggregationPolicy`; `request_max` remains the conservative default for
 * anything that has not declared itself.
 */
import type { AgentEvent, AggregationMode, AggregationPolicy, Usage } from './types.ts'

/** The §18 fold used when an adapter has not declared one: the most conservative rule. */
export const DEFAULT_AGGREGATION: AggregationPolicy = Object.freeze({
  mode: 'request_max',
  subagentsIncluded: true,
})

export const AGGREGATION_MODES: readonly AggregationMode[] = ['request_max', 'per_record_sum', 'last_call_sum']

/** §18: an unrecognized mode must abort the query, never silently degrade to another fold. */
export class UnknownAggregationError extends Error {
  override readonly name = 'UnknownAggregationError'
  constructor(mode: string) {
    super(
      `unknown aggregation mode ${JSON.stringify(mode)}; known modes: ${AGGREGATION_MODES.join(', ')}`,
    )
  }
}

export function assertAggregationMode(mode: string): AggregationMode {
  if (!(AGGREGATION_MODES as readonly string[]).includes(mode)) throw new UnknownAggregationError(mode)
  return mode as AggregationMode
}

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
  return groupEvents(events).map((g) => ({ requestId: g.requestId, usage: g.usage, eventIds: g.eventIds }))
}

interface Group {
  requestId: string | null
  usage: Usage
  hasUsage: boolean
  eventIds: string[]
}

/** Shared folding kernel for `dedupeByRequestId` and the `request_max` policy. */
function groupEvents(events: readonly AgentEvent[]): Group[] {
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
  return [...groups.values()]
}

export interface UsageAggregate {
  usage: Usage
  /** How many folded rows produced the total: 1 per request group, or 1 per usage row. */
  groups: number
  mode: AggregationMode
}

/**
 * §18: folds events into a token total under an adapter-declared policy.
 *
 * - `request_max`: MAX per `request_id`, then SUM (Claude Code / Qoder).
 * - `per_record_sum`: SUM every usage row (Codex's per-call rows).
 * - `last_call_sum`: identical to `per_record_sum` AT THIS LAYER on purpose. Codex's
 *   cumulative `total`/`turn`/`thread` granularity is resolved by the ADAPTER, which must
 *   already have converted it into per-call `usage` rows; letting this layer "re-add" the
 *   cumulative fields is exactly the ~1971x error §18 measured. Declaring
 *   `last_call_sum` therefore records intent, it does not change arithmetic.
 *
 * Events with no usage are ignored by every mode. `policy.subagentsIncluded` is NOT
 * filtered here: this function folds the rows it is handed, and the caller (the cube, or
 * `agentlens` commands) applies the explicit subagent switch via `isSubagentThreadEvent`.
 * An unknown mode throws rather than falling back, because a silent fallback is how a
 * number goes wrong without anyone noticing.
 */
export function aggregateUsage(
  events: readonly AgentEvent[],
  policy: AggregationPolicy = DEFAULT_AGGREGATION,
): UsageAggregate {
  const mode = assertAggregationMode(policy.mode)
  if (mode === 'request_max') {
    const groups = groupEvents(events).filter((g) => g.hasUsage)
    return { usage: sumUsage(groups.map((g) => g.usage)), groups: groups.length, mode }
  }
  const rows = events.filter((e) => e.usage).map((e) => e.usage as Usage)
  return { usage: sumUsage(rows), groups: rows.length, mode }
}

/** metadata may be an object (in-memory events) or JSON text (rows read from SQLite). */
function metadataOf(e: AgentEvent): Record<string, unknown> | null {
  const raw = e.metadata as Record<string, unknown> | string | null | undefined
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return typeof raw === 'object' ? raw : null
}

/**
 * The marker adapters set on a source thread that is a subagent (257 of Codex's 379
 * thread files, §18 row 2/3). ccusage reconciliation excludes these from headline
 * totals, so the query layer filters on this predicate BEFORE folding.
 */
export function isSubagentThreadEvent(e: AgentEvent): boolean {
  return metadataOf(e)?.subagentThread === true
}

function grandTotal(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
}

/**
 * Reports both the `request_max` (deduped) aggregate and the naive per-event sum so
 * callers (doctor, §11 "request_id dedup active") can show how much inflation was
 * avoided. inflationRatio = naive total / deduped total (1 when deduped is 0).
 * This is the Claude Code / Qoder rule only — §18: use `aggregateUsage` with the
 * adapter's policy when the agent may not duplicate usage.
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
