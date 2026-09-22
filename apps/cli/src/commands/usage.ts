/**
 * `usage` (§9) — a thin shell over the cube: `--by` maps straight onto §7 dims,
 * which is why no per-dimension subcommands are needed.
 */
import type { DatabaseSync } from 'node:sqlite'
import { assertDim, costFloor, describeQuery, query, type Dim, type Metric } from '@agentlens/query'
import { UsageError, type FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { queryDeps } from '../context.ts'
import { formatCount, formatTokens, formatUsd, table, type Align } from '../render.ts'
import { filter } from './shared.ts'

const USAGE_METRICS: Metric[] = [
  'events',
  'sessions',
  'tokens_total',
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'cost_total',
  'cost_api_equiv',
]

// Cube metrics whose value is dollars, not a count: `null` must print `n/a`, never `$0` (§8).
const USD_METRICS: Metric[] = ['cost_total', 'cost_api_equiv']

const HEADER: Record<string, string> = {
  events: 'Events',
  sessions: 'Sessions',
  tokens_total: 'Tokens',
  tokens_input: 'Input',
  tokens_output: 'Output',
  tokens_cache_read: 'CacheR',
  cost_total: 'Cost',
  cost_api_equiv: 'Cost(api-equiv)',
  time: 'Time',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  agent: 'Agent',
  host: 'Host',
  project: 'Project',
  session: 'Session',
  model: 'Model',
  provider: 'Provider',
  capability_type: 'Capability',
  capability_name: 'Name',
  tool: 'Tool',
  skill: 'Skill',
  mcp: 'MCP',
  plugin: 'Plugin',
  connector: 'Connector',
  command: 'Command',
  subagent: 'Subagent',
  hook: 'Hook',
  status: 'Status',
  usage_source: 'Usage source',
}

export function cmdUsage(db: DatabaseSync, flags: FlagView, ctx: Ctx, dbPath: string): number {
  const by = flags.list('by')
  let dims: Dim[]
  try {
    dims = (by.length > 0 ? by : ['day']).map(assertDim)
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
  const cubeFilter = filter(db, ctx, flags)
  // §18 row 3 explicit switch, off by default: totals include subagent threads unless
  // asked otherwise, and an excluded number must then say so (§14: 口径 matches the figure).
  if (flags.bool('no-subagents')) cubeFilter.includeSubagentThreads = false
  const spec = {
    // `cost_reported` is asked for but not printed: it is the floor the total line falls back to
    // when fusion comes back NULL for want of a price (§8: the headline must not read lower than a
    // figure the agent itself logged).
    metrics: [...USAGE_METRICS, 'cost_reported'] as Metric[],
    dims,
    filter: cubeFilter,
    limit: flags.num('limit'),
  }
  if (flags.bool('explain')) ctx.out(describeQuery(spec) + '\n')
  const res = query(db, spec, queryDeps(db, dbPath, ctx))

  const headers = [...dims.map((d) => HEADER[d] ?? d), ...USAGE_METRICS.map((m) => HEADER[m] ?? m)]
  const rows = res.rows.map((r) => [
    ...dims.map((d) => String(r[d] ?? '')),
    ...USAGE_METRICS.map((m) =>
      USD_METRICS.includes(m) ? formatUsd(r[m] as number | null) : formatTokens(r[m] as number),
    ),
  ])
  const aligns: Align[] = [...dims.map((): Align => 'left'), ...USAGE_METRICS.map((): Align => 'right')]
  ctx.out(table(headers, rows, aligns))
  const subagentBasis =
    cubeFilter.includeSubagentThreads === false ? ' · subagent threads excluded (--no-subagents)' : ''
  // §8: a NULL fused total means "some tokens we could not price", not "nothing is known" — the
  // agent's own reported money is still a floor. Printing `n/a` there would hide a number the
  // store already has, and printing the sum without the qualifier would claim it is complete.
  const strictCost = res.totals.cost_total ?? null
  const floorCost = costFloor(strictCost, res.totals.cost_reported ?? null)
  const costText =
    strictCost === null && floorCost !== null
      ? `≥ ${formatUsd(floorCost)} cost (partly unpriced)`
      : `${formatUsd(strictCost)} cost`
  ctx.out(
    `total: ${formatCount(res.totals.events ?? 0)} events · ${formatCount(res.totals.sessions ?? 0)} sessions · ` +
      `${formatTokens(res.totals.tokens_total)} tokens (deduped) · ${costText}` +
      ` · ${formatUsd(res.totals.cost_api_equiv)} api-equiv` +
      subagentBasis,
  )
  if (res.truncated) ctx.out(`! truncated to ${spec.limit} rows — order: ${dims.join(',')}; use --limit or filters`)
  return 0
}
