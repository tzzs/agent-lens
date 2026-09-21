/**
 * GET /api/projects (§9 tree, §10 priority 4) — cross-agent project rows with
 * per-agent sub-rows. Projects are canonical repo roots (§4.1), so worktrees
 * and subdirectories already fold into one row; the observed cwds are echoed
 * back so a reader can verify the folding instead of trusting it.
 */
import { query } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import { costView } from './cost.ts'
import { metricFields, METRICS } from './metrics.ts'
import { parseFilter, strParam } from './request-spec.ts'
import { projectLabelMap, redactHome, rowsOf } from './resolve.ts'

function numOr(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}

export interface ProjectRow {
  projectId: string
  project: string
  canonicalRoot: string | null
  observedCwds: { cwd: string; events: number }[]
  agents: { agentId: string; sessions: number; tokensTotal: number; events: number; costApiEquiv: number | null }[]
  models: { model: string; events: number; tokensTotal: number }[]
  capabilities: { type: string; events: number }[]
  recentSessions: { id: string; agentId: string; hostId: string; lastTimestamp: number | null; title: string | null }[]
  metrics: Record<string, number | null>
}

export interface ProjectsResponse {
  filter: unknown
  rows: ProjectRow[]
  totals: Record<string, number | null>
  truncated: boolean
  cost: ReturnType<typeof costView>
  note: string
}

export function projects(ctx: ServerCtx, sp: URLSearchParams): ProjectsResponse {
  const filter = parseFilter(sp, ctx.db)
  const limitRaw = strParam(sp, 'limit')
  const limit = limitRaw === undefined ? 30 : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`invalid limit ${JSON.stringify(limitRaw)}`)

  const top = query(ctx.db, { metrics: [...METRICS], dims: ['project'], filter, limit }, ctx.cubeDeps)
  // The three mixes below are read for their rows only, so each says `totals: false`:
  // at 343k events a totals fold is a second full pass over stage 1, and here its result
  // would be discarded four times per request.
  const sub = query(
    ctx.db,
    {
      metrics: ['events', 'sessions', 'tokens_total', 'cost_api_equiv'],
      dims: ['project', 'agent'],
      filter,
      totals: false,
    },
    ctx.cubeDeps,
  )
  const modelMix = query(
    ctx.db,
    { metrics: ['events', 'tokens_total'], dims: ['project', 'model'], filter, limit: 600, totals: false },
    ctx.cubeDeps,
  )
  const capMix = query(
    ctx.db,
    { metrics: ['events'], dims: ['project', 'capability_type'], filter, limit: 600, totals: false },
    ctx.cubeDeps,
  )

  const labels = projectLabelMap(ctx.db)
  const entities = rowsOf(ctx.db, 'SELECT id, canonical_root, display_name, source FROM projects')
  // Entity metadata only: which cwd strings were seen per project. This is the
  // evidence for §4.1's worktree folding, not a statistic.
  const cwdRows = rowsOf(
    ctx.db,
    "SELECT project_id, json_extract(metadata, '$.cwd') AS cwd, COUNT(*) AS n FROM events WHERE project_id IS NOT NULL AND metadata IS NOT NULL GROUP BY project_id, cwd",
  )
  const cwdsByProject = new Map<string, { cwd: string; events: number }[]>()
  for (const r of cwdRows) {
    if (!r.cwd) continue
    const list = cwdsByProject.get(String(r.project_id)) ?? []
    list.push({ cwd: String(r.cwd), events: Number(r.n ?? 0) })
    cwdsByProject.set(String(r.project_id), list)
  }
  const sessionRows = rowsOf(
    ctx.db,
    'SELECT id, project_id, agent_id, host_id, title, last_timestamp FROM sessions ORDER BY last_timestamp DESC LIMIT 800',
  )

  const rows: ProjectRow[] = top.rows.map((r) => {
    const label = String(r.project ?? '')
    const entity = entities.find((x) => String(x.id) === label) ?? entities.find((x) => (labels.get(String(x.id)) ?? '') === label)
    const id = entity ? String(entity.id) : label
    return {
      projectId: id,
      project: label || '(none)',
      canonicalRoot: entity?.canonical_root ? redactHome(String(entity.canonical_root), ctx.homedir) : null,
      observedCwds: [...(cwdsByProject.get(id) ?? [])].sort((a, b) => b.events - a.events).slice(0, 8).map((c) => ({
        cwd: redactHome(c.cwd, ctx.homedir),
        events: c.events,
      })),
      agents: sub.rows
        .filter((s) => String(s.project) === label)
        .map((s) => ({
          agentId: String(s.agent),
          sessions: Number(s.sessions ?? 0),
          tokensTotal: Number(s.tokens_total ?? 0),
          events: Number(s.events ?? 0),
          costApiEquiv: numOr(s.cost_api_equiv),
        })),
      models: modelMix.rows
        .filter((m) => String(m.project) === label && String(m.model) !== '')
        .map((m) => ({ model: String(m.model), events: Number(m.events ?? 0), tokensTotal: Number(m.tokens_total ?? 0) })),
      capabilities: capMix.rows
        .filter((c) => String(c.project) === label && String(c.capability_type) !== '')
        .map((c) => ({ type: String(c.capability_type), events: Number(c.events ?? 0) })),
      recentSessions: sessionRows
        .filter((s) => String(s.project_id ?? '') === id)
        .slice(0, 8)
        .map((s) => ({
          id: String(s.id),
          agentId: String(s.agent_id ?? ''),
          hostId: String(s.host_id ?? ''),
          lastTimestamp: numOr(s.last_timestamp),
          title: s.title === null || s.title === undefined ? null : String(s.title),
        })),
      metrics: metricFields(r),
    }
  })

  return {
    filter,
    rows,
    totals: top.totals,
    truncated: top.truncated,
    cost: costView(ctx, filter),
    note: 'one row per canonical repo root (§4.1): worktrees and subdirectories fold into the parent project, so a row can cover several paths',
  }
}
