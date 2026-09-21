/**
 * §7 query-cube vocabulary: the closed whitelist of metrics and dims.
 * Every CLI subcommand and the Web UI must go through `query()` with names
 * validated against these arrays — user strings never reach SQL text.
 */

export const METRICS = [
  'events',
  'sessions',
  'duration',
  'tokens_total',
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'tokens_cache_write',
  'tokens_reasoning',
  'cost_api_equiv',
  /**
   * §18 row 1: the cost the AGENT itself logged (OpenCode `session.cost`, WorkBuddy
   * `session_usage`). A reported cost and an API-equivalent estimate are different facts
   * about different things, so they are separate metrics and are never added together.
   */
  'cost_reported',
  /**
   * §18 row 1 query priority (reported > computed) resolved INSIDE the cube, so no
   * caller has to pick a metric and can double count an event whose reported cost and
   * priced tokens describe the same work: within a group, cost = what the agent
   * reported — folded per its §18 stage-1 policy so duplicates count once — plus the
   * CASH price (§8 billing mode) of ONLY the requests that reported nothing. This is
   * §8's "实际花费"; `cost_api_equiv` is its "等价 API 价值" for the same tokens, which
   * is why a subscription or local agent reads $0 here and a real number there.
   * NULL when a group has neither fact, and NULL whenever a never-reported slice has no
   * price: never $0 (§8).
   */
  'cost_total',
] as const
export type Metric = (typeof METRICS)[number]

/** §7 dim set; `host` and `hook` are the §1.5 measurement additions, `thread` the §18 one. */
export const DIMS = [
  'time',
  'day',
  'week',
  'month',
  'agent',
  'host',
  'project',
  'session',
  /** §18 row 3: source-grain thread. A Codex session spans many thread files; Claude's is 1:1 with a file. */
  'thread',
  'model',
  'provider',
  'capability_type',
  'capability_name',
  'tool',
  'skill',
  'mcp',
  'plugin',
  'connector',
  'command',
  'subagent',
  'hook',
  'status',
  'usage_source',
] as const
export type Dim = (typeof DIMS)[number]

export const TIME_DIMS = ['time', 'day', 'week', 'month'] as const
export type TimeUnit = 'day' | 'week' | 'month'

/** Capability-name dims (§7): the value is `capability_name` restricted to that type. */
export const CAPABILITY_DIMS = [
  'tool',
  'skill',
  'mcp',
  'plugin',
  'connector',
  'command',
  'subagent',
  'hook',
] as const
export type CapabilityDim = (typeof CAPABILITY_DIMS)[number]

export interface QueryFilter {
  since?: string | number
  until?: string | number
  agent?: string[]
  host?: string[]
  project?: string[]
  session?: string[]
  model?: string[]
  provider?: string[]
  capabilityType?: string[]
  capabilityName?: string[]
  status?: string[]
  type?: string[]
  /**
   * §18 row 2/3: Codex thread files are mostly subagents (257 of 379 measured), and the
   * ccusage reconciliation excludes them from headline totals. Setting this to false drops
   * events flagged `metadata.subagentThread` BEFORE any folding, so a subagent's MAX row
   * cannot set the ceiling of a parent request either.
   *
   * Default TRUE deliberately: it keeps every existing caller's numbers byte-identical,
   * and "headline excludes subagents" is a presentation decision for the CLI/UI surface
   * (§18 asks for an explicit switch, not for the cube to hide rows by default). An agent
   * that never emits the marker is unaffected by either value.
   */
  includeSubagentThreads?: boolean
}

export interface QuerySpec {
  /** default `['events']` */
  metrics?: Metric[]
  dims?: Dim[]
  filter?: QueryFilter
  /** `metric:cost_api_equiv:desc` | `dim:project:asc` */
  order?: string
  limit?: number
  /**
   * Default true. Set false to skip the `totals` fold, which is a SECOND full pass over
   * stage 1 with the dims stripped: a caller that reads only `rows` — a per-project model
   * mix, a banner — would pay ~5 s at 343k events for a number it throws away. `totals`
   * then comes back as `{}`, which is deliberately empty rather than zero-filled: an
   * omitted total must not be readable as a measured one (§5.2).
   */
  totals?: boolean
}

export type Row = Record<string, unknown>

export interface QueryResult {
  rows: Row[]
  columns: string[]
  /** Same metric keys aggregated over the whole filtered set (ignoring dims); empty when `totals: false`. */
  totals: Record<string, number | null>
  /** True when `limit` cut rows away. */
  truncated: boolean
}

export class UnknownMetricError extends Error {
  override readonly name = 'UnknownMetricError'
  constructor(metric: string) {
    super(`unknown metric ${JSON.stringify(metric)}; known metrics: ${METRICS.join(', ')}`)
  }
}

export class UnknownDimError extends Error {
  override readonly name = 'UnknownDimError'
  constructor(dim: string) {
    super(`unknown dim ${JSON.stringify(dim)}; known dims: ${DIMS.join(', ')}`)
  }
}

export function assertMetric(name: string): Metric {
  if (!(METRICS as readonly string[]).includes(name)) throw new UnknownMetricError(name)
  return name as Metric
}

export function assertDim(name: string): Dim {
  if (!(DIMS as readonly string[]).includes(name)) throw new UnknownDimError(name)
  return name as Dim
}
