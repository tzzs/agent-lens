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
}

export type Row = Record<string, unknown>

export interface QueryResult {
  rows: Row[]
  columns: string[]
  /** Same metric keys aggregated over the whole filtered set (ignoring dims). */
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
