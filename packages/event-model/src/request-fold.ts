/**
 * §3.1 + §18 row 2 stage 1, stated ONCE.
 *
 * Stage 1 — collapse the events of one API response into one row, per the agent's own
 * aggregation policy — used to exist only as SQL generated inside the cube. §19's scale
 * measurement (343k events: 2.86 s to build the temporary B-tree, 2.57 s to re-attach the
 * dimensions) asks for the same fold to be *persisted* and maintained by the write path,
 * which means two consumers now need the identical rule: the reader that folds on the fly
 * and the writer that keeps `requests` in step with `events`. Two hand-written copies of a
 * fold is exactly the failure class §14 records, so the vocabulary lives here, below both.
 *
 * What is deliberately NOT here: any price. `cost_total`'s priced half depends on the
 * CURRENT price table (`agl pricing update` can move it), which is the same reason §19 kept
 * `pricing_gap` derived rather than stored. The table carries only the folded *reported*
 * cost (`rep_cost`), a fact about the row, and the cube still computes money at read time.
 */
import type { AggregationMode, AggregationPolicy } from './types.ts'
import { assertAggregationMode, DEFAULT_AGGREGATION } from './dedupe.ts'

/**
 * Which column a mode keys its request group on. `request_max` folds a whole API response
 * (one `request_id`, repeated usage per content block); the sum modes must NOT collapse
 * anything — Codex's cumulative fields inflate ~1971x if they do (§18 row 2) — so at that
 * layer a per-call row is already one usage row and keys on its own event id.
 */
export const REQUEST_KEY_KIND: Record<AggregationMode, 'request' | 'event'> = Object.freeze({
  request_max: 'request',
  per_record_sum: 'event',
  last_call_sum: 'event',
})

/**
 * The stage-1 grouping key for one mode, as SQL over the `events` alias. Rows with no
 * usable `request_id` key on their own id, so each is a group of one: counted exactly once,
 * never merged with another NULL row (§3.1's fallback).
 */
export function requestKeySql(alias: string, mode: AggregationMode): string {
  return REQUEST_KEY_KIND[assertAggregationMode(mode)] === 'request'
    ? `COALESCE(NULLIF(${alias}.request_id, ''), ${alias}.id)`
    : `${alias}.id`
}

/** The mode an absent policy declaration folds under (§18: the conservative Claude rule). */
export const DEFAULT_FOLD_MODE: AggregationMode = DEFAULT_AGGREGATION.mode

/**
 * The folded values stage 1 produces per request row, in table order. The token/duration
 * buckets are `MAX(COALESCE(col, 0))` (NULL is "no data on this row", not a zero group) and
 * `rep_cost` is `MAX(col)` keeping NULL distinct from 0 (§8/§18 row 1).
 */
export const REQUEST_FOLD_VALUE_COLUMNS = [
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'tokens_cache_write',
  'tokens_reasoning',
  'duration',
  'rep_cost',
] as const
export type RequestFoldValueColumn = (typeof REQUEST_FOLD_VALUE_COLUMNS)[number]

/** Events column each token bucket folds from. */
export const REQUEST_FOLD_TOKEN_SOURCE: Record<string, string> = Object.freeze({
  tokens_input: 'input_tokens',
  tokens_output: 'output_tokens',
  tokens_cache_read: 'cache_read_tokens',
  tokens_cache_write: 'cache_write_tokens',
  tokens_reasoning: 'reasoning_tokens',
})

/**
 * The representative row's columns a materialised fold must keep: every `events` column any
 * §7 dim expression reads, plus `model_rowid` so `provider`/`model` still join to `models`
 * the same way the inline path does. `type` and `metadata` are filter-only and never a dim,
 * so they stay out — which is also why a `metadata`-based filter (§18's subagent switch)
 * cannot be served by the persisted table and keeps folding live.
 */
export const REQUEST_FOLD_DIM_COLUMNS = [
  'timestamp',
  'agent_id',
  'host_id',
  'project_id',
  'session_id',
  'thread_id',
  'capability_type',
  'capability_name',
  'status',
  'usage_source',
  'model_rowid',
] as const
export type RequestFoldDimColumn = (typeof REQUEST_FOLD_DIM_COLUMNS)[number]

/** The grouping/provenance columns: PK, the rep row's id, and the time-window certificate. */
export const REQUEST_FOLD_KEY_COLUMNS = ['agent_key', 'req_key', 'rep_id'] as const

/**
 * Certificate columns (§4.2/§6): the group's member count, how many of them carry a real
 * timestamp, and the span those timestamps cover. A window filter can be answered from the
 * materialised row only when the group lies ENTIRELY inside the window — a request whose
 * content blocks straddle the cutoff must be folded from `events` like anyone else's, and a
 * group with a NULL timestamp is never wholly inside a window that filters on one.
 */
export const REQUEST_FOLD_SPAN_COLUMNS = ['member_count', 'ts_count', 'min_ts', 'max_ts'] as const

/** Every column of the materialised stage-1 table, in declaration order. */
export const REQUEST_FOLD_COLUMNS: readonly string[] = [
  ...REQUEST_FOLD_KEY_COLUMNS,
  ...REQUEST_FOLD_VALUE_COLUMNS,
  ...REQUEST_FOLD_SPAN_COLUMNS,
  ...REQUEST_FOLD_DIM_COLUMNS,
]

/**
 * Identity of a grouping: which agents fold on what. `requests` rows are only valid for the
 * policy map they were built under, so both the writer and the reader compute this from the
 * map they actually use and refuse to disagree silently. Agents absent from the map fold
 * under `DEFAULT_FOLD_MODE`, which is a constant and needs no entry.
 */
export function foldPolicyFingerprint(aggregation?: Record<string, AggregationPolicy>): string {
  return Object.entries(aggregation ?? {})
    .filter(([, policy]) => policy && assertAggregationMode(policy.mode) !== DEFAULT_FOLD_MODE)
    .map(([agentId, policy]) => `${agentId}=${policy.mode}`)
    .sort()
    .join(';')
}

/** The same fingerprint for the policies as stored in the `agents` table. */
export function fingerprintFromModes(modes: Record<string, string>): string {
  return Object.entries(modes)
    .filter(([, mode]) => assertAggregationMode(mode) !== DEFAULT_FOLD_MODE)
    .map(([agentId, mode]) => `${agentId}=${mode}`)
    .sort()
    .join(';')
}
