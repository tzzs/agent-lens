/**
 * §7 aggregation cube — the ONLY place token/cost SQL is composed.
 *
 * §3.1 + §18 row 2 (the second measurement round superseded the "global invariant"
 * framing): the fold that turns log rows into token totals is PER AGENT, because the
 * upstream shapes differ. Claude Code and its fork Qoder split one response across
 * content blocks and repeat identical usage in each (a plain SUM inflates ~1.87x) →
 * `request_max`: MAX per request_id, then SUM. Codex does NOT duplicate usage; its trap
 * is granularity (per-call rows beside cumulative `total`/`turn`/`thread` fields,
 * ~1971x if the cumulative ones are folded) → `per_record_sum` / `last_call_sum`: every
 * per-call row counted exactly once. So every token/duration metric is computed in two
 * stages:
 *   stage 1 (inner `req`): fold events to ONE row per (agent_id, request key), where the
 *     request key is the request_id under `request_max` and the event id under both sum
 *     modes — the SQL twin of `aggregateUsage` in event-model;
 *   stage 2 (outer): re-group those request rows over the requested dims and SUM them.
 * Grouping stage 1 by agent_id as well keeps one agent's key rule from ever merging
 * another agent's rows. Agents with no declared policy keep `request_max`, the most
 * conservative fold.
 * Rows with NULL/empty request_id key on their own event id, so each is its
 * own group of one: counted exactly once, never merged with other NULL rows.
 * Representative-row tie-break for dim values: lexicographically greatest
 * event id in the group (deterministic across replays, §4.2).
 *
 * `cost_reported` (§18 row 1) bypasses both stages on purpose: the agent already reported
 * a final number, so folding it again would be wrong. It is a SUM over the raw filtered
 * events and stays NULL when no row reported one — never $0. A reported cost and the
 * computed API-equivalent estimate are different facts, so they are separate metrics and
 * are never added together.
 *
 * Injection posture: dim/metric names are validated against the exported
 * whitelist and mapped to *constant* SQL fragments; every filter VALUE — and every agent
 * id in the aggregation map — is a bound parameter. User strings can never reach the
 * query text.
 */
import type { DatabaseSync } from 'node:sqlite'
import { computeCost, type BillingMode, type PriceEntry } from '@agentlens/pricing'
import {
  assertAggregationMode,
  DEFAULT_AGGREGATION,
  type AggregationMode,
  type AggregationPolicy,
} from '@agentlens/event-model'
import {
  assertDim,
  assertMetric,
  type CapabilityDim,
  type Dim,
  type Metric,
  type QueryFilter,
  type QueryResult,
  type QuerySpec,
  type Row,
} from './spec.ts'
import { resolveSince } from './time.ts'

const DAY_MS = 86_400_000

const DAY_SQL = "strftime('%Y-%m-%d', CAST(e.timestamp / 1000 AS INTEGER), 'unixepoch')"
// ISO-style weeks: floor to Monday 00:00 UTC (epoch day 0 is a Thursday → +4d offset).
const WEEK_SQL =
  "strftime('%Y-%m-%d', CAST(e.timestamp / 1000 AS INTEGER) - " +
  "(CAST(e.timestamp / 1000 AS INTEGER) - 345600) % 604800, 'unixepoch')"
const MONTH_SQL = "strftime('%Y-%m', CAST(e.timestamp / 1000 AS INTEGER), 'unixepoch')"

function capNameSql(type: CapabilityDim): string {
  // `type` comes from the closed CAPABILITY list, never from user input.
  return `CASE WHEN e.capability_type = '${type}' THEN COALESCE(e.capability_name, '') ELSE '' END`
}

/** Constant SQL fragment per dim. `e` = events alias, `m` = models LEFT-join alias. */
const DIM_SQL: Record<Dim, string> = {
  time: DAY_SQL,
  day: DAY_SQL,
  week: WEEK_SQL,
  month: MONTH_SQL,
  agent: "COALESCE(e.agent_id, '')",
  host: "COALESCE(e.host_id, '')",
  project: "COALESCE(e.project_id, '')",
  session: "COALESCE(e.session_id, '')",
  thread: "COALESCE(e.thread_id, '')",
  model: "COALESCE(m.name, '')",
  provider: "COALESCE(m.provider, '')",
  capability_type: "COALESCE(e.capability_type, '')",
  capability_name: "CASE WHEN e.capability_type IS NULL THEN '' ELSE COALESCE(e.capability_name, '') END",
  tool: capNameSql('tool'),
  skill: capNameSql('skill'),
  mcp: capNameSql('mcp'),
  plugin: capNameSql('plugin'),
  connector: capNameSql('connector'),
  command: capNameSql('command'),
  subagent: capNameSql('subagent'),
  hook: capNameSql('hook'),
  status: "COALESCE(e.status, '')",
  usage_source: "COALESCE(e.usage_source, '')",
}

type TokenField = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'
const TOKEN_FIELDS: readonly TokenField[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
const TOKEN_EVENT_COL: Record<TokenField, string> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_tokens',
  cacheWrite: 'cache_write_tokens',
  reasoning: 'reasoning_tokens',
}
const TOKEN_METRIC: Record<TokenField, Metric> = {
  input: 'tokens_input',
  output: 'tokens_output',
  cacheRead: 'tokens_cache_read',
  cacheWrite: 'tokens_cache_write',
  reasoning: 'tokens_reasoning',
}
/** tokens_total = sum of the five buckets (matches grandTotal in event-model dedupe). */
const TOKEN_METRIC_NAMES: Metric[] = [...TOKEN_FIELDS.map((f) => TOKEN_METRIC[f]), 'tokens_total']

interface Prepared {
  sql: string
  params: unknown[]
}

interface Reqs {
  metrics: Metric[]
  dims: Dim[]
  where: Prepared
  /** Stage-1 fold: request-key expression + its bound agent ids (§18 per-adapter policy). */
  fold: Prepared
}

/** Stage-1 request key per §18 mode. `e` is the events alias. */
const FOLD_KEY_SQL: Record<AggregationMode, string> = {
  request_max: "COALESCE(NULLIF(e.request_id, ''), e.id)",
  // At this layer a per-call row IS one usage row: the adapter already resolved Codex's
  // cumulative `total`/`turn`/`thread` granularity, and re-adding it here is the 1971x bug.
  per_record_sum: 'e.id',
  last_call_sum: 'e.id',
}

/**
 * Builds the per-agent stage-1 key. Only agents whose mode differs from
 * DEFAULT_AGGREGATION need a CASE arm; everything else falls through to the default,
 * which is the conservative `request_max`. Agent ids are bound parameters, modes are
 * validated against the closed enum, so no caller string reaches the query text.
 */
function buildFold(aggregation: Record<string, AggregationPolicy> | undefined): Prepared {
  const agentsByMode = new Map<AggregationMode, string[]>()
  for (const [agentId, policy] of Object.entries(aggregation ?? {})) {
    const mode = assertAggregationMode(policy.mode) // unknown mode throws; never a silent fallback
    if (mode === DEFAULT_AGGREGATION.mode) continue
    const list = agentsByMode.get(mode)
    if (list) list.push(agentId)
    else agentsByMode.set(mode, [agentId])
  }
  if (agentsByMode.size === 0) {
    return { sql: FOLD_KEY_SQL[DEFAULT_AGGREGATION.mode], params: [] }
  }
  const arms: string[] = []
  const params: unknown[] = []
  for (const [mode, agents] of agentsByMode) {
    arms.push(`WHEN e.agent_id IN (${agents.map(() => '?').join(', ')}) THEN ${FOLD_KEY_SQL[mode]}`)
    params.push(...agents)
  }
  return {
    sql: `CASE ${arms.join(' ')} ELSE ${FOLD_KEY_SQL[DEFAULT_AGGREGATION.mode]} END`,
    params,
  }
}

export interface QueryDeps {
  /**
   * Pricing is injected, never pulled via pricing's file IO: the cube stays a
   * pure function of (db, spec, deps) so CLI and Web numbers cannot drift (§7).
   */
  priceResolver?: (provider: string, model: string, occurredAt: number) => PriceEntry | null
  /** Default 'api' (§8). */
  billingModeFor?: (agentId: string) => BillingMode
  /**
   * §18 row 2: how each adapter's rows fold into token totals, keyed by `agent_id` —
   * the same declaration `Adapter.aggregation` carries, so the CLI wires adapters straight
   * through and no caller ever has to choose a dedupe rule per query. A missing entry
   * means DEFAULT_AGGREGATION (`request_max`, the most conservative fold); an unknown
   * mode throws UnknownAggregationError instead of silently guessing.
   */
  aggregation?: Record<string, AggregationPolicy>
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return Number(v)
}

/** NULL-preserving numeric read: a missing value stays "no data", never 0 (§8). */
function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  return Number(v)
}

function toTs(v: string | number, label: string): number {
  if (typeof v === 'number') return v
  try {
    return resolveSince(v)
  } catch (err) {
    throw new Error(`filter ${label}: ${(err as Error).message}`)
  }
}

function buildWhere(filter: QueryFilter | undefined): Prepared {
  const parts: string[] = []
  const params: unknown[] = []
  const inList = (col: string, values: string[] | undefined) => {
    if (!values || values.length === 0) return
    parts.push(`${col} IN (${values.map(() => '?').join(', ')})`)
    params.push(...values)
  }
  if (filter?.since !== undefined) {
    parts.push('e.timestamp >= ?')
    params.push(toTs(filter.since, 'since'))
  }
  if (filter?.until !== undefined) {
    parts.push('e.timestamp <= ?')
    params.push(toTs(filter.until, 'until'))
  }
  inList('e.agent_id', filter?.agent)
  inList('e.host_id', filter?.host)
  inList('e.project_id', filter?.project)
  inList('e.session_id', filter?.session)
  inList('m.name', filter?.model)
  inList('m.provider', filter?.provider)
  inList('e.capability_type', filter?.capabilityType)
  inList('e.capability_name', filter?.capabilityName)
  inList('e.status', filter?.status)
  inList('e.type', filter?.type)
  if (filter?.includeSubagentThreads === false) {
    // metadata is JSON text at rest (§6); the marker adapters set is `subagentThread: true`.
    // NULL metadata / missing key / explicit false all read as "not a subagent thread".
    parts.push("json_extract(e.metadata, '$.subagentThread') IS NOT 1")
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

/** Stage 1 (§18): one row per (agent, request key), MAX per token column under `request_max`. */
function dedupStage(reqs: Reqs): string {
  const tokenMaxes = TOKEN_FIELDS.map(
    (f) => `MAX(COALESCE(e.${TOKEN_EVENT_COL[f]}, 0)) AS ${TOKEN_METRIC[f]}`,
  ).join(',\n      ')
  const needsDuration = reqs.metrics.includes('duration')
  return `req AS (
      SELECT COALESCE(e.agent_id, '') AS agent_key, ${reqs.fold.sql} AS req_key, MAX(e.id) AS rep_id,
      ${tokenMaxes}${needsDuration ? ',\n      MAX(COALESCE(e.duration_ms, 0)) AS duration' : ''}
      FROM events e
      LEFT JOIN models m ON m.rowid = e.model_rowid
      ${reqs.where.sql}
      GROUP BY agent_key, req_key
    )`
}

/** Stage-1 params precede the WHERE params in query text order (the fold key is in SELECT). */
function stageParams(reqs: Reqs): unknown[] {
  return [...reqs.fold.params, ...reqs.where.params]
}

function selectClause(reqs: Reqs, metricSqls: string[]): { selects: string; groupBy: string } {
  const metrics = metricSqls.length ? metricSqls.join(', ') : 'COUNT(*) AS _noop' // COUNT keeps the no-dims case one row
  if (reqs.dims.length === 0) {
    return { selects: metrics, groupBy: '' }
  }
  const named = reqs.dims.map((d) => `${DIM_SQL[d]} AS ${d}`).join(', ')
  return {
    selects: `${named}, ${metrics}`,
    groupBy: `GROUP BY ${reqs.dims.map((_, i) => i + 1).join(', ')}`,
  }
}

function fromClause(): string {
  return 'FROM events e LEFT JOIN models m ON m.rowid = e.model_rowid'
}

function eventQuery(reqs: Reqs): Prepared {
  const metricSqls: string[] = []
  if (reqs.metrics.includes('events')) metricSqls.push('COUNT(*) AS events')
  if (reqs.metrics.includes('sessions')) metricSqls.push('COUNT(DISTINCT e.session_id) AS sessions')
  // Raw SUM, never the fold: a reported cost is already the agent's final number (§18 row 1).
  // SQLite SUM returns NULL when every row is NULL, which is exactly the "no data" we must show.
  if (reqs.metrics.includes('cost_reported')) metricSqls.push('SUM(e.cost_reported) AS cost_reported')
  const { selects, groupBy } = selectClause(reqs, metricSqls)
  return { sql: `SELECT ${selects} ${fromClause()} ${reqs.where.sql} ${groupBy}`, params: reqs.where.params }
}

/** Stage 2 (§18): SUM over the folded per-agent request rows for token/duration metrics. */
function requestStageQuery(reqs: Reqs): Prepared | null {
  const metricSqls: string[] = []
  for (const m of reqs.metrics) {
    if (m === 'tokens_total') {
      const sum = TOKEN_FIELDS.map((f) => `r.${TOKEN_METRIC[f]}`).join(' + ')
      metricSqls.push(`SUM(${sum}) AS tokens_total`)
    } else if (TOKEN_METRIC_NAMES.includes(m)) {
      metricSqls.push(`SUM(r.${m}) AS ${m}`)
    } else if (m === 'duration') {
      metricSqls.push('SUM(r.duration) AS duration')
    }
  }
  if (metricSqls.length === 0) return null
  const { selects, groupBy } = selectClause(reqs, metricSqls)
  return {
    sql: `WITH ${dedupStage(reqs)}
      SELECT ${selects}
      FROM req r
      JOIN events e ON e.id = r.rep_id
      LEFT JOIN models m ON m.rowid = e.model_rowid
      ${groupBy}`,
    params: stageParams(reqs),
  }
}

/** Request stage grouped additionally by (agent, provider, model, day) so cost is
 *  derived from the DEDUPED totals per (model, date) via the injected price table (§8). */
function costBucketsQuery(reqs: Reqs): Prepared | null {
  if (!reqs.metrics.includes('cost_api_equiv')) return null
  const bucketNames = ['b_agent', 'b_provider', 'b_model', 'b_day']
  const bucketSqls = [
    "COALESCE(e.agent_id, '') AS b_agent",
    "COALESCE(m.provider, '') AS b_provider",
    "COALESCE(m.name, '') AS b_model",
    `${DAY_SQL} AS b_day`,
  ]
  const tokenSums = TOKEN_FIELDS.map((f) => `SUM(r.${TOKEN_METRIC[f]}) AS ${TOKEN_METRIC[f]}`).join(', ')
  const dimPart =
    reqs.dims.length > 0
      ? reqs.dims.map((d) => `${DIM_SQL[d]} AS ${d}`).join(', ') + ', '
      : ''
  const dimGroup = reqs.dims.length > 0 ? reqs.dims.map((_, i) => i + 1).join(', ') + ', ' : ''
  const groupStart = reqs.dims.length
  const bucketGroup = bucketNames.map((_, i) => groupStart + i + 1).join(', ')
  return {
    sql: `WITH ${dedupStage(reqs)}
      SELECT ${dimPart}${bucketSqls.join(', ')}, ${tokenSums}
      FROM req r
      JOIN events e ON e.id = r.rep_id
      LEFT JOIN models m ON m.rowid = e.model_rowid
      GROUP BY ${dimGroup}${bucketGroup}`,
    params: stageParams(reqs),
  }
}

function runPrepared(db: DatabaseSync, p: Prepared): Row[] {
  const stmt = db.prepare(p.sql)
  const rows = p.params.length ? stmt.all(...(p.params as never[])) : stmt.all()
  return (rows as Record<string, unknown>[]).map((r) => ({ ...r }))
}

function rowKey(row: Row, dims: Dim[]): string {
  return JSON.stringify(dims.map((d) => String(row[d] ?? '')))
}

interface Order {
  kind: 'metric' | 'dim'
  name: string
  dir: 1 | -1
}

function parseOrder(order: string | undefined): Order | null {
  if (!order) return null
  const parts = order.split(':')
  if (parts.length !== 3 || (parts[0] !== 'metric' && parts[0] !== 'dim') || (parts[2] !== 'asc' && parts[2] !== 'desc')) {
    throw new Error(
      `invalid order ${JSON.stringify(order)}; expected metric:<name>:<asc|desc> or dim:<name>:<asc|desc>`,
    )
  }
  const kind = parts[0] as Order['kind']
  const dir = (parts[2] === 'asc' ? 1 : -1) as 1 | -1
  // `cost_total` is the §7 example alias for the only cost metric we expose.
  if (parts[1] === 'cost_total') return { kind: 'metric', name: 'cost_api_equiv', dir }
  if (kind === 'metric') return { kind, name: assertMetric(parts[1]!), dir }
  return { kind, name: assertDim(parts[1]!), dir }
}

function defaultOrder(reqs: Reqs): Order | null {
  const first = reqs.dims[0]
  if (first === 'time' || first === 'day' || first === 'week' || first === 'month') {
    return { kind: 'dim', name: first, dir: 1 }
  }
  const metric = reqs.metrics.includes('cost_api_equiv') ? 'cost_api_equiv' : reqs.metrics[0]
  if (!metric) return null
  return { kind: 'metric', name: metric, dir: -1 }
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  return String(a).localeCompare(String(b))
}

function projectLabels(db: DatabaseSync): Map<string, string> {
  const rows = runPrepared(db, { sql: 'SELECT id, display_name, canonical_root FROM projects', params: [] })
  const map = new Map<string, string>()
  for (const r of rows) {
    const root = r.canonical_root ? String(r.canonical_root) : null
    const base = root ? (root.split('/').filter(Boolean).pop() ?? null) : null
    map.set(String(r.id), (r.display_name ? String(r.display_name) : null) ?? base ?? String(r.id))
  }
  return map
}

function usageOf(row: Row) {
  return {
    inputTokens: num(row.tokens_input),
    outputTokens: num(row.tokens_output),
    cacheReadTokens: num(row.tokens_cache_read),
    cacheWriteTokens: num(row.tokens_cache_write),
    reasoningTokens: num(row.tokens_reasoning),
  }
}

function totalTokens(u: ReturnType<typeof usageOf>): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
}

/** Prices every deduped (dims…, agent, provider, model, day) bucket and folds the
 *  api-equivalent cost up into one accumulator per dim-key ('' key = grand total). */
function priceBuckets(
  db: DatabaseSync,
  cq: Prepared,
  reqs: Reqs,
  deps: QueryDeps,
): Map<string, number | null> {
  const priceResolver = deps.priceResolver
  const billingModeFor = deps.billingModeFor ?? (() => 'api' as BillingMode)
  const costs = new Map<string, number | null>()
  if (!priceResolver) return costs
  for (const row of runPrepared(db, cq)) {
    const usage = usageOf(row)
    if (totalTokens(usage) === 0) continue // zero-token rows must not manufacture price gaps
    const dayMs = Date.parse(`${String(row.b_day)}T00:00:00Z`) + DAY_MS / 2 // price at noon UTC of the bucket day
    const entry = priceResolver(String(row.b_provider), String(row.b_model), dayMs)
    const cost = computeCost(usage, entry, billingModeFor(String(row.b_agent)))
    const key = rowKey(row, reqs.dims)
    // NULL dominates, never $0 (§8: unknown price must not read as free).
    costs.set(key, costs.get(key) === null || cost.apiEquivalentUsd === null ? null : (costs.get(key) ?? 0) + cost.apiEquivalentUsd)
  }
  return costs
}

export function query(db: DatabaseSync, spec: QuerySpec, deps?: QueryDeps): QueryResult {
  if (spec.metrics !== undefined && spec.metrics.length === 0) throw new Error('query: metrics must not be empty')
  const metrics = (spec.metrics ?? ['events']).map(assertMetric)
  const dims = (spec.dims ?? []).map(assertDim)
  if (new Set(dims).size !== dims.length) throw new Error('query: duplicate dims in spec')
  const reqs: Reqs = { metrics, dims, where: buildWhere(spec.filter), fold: buildFold(deps?.aggregation) }

  const eventRows = runPrepared(db, eventQuery(reqs))
  const tokenQ = requestStageQuery(reqs)
  const tokenRows = tokenQ ? runPrepared(db, tokenQ) : []

  const merged = new Map<string, Row>()
  const ensure = (row: Row): Row => {
    const key = rowKey(row, dims)
    let r = merged.get(key)
    if (!r) {
      r = {}
      for (const d of dims) r[d] = row[d] ?? ''
      for (const m of metrics) r[m] = m === 'cost_api_equiv' || m === 'cost_reported' ? null : 0
      merged.set(key, r)
    }
    return r
  }
  for (const row of eventRows) {
    const r = ensure(row)
    if (metrics.includes('events')) r.events = num(row.events)
    if (metrics.includes('sessions')) r.sessions = num(row.sessions)
    // NULL must survive: "nothing reported" is not $0 (§8/§18 row 1).
    if (metrics.includes('cost_reported')) r.cost_reported = nullableNum(row.cost_reported)
  }
  for (const row of tokenRows) {
    const r = ensure(row)
    for (const m of metrics) {
      if (TOKEN_METRIC_NAMES.includes(m) || m === 'duration') r[m] = num(row[m])
    }
  }

  if (metrics.includes('cost_api_equiv') && deps?.priceResolver) {
    const costDeps = deps
    const cq = costBucketsQuery(reqs)
    if (cq) {
      const costs = priceBuckets(db, cq, reqs, costDeps)
      for (const [key, api] of costs) {
        const row = merged.get(key)
        if (row) row.cost_api_equiv = api
      }
    }
  }

  // The project dim surfaces human labels (§9 shows names, not hashes); merge keys
  // were computed on raw ids above, so grouping stays stable.
  if (dims.includes('project')) {
    const labels = projectLabels(db)
    for (const r of merged.values()) {
      const id = String(r.project ?? '')
      if (id) r.project = labels.get(id) ?? id
    }
  }

  let rows = dims.length > 0 ? [...merged.values()] : [] // no dims: the single aggregate lives in `totals`, not in rows
  const order = parseOrder(spec.order) ?? defaultOrder(reqs)
  if (order) {
    rows.sort((a, b) => compareValues(a[order.name], b[order.name]) * order.dir)
  }

  let truncated = false
  if (spec.limit !== undefined && spec.limit >= 0) {
    truncated = rows.length > spec.limit
    if (truncated) rows = rows.slice(0, spec.limit)
  }

  const columns = [...dims, ...metrics]
  const totals = computeTotals(db, reqs, deps)
  return { rows, columns, totals, truncated }
}

function computeTotals(db: DatabaseSync, reqs: Reqs, deps: QueryDeps | undefined): Record<string, number | null> {
  const totalsReq: Reqs = { ...reqs, dims: [] }
  const totals: Record<string, number | null> = {}
  const ev = runPrepared(db, eventQuery(totalsReq))[0] ?? {}
  const tokenQ = requestStageQuery(totalsReq)
  const tk = tokenQ ? runPrepared(db, tokenQ)[0] ?? {} : {}
  for (const m of reqs.metrics) {
    if (m === 'events') totals.events = num(ev.events)
    else if (m === 'sessions') totals.sessions = num(ev.sessions)
    else if (m === 'cost_api_equiv') totals.cost_api_equiv = null
    else if (m === 'cost_reported') totals.cost_reported = nullableNum(ev.cost_reported)
    else totals[m] = num(tk[m])
  }
  if (reqs.metrics.includes('cost_api_equiv') && deps?.priceResolver) {
    const costDeps = deps
    const cq = costBucketsQuery(totalsReq)
    if (cq) {
      const costs = priceBuckets(db, cq, totalsReq, costDeps)
      totals.cost_api_equiv = costs.get('[]') ?? null
    }
  }
  return totals
}
