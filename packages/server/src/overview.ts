/**
 * GET /api/overview — the §10 priority-1 screen: four cards, the trend, the
 * agent/project splits, the two §14 banners.
 *
 * Every figure below comes from one cube call with a dim list; the route adds
 * no arithmetic beyond folding the §8 billing modes and shaping rows.
 */
import { query, resolveSince, type QueryFilter, type Row, type TimeUnit } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { costView } from './cost.ts'
import { banners } from './banners.ts'
import { contentLayerPresent, payloadCount } from './content.ts'
import { parseFilter, strParam } from './request-spec.ts'
import { ApiError } from './errors.ts'
import type { TokenBasisCode } from './notes.ts'

const GRANULARITIES = ['day', 'week', 'month'] as const

export interface OverviewResponse {
  generatedAt: number
  window: { since?: string; until?: string; sinceTs: number | null; granularity: TimeUnit; defaultSinceApplied: boolean }
  cards: {
    tokens: {
      total: number
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      reasoning: number
      basisCode: TokenBasisCode
    }
    cost: ReturnType<typeof costView>
    sessions: number
    events: number
  }
  activity: Record<string, number>
  trend: Row[]
  trendByHost: Row[]
  agents: Row[]
  hosts: Row[]
  projects: Row[]
  capabilities: Row[]
  banners: ReturnType<typeof banners>
  content: { available: boolean; payloads: number }
}

const TOKEN_METRICS = [
  'tokens_total',
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'tokens_cache_write',
  'tokens_reasoning',
  'sessions',
  'events',
] as const

export function overview(ctx: ServerCtx, sp: URLSearchParams): OverviewResponse {
  const granularityRaw = strParam(sp, 'granularity') ?? 'day'
  if (!(GRANULARITIES as readonly string[]).includes(granularityRaw)) {
    throw ApiError.badRequest(`unknown granularity ${JSON.stringify(granularityRaw)}`, { allowed: GRANULARITIES })
  }
  const granularity = granularityRaw as TimeUnit
  const filter = parseFilter(sp, ctx.db)
  const defaultSinceApplied = filter.since === undefined
  const windowFilter: QueryFilter = { ...filter, since: filter.since ?? '30d' }
  const sinceRaw = windowFilter.since ?? '30d'
  const sinceTs = typeof sinceRaw === 'number' ? sinceRaw : resolveSince(sinceRaw)

  const totals = query(ctx.db, { metrics: [...TOKEN_METRICS], filter: windowFilter }, ctx.cubeDeps)
  const sumOf = (key: string): number => Number(totals.totals[key] ?? 0)
  const events = sumOf('events')
  const sessions = sumOf('sessions')

  // Every call below is read for its rows; the grand-total fold above already covers the
  // numbers this page prints, so a second one per call would double the route's cost.
  const trend = query(
    ctx.db,
    {
      metrics: ['tokens_total', 'cost_api_equiv', 'events', 'sessions'],
      dims: [granularity],
      filter: windowFilter,
      order: `dim:${granularity}:asc`,
      limit: 400,
      totals: false,
    },
    ctx.cubeDeps,
  )
  const trendByHost = query(
    ctx.db,
    { metrics: ['tokens_total', 'events'], dims: [granularity, 'host'], filter: windowFilter, order: `dim:${granularity}:asc`, limit: 1200, totals: false },
    ctx.cubeDeps,
  )
  const agents = query(
    ctx.db,
    { metrics: ['events', 'sessions', 'tokens_total', 'cost_api_equiv', 'duration'], dims: ['agent'], filter: windowFilter, totals: false },
    ctx.cubeDeps,
  )
  const hosts = query(
    ctx.db,
    { metrics: ['events', 'sessions', 'tokens_total', 'cost_api_equiv'], dims: ['agent', 'host'], filter: windowFilter, totals: false },
    ctx.cubeDeps,
  )
  const projects = query(
    ctx.db,
    { metrics: ['sessions', 'events', 'tokens_total', 'cost_api_equiv'], dims: ['project'], filter: windowFilter, limit: 12, totals: false },
    ctx.cubeDeps,
  )
  const capabilities = query(
    ctx.db,
    { metrics: ['events', 'duration', 'tokens_total'], dims: ['capability_type'], filter: windowFilter, totals: false },
    ctx.cubeDeps,
  )
  const errored = query(ctx.db, { metrics: ['events'], dims: ['capability_type'], filter: { ...windowFilter, status: ['error'] }, totals: false }, ctx.cubeDeps)
  const compacts = query(ctx.db, { metrics: ['events'], filter: { ...windowFilter, type: ['context.compact'] } }, ctx.cubeDeps)

  const byCap = new Map(capabilities.rows.map((r) => [String(r.capability_type), Number(r.events ?? 0)]))
  const capEvents = (t: string): number => byCap.get(t) ?? 0
  const errorEvents = errored.rows.reduce((a, r) => a + Number(r.events ?? 0), 0)

  return {
    generatedAt: ctx.now(),
    window: {
      ...(filter.since === undefined ? {} : { since: String(filter.since) }),
      ...(filter.until === undefined ? {} : { until: String(filter.until) }),
      sinceTs,
      granularity,
      defaultSinceApplied,
    },
    cards: {
      tokens: {
        total: sumOf('tokens_total'),
        input: sumOf('tokens_input'),
        output: sumOf('tokens_output'),
        cacheRead: sumOf('tokens_cache_read'),
        cacheWrite: sumOf('tokens_cache_write'),
        reasoning: sumOf('tokens_reasoning'),
        basisCode: 'dedupRequestMax',
      },
      cost: costView(ctx, windowFilter),
      sessions,
      events,
    },
    activity: {
      tool: capEvents('tool'),
      skill: capEvents('skill'),
      mcp: capEvents('mcp'),
      plugin: capEvents('plugin'),
      connector: capEvents('connector'),
      command: capEvents('command'),
      subagent: capEvents('subagent'),
      hook: capEvents('hook'),
      compact: Number(compacts.totals.events ?? 0),
      errors: errorEvents,
    },
    trend: trend.rows,
    trendByHost: trendByHost.rows,
    agents: agents.rows,
    hosts: hosts.rows,
    projects: projects.rows,
    capabilities: capabilities.rows.filter((r) => String(r.capability_type) !== ''),
    banners: banners(ctx, windowFilter),
    content: { available: contentLayerPresent(ctx.db), payloads: payloadCount(ctx.db) },
  }
}
