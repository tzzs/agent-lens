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
 * `cost_total` (§18 row 1's reported > computed priority) IS resolved inside the cube, at
 * the stage-1 request grain: a group pays its agent's reported number where the agent
 * reported one (MAX-folded inside the group, so a request split across duplicate rows is
 * counted once under `request_max` and once per row under the sum modes), plus priced
 * tokens ONLY for the request rows that reported nothing. That grain is what makes the
 * fusion double-count-proof: each request row contributes either its report or its
 * price, never both. NULL when a group has neither fact, and NULL whenever a
 * never-reported slice has no price — never $0 (§8).
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
  projectLabel,
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
import { foldKey, type FoldCache } from './fold-cache.ts'

const DAY_MS = 86_400_000

/**
 * The stage-2 read source: either the inline `req` CTE joined back to `events` for the
 * representative row, or a materialised fold that already carries those columns. Both are
 * described by one `ReadSource` so `dimSql` can generate the dim expressions for either —
 * two hand-written copies of 24 dims is exactly how CLI and Web numbers would start to
 * disagree (§7).
 */
interface ReadSource {
  /** Relation holding the representative row's `events` columns. */
  rep: string
  /** Relation holding `name`/`provider` (always `models`). */
  models: string
}
/** Today's shape: stage-1 CTE + a join back to the events table. */
const CTE_SOURCE: ReadSource = { rep: 'e', models: 'm' }
/** Materialised shape: the fold temp table, joined to `models` only for its rowid. */
const FOLD_TABLE_SOURCE: ReadSource = { rep: 'r', models: 'm' }

function dimSql(src: ReadSource): Record<Dim, string> {
  const { rep, models } = src
  const ts = `CAST(${rep}.timestamp / 1000 AS INTEGER)`
  const DAY = `strftime('%Y-%m-%d', ${ts}, 'unixepoch')`
  // ISO-style weeks: floor to Monday 00:00 UTC (epoch day 0 is a Thursday → +4d offset).
  const WEEK = `strftime('%Y-%m-%d', ${ts} - (${ts} - 345600) % 604800, 'unixepoch')`
  const MONTH = `strftime('%Y-%m', ${ts}, 'unixepoch')`
  const capName = (type: CapabilityDim): string =>
    // `type` comes from the closed CAPABILITY list, never from user input.
    `CASE WHEN ${rep}.capability_type = '${type}' THEN COALESCE(${rep}.capability_name, '') ELSE '' END`
  return {
    time: DAY,
    day: DAY,
    week: WEEK,
    month: MONTH,
    agent: `COALESCE(${rep}.agent_id, '')`,
    host: `COALESCE(${rep}.host_id, '')`,
    project: `COALESCE(${rep}.project_id, '')`,
    session: `COALESCE(${rep}.session_id, '')`,
    thread: `COALESCE(${rep}.thread_id, '')`,
    model: `COALESCE(${models}.name, '')`,
    provider: `COALESCE(${models}.provider, '')`,
    capability_type: `COALESCE(${rep}.capability_type, '')`,
    capability_name: `CASE WHEN ${rep}.capability_type IS NULL THEN '' ELSE COALESCE(${rep}.capability_name, '') END`,
    tool: capName('tool'),
    skill: capName('skill'),
    mcp: capName('mcp'),
    plugin: capName('plugin'),
    connector: capName('connector'),
    command: capName('command'),
    subagent: capName('subagent'),
    hook: capName('hook'),
    status: `COALESCE(${rep}.status, '')`,
    usage_source: `COALESCE(${rep}.usage_source, '')`,
  }
}

/**
 * The representative-row columns a materialised fold must keep: every `events` column any
 * dim expression reads (see `dimSql`), plus `model_rowid` so `provider`/`model` still join
 * to `models`. `type` and `metadata` are filter-only and never a dim, so they stay out.
 */
const FOLD_REP_COLUMNS = [
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
  /**
   * True when the filter mentions `models` (`model`/`provider`), so stage 1 must join it.
   * Joining unconditionally cost ~750 ms per fold on the measured store for a join that
   * only ever answered "does this row's model match" — and on the common path, nothing.
   */
  joinsModels: boolean
  /**
   * Name of the temp table holding a materialised stage 1, when this request has one.
   * Stage 2 then reads that relation instead of re-running the fold.
   */
  foldTable?: string
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
  /**
   * Share one materialised stage-1 fold across every cube call in this scope. Absent means
   * the inline CTE path, which re-folds per statement — correct, just slower. The caller
   * owns the cache's lifetime and must `dispose()` it (see `createFoldCache`).
   */
  foldCache?: FoldCache
  /**
   * The clock a relative `since`/`until` (`'30d'`) is measured against. Defaults to
   * `Date.now()` per call, which means each cube call in one request resolves a window a
   * few milliseconds apart from its siblings — the numbers still agree to within noise, but
   * nothing downstream can recognise two such windows as the same query. Pass one pinned
   * clock per request and the window stops drifting: the fold cache then hits, and the
   * page's cards, trend and splits are guaranteed to describe the same span.
   */
  now?: () => number
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

function toTs(v: string | number, label: string, now?: () => number): number {
  if (typeof v === 'number') return v
  try {
    return resolveSince(v, now?.())
  } catch (err) {
    throw new Error(`filter ${label}: ${(err as Error).message}`)
  }
}

function buildWhere(filter: QueryFilter | undefined, now?: () => number): Prepared {
  const parts: string[] = []
  const params: unknown[] = []
  const inList = (col: string, values: string[] | undefined) => {
    if (!values || values.length === 0) return
    parts.push(`${col} IN (${values.map(() => '?').join(', ')})`)
    params.push(...values)
  }
  if (filter?.since !== undefined) {
    parts.push('e.timestamp >= ?')
    params.push(toTs(filter.since, 'since', now))
  }
  if (filter?.until !== undefined) {
    parts.push('e.timestamp <= ?')
    params.push(toTs(filter.until, 'until', now))
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

/** Stage 1's projected columns. `duration` and `rep_cost` are always kept in a materialised
 *  fold so one table can serve every stage-2 shape in the scope; the inline CTE keeps them
 *  conditional so a spec that asks for neither emits exactly the SQL it always did. */
function foldSelectList(reqs: Reqs, withDuration: boolean, withReported: boolean): string {
  const tokenMaxes = TOKEN_FIELDS.map(
    (f) => `MAX(COALESCE(e.${TOKEN_EVENT_COL[f]}, 0)) AS ${TOKEN_METRIC[f]}`,
  ).join(',\n      ')
  // §18 row 1 fusion: one reported number per request row. MAX keeps NULL "nothing
  // reported" distinct from 0 (§8); under request_max it also folds a duplicate row's
  // copy of the same report so it can be counted twice.
  const reportedFold = withReported ? ',\n      MAX(e.cost_reported) AS rep_cost' : ''
  return `SELECT COALESCE(e.agent_id, '') AS agent_key, ${reqs.fold.sql} AS req_key, MAX(e.id) AS rep_id,
      ${tokenMaxes}${withDuration ? ',\n      MAX(COALESCE(e.duration_ms, 0)) AS duration' : ''}${reportedFold}`
}

/** Stage 1 (§18): one row per (agent, request key), MAX per token column under `request_max`. */
function dedupStage(reqs: Reqs, withDuration: boolean, withReported: boolean): string {
  return `req AS (
      ${foldSelectList(reqs, withDuration, withReported)}
      FROM events e
      ${reqs.joinsModels ? 'LEFT JOIN models m ON m.rowid = e.model_rowid' : ''}
      ${reqs.where.sql}
      GROUP BY agent_key, req_key
    )`
}

/**
 * The one-off materialisation: stage 1 plus the representative row's dim columns, so stage 2
 * reads a ~1-row-per-request relation instead of re-folding and re-joining. The rep row's
 * `model_rowid` is kept rather than the model name, so `provider`/`model` still resolve
 * through the same `models` join as the inline path.
 *
 * Stage 1 runs in its superset shape (every token bucket + duration) even for a query that
 * asks for fewer metrics: one table then serves every stage-2 shape in the scope, which is
 * the whole point of sharing it.
 */
function materialiseFoldSql(reqs: Reqs, table: string): Prepared {
  const repCols = FOLD_REP_COLUMNS.map((c) => `e.${c}`).join(', ')
  // `rep_cost` is the §18 row 1 folded report and must ride along: stage 2 tests it for
  // IS NULL to find the requests that reported nothing, and a NULL has to survive the round
  // trip through the temp table exactly as it does in the CTE (a column declared by
  // expression carries no affinity, so a REAL stays the identical REAL and a NULL stays NULL).
  const foldCols = [...TOKEN_FIELDS.map((f) => TOKEN_METRIC[f]), 'duration', 'rep_cost']
    .map((c) => `r.${c}`)
    .join(', ')
  return {
    sql: `CREATE TEMP TABLE "${table}" AS
      WITH ${dedupStage(reqs, true, true)}
      SELECT r.agent_key, r.req_key, r.rep_id, ${foldCols}, ${repCols}
      FROM req r
      JOIN events e ON e.id = r.rep_id`,
    params: [...reqs.fold.params, ...reqs.where.params],
  }
}

/** Params for a stage-2 statement: a materialised fold has already absorbed them all. */
function stageParams(reqs: Reqs): unknown[] {
  return reqs.foldTable ? [] : [...reqs.fold.params, ...reqs.where.params]
}

/** Whether a statement's dim list needs `models`, which is only ever joined through. */
function dimsNeedModels(dims: Dim[]): boolean {
  return dims.includes('model') || dims.includes('provider')
}

/**
 * Stage-2 FROM clause. Two shapes, one intent — read the folded row plus its representative
 * row's columns:
 *   inline:  the `req` CTE joined back to `events` by `rep_id` (and to `models` through it);
 *   cached:  the materialised fold, which already carries those columns, so the 81k-probe
 *            join-back disappears and only `models` may still be joined.
 * `needsRepRow` is the caller's question, not this function's guess: with no dims there are
 * no representative-row values to read and `id` is the primary key, so the join-back cannot
 * add, drop or change a row — but the cost buckets read `agent_id` and `timestamp` off it
 * even with no dims, so they always ask for it.
 */
function stage2From(reqs: Reqs, needsRepRow: boolean, needsModels: boolean): string {
  if (reqs.foldTable) {
    return `FROM ${reqs.foldTable} r${needsModels ? ' LEFT JOIN models m ON m.rowid = r.model_rowid' : ''}`
  }
  return `FROM req r${needsRepRow ? ' JOIN events e ON e.id = r.rep_id' : ''}${
    needsModels && needsRepRow ? ' LEFT JOIN models m ON m.rowid = e.model_rowid' : ''
  }`
}

/**
 * Where stage 2 reads the representative row from: the materialised fold carries the
 * columns itself, the inline CTE has to join back to `events`. Stage 1 (`eventQuery`) reads
 * raw events and never has either, so it always passes `CTE_SOURCE` explicitly — deriving the
 * source from `reqs.foldTable` there would emit `r.` columns against an `events e` FROM.
 */
function stageSource(reqs: Reqs): ReadSource {
  return reqs.foldTable ? FOLD_TABLE_SOURCE : CTE_SOURCE
}

/** The dim expressions for one read source. */
function dimFor(src: ReadSource): Record<Dim, string> {
  return dimSql(src)
}

function selectClause(reqs: Reqs, metricSqls: string[], src: ReadSource): { selects: string; groupBy: string } {
  const metrics = metricSqls.length ? metricSqls.join(', ') : 'COUNT(*) AS _noop' // COUNT keeps the no-dims case one row
  if (reqs.dims.length === 0) {
    return { selects: metrics, groupBy: '' }
  }
  const D = dimFor(src)
  const named = reqs.dims.map((d) => `${D[d]} AS ${d}`).join(', ')
  return {
    selects: `${named}, ${metrics}`,
    groupBy: `GROUP BY ${reqs.dims.map((_, i) => i + 1).join(', ')}`,
  }
}

function eventQuery(reqs: Reqs): Prepared {
  const metricSqls: string[] = []
  if (reqs.metrics.includes('events')) metricSqls.push('COUNT(*) AS events')
  if (reqs.metrics.includes('sessions')) metricSqls.push('COUNT(DISTINCT e.session_id) AS sessions')
  // Raw SUM, never the fold: a reported cost is already the agent's final number (§18 row 1).
  // SQLite SUM returns NULL when every row is NULL, which is exactly the "no data" we must show.
  if (reqs.metrics.includes('cost_reported')) metricSqls.push('SUM(e.cost_reported) AS cost_reported')
  const { selects, groupBy } = selectClause(reqs, metricSqls, CTE_SOURCE)
  const from = `FROM events e${
    reqs.joinsModels || dimsNeedModels(reqs.dims) ? ' LEFT JOIN models m ON m.rowid = e.model_rowid' : ''
  }`
  return { sql: `SELECT ${selects} ${from} ${reqs.where.sql} ${groupBy}`, params: reqs.where.params }
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
    } else if (m === 'cost_total') {
      // Only the reported half of the fusion rides the stage-2 SQL; the priced half
      // goes through the (model, day) buckets below, over the rows that reported nothing.
      metricSqls.push('SUM(r.rep_cost) AS reported_folded')
    }
  }
  if (metricSqls.length === 0) return null
  const { selects, groupBy } = selectClause(reqs, metricSqls, stageSource(reqs))
  const needsModels = dimsNeedModels(reqs.dims)
  return {
    sql: `${reqs.foldTable ? '' : `WITH ${dedupStage(reqs, reqs.metrics.includes('duration'), reqs.metrics.includes('cost_total'))}`}
      SELECT ${selects}
      ${stage2From(reqs, reqs.dims.length > 0, needsModels)}
      ${groupBy}`,
    params: stageParams(reqs),
  }
}

/** Request stage grouped additionally by (agent, provider, model, day) so cost is
 *  derived from the DEDUPED totals per (model, date) via the injected price table (§8).
 *  `unreportedOnly` restricts the buckets to request rows whose agent reported nothing:
 *  the priced half of the §18 row 1 fusion, so a report is never priced on top of itself. */
function costBucketsQuery(reqs: Reqs, unreportedOnly = false): Prepared | null {
  if (unreportedOnly ? !reqs.metrics.includes('cost_total') : !reqs.metrics.includes('cost_api_equiv')) return null
  const src = stageSource(reqs)
  const D = dimFor(src)
  const bucketNames = ['b_agent', 'b_provider', 'b_model', 'b_day']
  const bucketSqls = [
    `COALESCE(${src.rep}.agent_id, '') AS b_agent`,
    "COALESCE(m.provider, '') AS b_provider",
    "COALESCE(m.name, '') AS b_model",
    `${D.day} AS b_day`,
  ]
  const tokenSums = TOKEN_FIELDS.map((f) => `SUM(r.${TOKEN_METRIC[f]}) AS ${TOKEN_METRIC[f]}`).join(', ')
  const dimPart =
    reqs.dims.length > 0
      ? reqs.dims.map((d) => `${D[d]} AS ${d}`).join(', ') + ', '
      : ''
  const dimGroup = reqs.dims.length > 0 ? reqs.dims.map((_, i) => i + 1).join(', ') + ', ' : ''
  const groupStart = reqs.dims.length
  const bucketGroup = bucketNames.map((_, i) => groupStart + i + 1).join(', ')
  return {
    sql: `${reqs.foldTable ? '' : `WITH ${dedupStage(reqs, reqs.metrics.includes('duration'), unreportedOnly)}`}
      SELECT ${dimPart}${bucketSqls.join(', ')}, ${tokenSums}
      ${stage2From(reqs, true, true)}
      ${unreportedOnly ? 'WHERE r.rep_cost IS NULL' : ''}
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
    map.set(String(r.id), projectLabel({
      id: String(r.id),
      displayName: r.display_name ? String(r.display_name) : null,
      canonicalRoot: r.canonical_root ? String(r.canonical_root) : null,
    }))
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

/** Prices every deduped (dims…, agent, provider, model, day) bucket and folds one cost
 *  field up into one accumulator per dim-key ('' key = grand total). `field` is what makes
 *  §8's two numbers separable: `apiEquivalentUsd` is the API-equivalent view, `actualUsd`
 *  is the cash a declared billing mode really costs. */
function priceBuckets(
  db: DatabaseSync,
  cq: Prepared,
  reqs: Reqs,
  deps: QueryDeps,
  field: 'apiEquivalentUsd' | 'actualUsd',
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
    const priced = cost[field]
    // NULL dominates, never $0 (§8: unknown price must not read as free).
    costs.set(key, costs.get(key) === null || priced === null ? null : (costs.get(key) ?? 0) + priced)
  }
  return costs
}

/** The priced half of the fusion over rows that reported nothing, priced as CASH: what a
 *  request actually costs follows the declared billing mode (§8), while `cost_api_equiv`
 *  keeps showing the API-equivalent value of the same tokens. Without an injected
 *  price table an unreported token slice is simply unpriceable, so resolve it through a
 *  resolver that finds no price: the gap rule turns it into NULL instead of a silent drop. */
function unreportedPriced(db: DatabaseSync, reqs: Reqs, deps: QueryDeps): Map<string, number | null> {
  const cq = costBucketsQuery(reqs, true)
  if (!cq) return new Map()
  return priceBuckets(db, cq, reqs, { ...deps, priceResolver: deps.priceResolver ?? (() => null) }, 'actualUsd')
}

/**
 * §18 row 1 query priority as arithmetic on NULL-preserving facts: `reported` is the
 * group's folded report (NULL = none), `priced` the cost of the never-reported requests
 * (undefined = none exist, NULL = exists but unpriced). Unknown is never 0 (§8), so an
 * unpriced unreported slice NULLs the whole group rather than leaking a floor.
 */
function fuseCost(reported: number | null, priced: number | null | undefined): number | null {
  if (priced === null) return null
  if (reported === null && priced === undefined) return null
  return (reported ?? 0) + (priced ?? 0)
}

/** Metrics that make stage 1 run at all: token/duration read the fold, `cost_api_equiv`
 *  prices its buckets, and `cost_total` needs both the folded report and the unreported
 *  buckets. A spec with none of them must never pay for — or create — one. */
function usesFold(metrics: Metric[]): boolean {
  return metrics.some(
    (m) => TOKEN_METRIC_NAMES.includes(m) || m === 'duration' || m === 'cost_api_equiv' || m === 'cost_total',
  )
}

export function query(db: DatabaseSync, spec: QuerySpec, deps?: QueryDeps): QueryResult {
  if (spec.metrics !== undefined && spec.metrics.length === 0) throw new Error('query: metrics must not be empty')
  const metrics = (spec.metrics ?? ['events']).map(assertMetric)
  const dims = (spec.dims ?? []).map(assertDim)
  if (new Set(dims).size !== dims.length) throw new Error('query: duplicate dims in spec')
  const where = buildWhere(spec.filter, deps?.now)
  const fold = buildFold(deps?.aggregation)
  const reqs: Reqs = {
    metrics,
    dims,
    where,
    fold,
    joinsModels: Boolean(spec.filter?.model?.length || spec.filter?.provider?.length),
  }
  // One materialisation per distinct (fold key, filter) inside the scope: the four stage-2
  // statements below (grouped, totals, and their two cost-bucket variants) otherwise each
  // re-run the fold, and a whole dashboard page re-runs it ~14 times over.
  if (deps?.foldCache && usesFold(metrics)) {
    const draft: Reqs = { ...reqs }
    reqs.foldTable = deps.foldCache.ensure(foldKey([fold.sql, where.sql, where.params, reqs.joinsModels]), (table) =>
      materialiseFoldSql(draft, table),
    )
  }

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
      for (const m of metrics) r[m] = m === 'cost_api_equiv' || m === 'cost_reported' || m === 'cost_total' ? null : 0
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
      const costs = priceBuckets(db, cq, reqs, costDeps, 'apiEquivalentUsd')
      for (const [key, api] of costs) {
        const row = merged.get(key)
        if (row) row.cost_api_equiv = api
      }
    }
  }

  // Fusion last so both halves read the same stage-1 fold; keys are still raw dim values.
  if (metrics.includes('cost_total')) {
    const priced = unreportedPriced(db, reqs, deps ?? {})
    const reportedByDim = new Map<string, number | null>()
    for (const row of tokenRows) reportedByDim.set(rowKey(row, dims), nullableNum(row.reported_folded))
    for (const [key, r] of merged) r.cost_total = fuseCost(reportedByDim.get(key) ?? null, priced.get(key))
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
  const totals = spec.totals === false ? {} : computeTotals(db, reqs, deps)
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
    else if (m === 'cost_total') totals.cost_total = null // filled from the fusion below
    else totals[m] = num(tk[m])
  }
  if (reqs.metrics.includes('cost_api_equiv') && deps?.priceResolver) {
    const costDeps = deps
    const cq = costBucketsQuery(totalsReq)
    if (cq) {
      const costs = priceBuckets(db, cq, totalsReq, costDeps, 'apiEquivalentUsd')
      totals.cost_api_equiv = costs.get('[]') ?? null
    }
  }
  if (reqs.metrics.includes('cost_total')) {
    const priced = unreportedPriced(db, totalsReq, deps ?? {})
    totals.cost_total = fuseCost(nullableNum(tk.reported_folded), priced.get('[]'))
  }
  return totals
}
