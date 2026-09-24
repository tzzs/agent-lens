/**
 * GET /api/agents (§10 priority 5 — "make it work, do not polish").
 *
 * §18 item 6 makes `host` part of agent identity, so agent rows carry a host
 * breakdown instead of one merged line. Every metric is a cube row; the only
 * direct reads are entity metadata (display names), which the cube does not carry.
 */
import { query } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { costView } from './cost.ts'
import { METRICS, metricFields, numOr } from './metrics.ts'
import { parseFilter } from './request-spec.ts'
import { rowsOf } from './resolve.ts'

export interface AgentRow {
  agentId: string
  displayName: string | null
  /** False when the agent is known but has no events in the window: "not recorded", not zeros. */
  recorded: boolean
  billingMode: string
  /** True when some of this agent's models bill at another mode, so `billingMode` is only its default. */
  mixedBilling: boolean
  hosts: { host: string; events: number; sessions: number }[]
  capabilities: { type: string; events: number; errors: number }[]
  models: { model: string; events: number; tokensTotal: number; costApiEquiv: number | null }[]
  metrics: Record<string, number | null>
}

export interface AgentsResponse {
  filter: unknown
  rows: AgentRow[]
  totals: Record<string, number | null>
  cost: ReturnType<typeof costView>
}

export function agents(ctx: ServerCtx, sp: URLSearchParams): AgentsResponse {
  const filter = parseFilter(sp, ctx.db)
  const perAgent = query(ctx.db, { metrics: [...METRICS], dims: ['agent'], filter }, ctx.cubeDeps)
  const hosts = query(ctx.db, { metrics: ['events', 'sessions'], dims: ['agent', 'host'], filter, totals: false }, ctx.cubeDeps)
  const caps = query(ctx.db, { metrics: ['events'], dims: ['agent', 'capability_type'], filter, totals: false }, ctx.cubeDeps)
  const capErrs = query(
    ctx.db,
    { metrics: ['events'], dims: ['agent', 'capability_type'], filter: { ...filter, status: ['error'] }, totals: false },
    ctx.cubeDeps,
  )
  const modelMix = query(
    ctx.db,
    { metrics: ['events', 'tokens_total', 'cost_api_equiv'], dims: ['agent', 'model'], filter, limit: 400, totals: false },
    ctx.cubeDeps,
  )
  const meta = rowsOf(ctx.db, 'SELECT id, display_name, detected_version, data_root FROM agents')
  // Same rule as cost.ts: ctx.billingModeFor is file-backed whenever a DB path is known;
  // the literal 'api' only covers a DB-less in-process ctx.
  const modeFor = ctx.billingModeFor ?? ((): string => 'api')

  // Computed before the rows because a billing label is only honest next to the per-model
  // modes the cost fold already resolved — a second read of the same cube would be a second
  // vintage of the same rows (§14).
  const cost = costView(ctx, filter)
  const rows: AgentRow[] = perAgent.rows.map((r) => {
    const agentId = String(r.agent)
    const slice = cost.perAgent.find((s) => s.agentId === agentId)
    const m = meta.find((x) => String(x.id) === agentId)
    return {
      agentId,
      displayName: m?.display_name ? String(m.display_name) : null,
      recorded: true,
      billingMode: modeFor(agentId),
      mixedBilling: slice?.mixedBilling ?? false,
      hosts: hosts.rows
        .filter((h) => String(h.agent) === agentId)
        .map((h) => ({ host: String(h.host), events: Number(h.events ?? 0), sessions: Number(h.sessions ?? 0) })),
      capabilities: caps.rows
        .filter((c) => String(c.agent) === agentId && String(c.capability_type) !== '')
        .map((c) => ({
          type: String(c.capability_type),
          events: Number(c.events ?? 0),
          errors: capErrs.rows
            .filter((e) => String(e.agent) === agentId && String(e.capability_type) === String(c.capability_type))
            .reduce((a, e) => a + Number(e.events ?? 0), 0),
        })),
      models: modelMix.rows
        .filter((mm) => String(mm.agent) === agentId && String(mm.model) !== '')
        .map((mm) => ({
          model: String(mm.model),
          events: Number(mm.events ?? 0),
          tokensTotal: Number(mm.tokens_total ?? 0),
          costApiEquiv: numOr(mm.cost_api_equiv),
        })),
      metrics: metricFields(r),
    }
  })

  // Known agents with nothing in this window get an explicit unavailable row, so
  // the UI never prints "0 sessions" for an agent that simply did not run (§14).
  const seen = new Set(rows.map((r) => r.agentId))
  for (const m of meta) {
    const agentId = String(m.id)
    if (seen.has(agentId)) continue
    rows.push({
      agentId,
      displayName: m.display_name ? String(m.display_name) : null,
      recorded: false,
      billingMode: modeFor(agentId),
      mixedBilling: false,
      hosts: [],
      capabilities: [],
      models: [],
      metrics: {},
    })
  }

  return { filter, rows, totals: perAgent.totals, cost }
}
