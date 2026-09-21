/**
 * GET /api/sessions and GET /api/sessions/:id (§10 priority 2 — the
 * differentiating screen).
 *
 * The session LIST is a cube query grouped by the `session` dim, joined to the
 * `sessions` entity rows for labels; the TIMELINE is the metric layer read in
 * `raw_seq` order with the content layer merged in only where it exists.
 * When `--no-content` was used the response carries `contentAvailable: false`
 * so the UI renders a metrics-only waterfall instead of an error (§3.2).
 */
import { describeQuery, query, type QueryFilter, type Row } from '@agentlens/query'
import { rowToEvent } from '@agentlens/storage'
import type { AgentEvent } from '@agentlens/event-model'
import type { ServerCtx } from './types.ts'
import { ApiError } from './errors.ts'
import { contentLayerPresent, loadPayloads, payloadCountBySession, type PayloadView } from './content.ts'
import { parseFilter, strParam } from './request-spec.ts'
import { projectLabelMap, rowsOf } from './resolve.ts'

export interface SessionRow {
  sessionId: string
  agentId: string
  hostId: string
  projectId: string
  project: string
  title: string | null
  firstTimestamp: number | null
  lastTimestamp: number | null
  events: number
  tokensTotal: number
  durationMs: number
  costApiEquiv: number | null
  payloads: number
  contentAvailable: boolean
}

export interface SessionListResponse {
  rows: SessionRow[]
  totalSessions: number
  truncated: boolean
  content: { available: boolean }
  filter: QueryFilter
}

export interface TimelineNode {
  id: string
  type: string
  subtype: string | null
  timestamp: number | null
  rawSeq: number | null
  requestId: string | null
  parentEventId: string | null
  agentId: string
  hostId: string
  model: { provider: string; name: string } | null
  capability: { type: string; name: string; provider: string | null } | null
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number } | null
  usageSource: string
  durationMs: number | null
  status: string
  errorFingerprint: string | null
  metadata: Record<string, unknown> | null
  payloads: PayloadView[]
}

export interface SessionDetailResponse {
  session: {
    id: string
    agentId: string
    hostId: string
    projectId: string | null
    project: string | null
    title: string | null
    firstTimestamp: number | null
    lastTimestamp: number | null
    eventCount: number
  }
  contentAvailable: boolean
  /** Present so the degraded mode is explainable in the UI, not just visible. */
  contentNote: string
  totals: Record<string, number | null>
  nodes: TimelineNode[]
  explain: string
}

export function listSessions(ctx: ServerCtx, sp: URLSearchParams): SessionListResponse {
  const filter = parseFilter(sp, ctx.db)
  const limit = strParam(sp, 'limit') === undefined ? 50 : Number(strParam(sp, 'limit'))
  const res = query(
    ctx.db,
    { metrics: ['events', 'duration', 'tokens_total', 'cost_api_equiv'], dims: ['session'], filter },
    ctx.cubeDeps,
  )
  const labels = projectLabelMap(ctx.db)
  const bySession = new Map(res.rows.map((r) => [String(r.session), r]))
  const meta = rowsOf(
    ctx.db,
    'SELECT id, agent_id, host_id, project_id, title, first_timestamp, last_timestamp FROM sessions ORDER BY last_timestamp DESC',
  )
  const contents = payloadCountBySession(
    ctx.db,
    meta.map((m) => String(m.id)),
  )
  const globalContent = contentLayerPresent(ctx.db)

  const rows: SessionRow[] = []
  for (const m of meta) {
    const id = String(m.id)
    const agg = bySession.get(id)
    if (!agg) continue // filtered out by the cube, or metricless
    const payloads = contents.get(id) ?? 0
    rows.push({
      sessionId: id,
      agentId: String(m.agent_id ?? ''),
      hostId: String(m.host_id ?? ''),
      projectId: m.project_id === null || m.project_id === undefined ? '' : String(m.project_id),
      project: m.project_id === null ? '—' : (labels.get(String(m.project_id)) ?? String(m.project_id)),
      title: m.title === null || m.title === undefined ? null : String(m.title),
      firstTimestamp: m.first_timestamp === null || m.first_timestamp === undefined ? null : Number(m.first_timestamp),
      lastTimestamp: m.last_timestamp === null || m.last_timestamp === undefined ? null : Number(m.last_timestamp),
      events: Number(agg.events ?? 0),
      tokensTotal: Number(agg.tokens_total ?? 0),
      durationMs: Number(agg.duration ?? 0),
      costApiEquiv: agg.cost_api_equiv === null || agg.cost_api_equiv === undefined ? null : Number(agg.cost_api_equiv),
      payloads,
      contentAvailable: payloads > 0,
    })
    if (rows.length >= limit) break
  }
  return {
    rows,
    totalSessions: res.rows.length,
    truncated: res.truncated,
    content: { available: globalContent },
    filter,
  }
}

/** Exact id first, then unambiguous prefix — same rule as `agl session <id>`. */
export function resolveSessionId(db: ServerCtx['db'], wanted: string): string {
  const exact = db.prepare('SELECT id FROM sessions WHERE id = ?').get(wanted) as { id: string } | undefined
  if (exact) return exact.id
  const pref = rowsOf(db, 'SELECT id FROM sessions WHERE id LIKE ? LIMIT 2', `${wanted}%`)
  if (pref.length === 1) return String(pref[0]!.id)
  if (pref.length === 0) throw ApiError.notFound(`no session matches ${JSON.stringify(wanted)}`, { wanted })
  throw ApiError.conflict(`session prefix ${JSON.stringify(wanted)} is ambiguous`, { wanted, matches: pref.map((p) => String(p.id)) })
}

export function sessionDetail(ctx: ServerCtx, wanted: string): SessionDetailResponse {
  const sessionId = resolveSessionId(ctx.db, wanted)
  const spec = { metrics: ['events', 'sessions', 'tokens_total', 'tokens_input', 'tokens_output', 'duration', 'cost_api_equiv'] as const, filter: { session: [sessionId] } }
  const agg = query(ctx.db, { metrics: [...spec.metrics], filter: spec.filter }, ctx.cubeDeps)
  // raw_seq is the source's own order (the timeline must read like the log did);
  // timestamp breaks ties across sources.
  const raw = rowsOf(
    ctx.db,
    'SELECT * FROM events WHERE session_id = ? ORDER BY raw_seq IS NULL, raw_seq, timestamp, id',
    sessionId,
  )
  const events: AgentEvent[] = raw.map((r) => rowToEvent(r))
  const payloads = loadPayloads(
    ctx.db,
    events.map((e) => e.id),
  )
  const contentAvailable = payloads.size > 0
  const labels = projectLabelMap(ctx.db)
  const meta = rowsOf(
    ctx.db,
    'SELECT id, agent_id, host_id, project_id, title, first_timestamp, last_timestamp, event_count FROM sessions WHERE id = ?',
    sessionId,
  )[0] as Row | undefined

  const nodes: TimelineNode[] = events.map((e) => ({
    id: e.id,
    type: e.type,
    subtype: e.subtype ?? null,
    timestamp: e.timestamp,
    rawSeq: e.rawSeq,
    requestId: e.requestId ?? null,
    parentEventId: e.parentEventId ?? null,
    agentId: e.agentId,
    hostId: e.hostId,
    model: e.model ? { provider: e.model.provider, name: e.model.name } : null,
    capability: e.capability ? { type: e.capability.type, name: e.capability.name, provider: e.capability.provider ?? null } : null,
    usage: e.usage
      ? {
          inputTokens: e.usage.inputTokens,
          outputTokens: e.usage.outputTokens,
          cacheReadTokens: e.usage.cacheReadTokens,
          cacheWriteTokens: e.usage.cacheWriteTokens,
          reasoningTokens: e.usage.reasoningTokens,
        }
      : null,
    usageSource: e.usageSource,
    durationMs: e.durationMs ?? null,
    status: e.status,
    errorFingerprint: e.errorFingerprint ?? null,
    metadata: e.metadata ?? null,
    payloads: contentAvailable ? (payloads.get(e.id) ?? []) : [],
  }))

  return {
    session: {
      id: sessionId,
      agentId: String(meta?.agent_id ?? ''),
      hostId: String(meta?.host_id ?? ''),
      projectId: meta?.project_id === null || meta?.project_id === undefined ? null : String(meta.project_id),
      project:
        meta?.project_id === null || meta?.project_id === undefined
          ? null
          : (labels.get(String(meta.project_id)) ?? String(meta.project_id)),
      title: meta?.title === null || meta?.title === undefined ? null : String(meta.title),
      firstTimestamp: meta?.first_timestamp === null || meta?.first_timestamp === undefined ? null : Number(meta.first_timestamp),
      lastTimestamp: meta?.last_timestamp === null || meta?.last_timestamp === undefined ? null : Number(meta.last_timestamp),
      eventCount: meta?.event_count === null || meta?.event_count === undefined ? nodes.length : Number(meta.event_count),
    },
    contentAvailable,
    contentNote: contentAvailable
      ? 'content layer present for this session'
      : 'content layer off or expired (payload TTL) — metrics-only timeline; re-scan without --no-content to capture message/tool text',
    totals: agg.totals,
    nodes,
    explain: describeQuery({ metrics: [...spec.metrics], filter: spec.filter }),
  }
}
