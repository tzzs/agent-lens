/**
 * GET /api/capabilities (§10 priority 3) — the layer ccusage has no concept of:
 * which tool / skill / MCP / hook / subagent burned what, how long it took and
 * how often it failed. All counts are cube rows; §18 item 5 additionally makes
 * "this agent does not record hooks at all" distinguishable from "0 hook calls".
 */
import { describeQuery, query, type QueryFilter } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { CAPABILITY_TYPES } from '@agentlens/event-model'
import { ApiError } from './errors.ts'
import { parseFilter, strParam } from './request-spec.ts'

export interface CapabilityNameRow {
  name: string
  events: number
  durationMs: number
  tokensTotal: number
  costApiEquiv: number | null
  errors: number
}

export interface CapabilityTypeRow {
  type: string
  events: number
  durationMs: number
  tokensTotal: number
  costApiEquiv: number | null
  errors: number
  agents: { agentId: string; events: number; sessions: number }[]
  names: CapabilityNameRow[]
}

export interface CatalogView {
  available: boolean
  note: string
  installed: number
  neverUsed: { agentId: string | null; type: string; name: string; source: string }[]
}

export interface CapabilityResponse {
  filter: QueryFilter
  types: CapabilityTypeRow[]
  /** §18 item 5: capability types recorded per agent (absence is not zero). */
  supports: { agentId: string; recorded: string[]; missing: string[] }[]
  catalog: CatalogView
  explain: string
}

function numOr(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}

export async function capabilities(ctx: ServerCtx, sp: URLSearchParams): Promise<CapabilityResponse> {
  const filter = parseFilter(sp, ctx.db)
  const nameLimit = strParam(sp, 'names') === undefined ? 25 : Number(strParam(sp, 'names'))
  if (!Number.isInteger(nameLimit) || nameLimit < 0) throw ApiError.badRequest(`invalid names ${JSON.stringify(strParam(sp, 'names'))}`)

  const base = { metrics: ['events', 'duration', 'tokens_total', 'cost_api_equiv'] as const, filter }
  const perType = query(ctx.db, { metrics: [...base.metrics], dims: ['capability_type'], filter, totals: false }, ctx.cubeDeps)
  const typeErrors = query(ctx.db, { metrics: ['events'], dims: ['capability_type'], filter: { ...filter, status: ['error'] }, totals: false }, ctx.cubeDeps)
  const agentMix = query(ctx.db, { metrics: ['events', 'sessions'], dims: ['capability_type', 'agent'], filter, totals: false }, ctx.cubeDeps)
  const nameMix = query(
    ctx.db,
    {
      metrics: [...base.metrics],
      dims: ['capability_type', 'capability_name'],
      filter,
      order: 'metric:events:desc',
      limit: nameLimit * 4,
      totals: false,
    },
    ctx.cubeDeps,
  )
  const nameErrors = query(
    ctx.db,
    { metrics: ['events'], dims: ['capability_type', 'capability_name'], filter: { ...filter, status: ['error'] }, totals: false },
    ctx.cubeDeps,
  )
  const supportsRows = query(ctx.db, { metrics: ['events'], dims: ['agent', 'capability_type'], filter, totals: false }, ctx.cubeDeps)

  const errByType = new Map(typeErrors.rows.map((r) => [String(r.capability_type), Number(r.events ?? 0)]))
  const errByName = new Map(
    nameErrors.rows.map((r) => [`${String(r.capability_type)}::${String(r.capability_name)}`, Number(r.events ?? 0)]),
  )

  const types: CapabilityTypeRow[] = perType.rows
    .filter((r) => String(r.capability_type) !== '')
    .map((r) => {
      const type = String(r.capability_type)
      return {
        type,
        events: Number(r.events ?? 0),
        durationMs: Number(r.duration ?? 0),
        tokensTotal: Number(r.tokens_total ?? 0),
        costApiEquiv: numOr(r.cost_api_equiv),
        errors: errByType.get(type) ?? 0,
        agents: agentMix.rows
          .filter((a) => String(a.capability_type) === type)
          .map((a) => ({ agentId: String(a.agent), events: Number(a.events ?? 0), sessions: Number(a.sessions ?? 0) })),
        names: nameMix.rows
          .filter((n) => String(n.capability_type) === type)
          .map((n) => ({
            name: String(n.capability_name),
            events: Number(n.events ?? 0),
            durationMs: Number(n.duration ?? 0),
            tokensTotal: Number(n.tokens_total ?? 0),
            costApiEquiv: numOr(n.cost_api_equiv),
            errors: errByName.get(`${type}::${String(n.capability_name)}`) ?? 0,
          }))
          .sort((a, b) => b.events - a.events)
          .slice(0, nameLimit),
      }
    })
    .sort((a, b) => b.events - a.events)

  const byAgent = new Map<string, Set<string>>()
  for (const r of supportsRows.rows) {
    const agent = String(r.agent)
    const type = String(r.capability_type)
    if (!type) continue
    const set = byAgent.get(agent) ?? new Set<string>()
    set.add(type)
    byAgent.set(agent, set)
  }
  const supports = [...byAgent.entries()].map(([agentId, set]) => ({
    agentId,
    recorded: [...set].sort(),
    missing: CAPABILITY_TYPES.filter((t) => !set.has(t)),
  }))

  // §5.1: static catalogs are an adapter capability; without an injected catalog the
  // honest answer is "unknown", which the UI renders as unavailable — never 0.
  const used = new Set(nameMix.rows.map((r) => `${String(r.capability_type)}::${String(r.capability_name)}`))
  const catalog = await buildCatalogView(ctx, used)

  return {
    filter,
    types,
    supports,
    catalog,
    explain: describeQuery({ metrics: [...base.metrics], dims: ['capability_type', 'capability_name'], filter }),
  }
}

/**
 * "Installed but never used" (§11 Capabilities block). The catalog is injected by
 * the host process because reading it needs adapter code, which the server must
 * not depend on at compile time (§5.4). A failed provider degrades to
 * "unavailable", never an empty list that would read as "nothing installed".
 */
async function buildCatalogView(ctx: ServerCtx, used: Set<string>): Promise<CatalogView> {
  if (!ctx.capabilityCatalog) {
    return {
      available: false,
      note: 'no capability catalog injected in this build (adapters expose capabilities() from M6)',
      installed: 0,
      neverUsed: [],
    }
  }
  let entries
  try {
    entries = await ctx.capabilityCatalog()
  } catch (err) {
    return {
      available: false,
      note: `capability catalog unreadable: ${(err as Error).message}`,
      installed: 0,
      neverUsed: [],
    }
  }
  const neverUsed = entries
    .filter((e) => !used.has(`${String(e.type)}::${String(e.name)}`))
    .map((e) => ({ agentId: e.agentId ?? null, type: String(e.type), name: String(e.name), source: String(e.source) }))
  return {
    available: true,
    note: `${entries.length} catalogued entries · ${neverUsed.length} never observed in the event stream`,
    installed: entries.length,
    neverUsed,
  }
}

/** Catalog summary for callers (doctor) that did not already load the name breakdown. */
export async function catalogSummary(ctx: ServerCtx, filter: QueryFilter): Promise<CatalogView> {
  if (!ctx.capabilityCatalog) return buildCatalogView(ctx, new Set())
  const used = new Set(
    query(
      ctx.db,
      { metrics: ['events'], dims: ['capability_type', 'capability_name'], filter, limit: 5000, totals: false },
      ctx.cubeDeps,
    ).rows.map((r) => `${String(r.capability_type)}::${String(r.capability_name)}`),
  )
  return buildCatalogView(ctx, used)
}
