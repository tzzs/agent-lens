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
] as const
export type Metric = (typeof METRICS)[number]

/** §7 dim set; `host` and `hook` are the §1.5 measurement additions. */
export const DIMS = [
  'time',
  'day',
  'week',
  'month',
  'agent',
  'host',
  'project',
  'session',
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
