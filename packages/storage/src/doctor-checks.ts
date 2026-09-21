/**
 * §11 doctor checks that the CLI and the served report have to agree on (§14), so they live
 * one layer below both of them rather than being copied into either. `packages/storage` is
 * the host because these checks read only stored rows (`events` / `sources` / `agents`) plus
 * event-model's fold, and §5.4's arrows let both ends reach that — the reverse edge (a server
 * importing an app) is exactly what used to make the two doctors print different numbers.
 *
 * Nothing here renders or phrases anything: each doctor keeps its own wording, and the
 * adapter-side inputs (installed parser versions, declared policies, session history files)
 * stay with whoever owns the adapters.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  aggregateRequestTokens,
  aggregateUsage,
  DEFAULT_AGGREGATION,
  type AgentEvent,
  type AggregationMode,
  type AggregationPolicy,
  type Usage,
} from '@agentlens/event-model'
import { rowToEvent } from './query-shape.ts'
import { loadAgentAggregations } from './write.ts'

type Row = Record<string, unknown>

function rowsOf(db: DatabaseSync, sql: string, ...params: unknown[]): Row[] {
  const stmt = db.prepare(sql)
  const out = params.length ? stmt.all(...(params as never[])) : stmt.all()
  return (out as Row[]).map((r) => ({ ...r }))
}

/** The "no fold at all" baseline: what a report that ignores §3.1 would print. */
const PER_RECORD_SUM: AggregationPolicy = Object.freeze({ mode: 'per_record_sum', subagentsIncluded: true })

function grand(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
}

/** One agent's row in §11's Usage quality block. */
export interface AgentUsageQuality {
  agentId: string
  events: number
  reported: number
  estimated: number
  missing: number
  /** §11: records the per-request fallback key had to cover, counted individually. */
  noRequestId: number
  noRequestIdWithUsage: number
  usageRows: number
  /** Raw SUM over every usage row: what an unfold report prints. */
  naive: number
  /** The cube's total for this agent — the number the product actually reports. */
  folded: number
  /** event-model's fold of the same rows under the same policy: the cross-check. */
  modelFolded: number
  /** What a single GLOBAL `request_max` would have produced, for the mixed-fold warning. */
  globalFolded: number
  /** Fold groups the policy produced: 1 per request under `request_max`, 1 per row otherwise. */
  groups: number
  policy: AggregationPolicy
  /** Where `policy` came from: persisted rows, or the default because nothing was. */
  policySource: 'persisted' | 'default'
  /** The installed adapter's own declaration, when the caller has adapters to ask. */
  declared: AggregationPolicy | null
}

/** The caller's cube read: `query(db, {metrics:['events','tokens_total'],dims:['agent']}, {aggregation: persisted})`. */
export interface CubeAgentTotal {
  agentId: string
  events: number
  tokensTotal: number
}

/**
 * §11 Usage quality + §18 row 2: per agent, the raw sum, that agent's OWN fold, and what a
 * global rule would have done to it.
 *
 * `folded` is handed in by the caller because only the caller can ask the cube (§5.4: query
 * sits above storage); comparing it against `modelFolded` is what surfaces a fold that went
 * wrong on one of the two paths instead of shipping either number.
 */
export function usageQuality(
  db: DatabaseSync,
  cubeTotals: readonly CubeAgentTotal[] = [],
  declared: Record<string, AggregationPolicy | undefined> = {},
): AgentUsageQuality[] {
  const persisted = loadAgentAggregations(db)

  const bySrc = rowsOf(
    db,
    `SELECT COALESCE(agent_id, '') AS agent, COALESCE(usage_source, '') AS source, COUNT(*) AS n FROM events GROUP BY agent, source`,
  )
  const eventCounts = new Map<string, { reported: number; estimated: number; missing: number }>()
  for (const r of bySrc) {
    const agent = String(r.agent)
    const cur = eventCounts.get(agent) ?? { reported: 0, estimated: 0, missing: 0 }
    const n = Number(r.n)
    const source = String(r.source)
    if (source === 'reported') cur.reported += n
    else if (source === 'estimated') cur.estimated += n
    else cur.missing += n
    eventCounts.set(agent, cur)
  }

  const noReq = new Map(
    rowsOf(
      db,
      `SELECT COALESCE(agent_id, '') AS agent,
              COUNT(*) AS n,
              SUM(CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                         OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL
                         OR reasoning_tokens IS NOT NULL THEN 1 ELSE 0 END) AS with_usage
       FROM events WHERE request_id IS NULL OR request_id = ''
       GROUP BY agent`,
    ).map((r) => [String(r.agent), { n: Number(r.n), withUsage: Number(r.with_usage ?? 0) }]),
  )

  // The fold comparison needs the rows themselves; only rows that could contribute.
  const usageRows = rowsOf(
    db,
    `SELECT * FROM events WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
       OR cache_read_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL OR reasoning_tokens IS NOT NULL`,
  )
  const byAgent = new Map<string, AgentEvent[]>()
  for (const row of usageRows) {
    const ev = rowToEvent(row)
    const list = byAgent.get(ev.agentId)
    if (list) list.push(ev)
    else byAgent.set(ev.agentId, [ev])
  }

  const totals = new Map(cubeTotals.map((t) => [t.agentId, t]))
  const agents = new Set<string>([...totals.keys(), ...byAgent.keys(), ...eventCounts.keys()])
  const out: AgentUsageQuality[] = []
  for (const agentId of [...agents].sort()) {
    const total = totals.get(agentId)
    const rows = byAgent.get(agentId) ?? []
    const policy = persisted[agentId] ?? DEFAULT_AGGREGATION
    const fold = aggregateUsage(rows, policy)
    const counts = eventCounts.get(agentId) ?? { reported: 0, estimated: 0, missing: 0 }
    const req = noReq.get(agentId) ?? { n: 0, withUsage: 0 }
    out.push({
      agentId,
      events: total?.events ?? 0,
      ...counts,
      noRequestId: req.n,
      noRequestIdWithUsage: req.withUsage,
      usageRows: rows.length,
      naive: grand(aggregateUsage(rows, PER_RECORD_SUM).usage),
      folded: total?.tokensTotal ?? 0,
      modelFolded: grand(fold.usage),
      globalFolded: grand(aggregateRequestTokens(rows).deduped),
      groups: fold.groups,
      policy,
      policySource: persisted[agentId] ? 'persisted' : 'default',
      declared: declared[agentId] ?? null,
    })
  }
  return out
}

/** The fold rules actually present in one database; more than one is §18 row 2's mixed case. */
export function usageFoldModes(qualities: readonly AgentUsageQuality[]): AggregationMode[] {
  return [...new Set(qualities.map((q) => q.policy.mode))].sort() as AggregationMode[]
}

export interface ParserVersionDrift {
  /** Sources whose agent has an adapter in the caller's build. */
  checked: number
  /** Of those, the ones a re-scan will read again from byte 0. */
  drifted: number
  /** Sources belonging to an agent the caller cannot map — drift is unknowable, not clean. */
  unmapped: number
  /** Sources never scanned (NULL parser_version): a placeholder row, not a stale one. */
  unscanned: number
  stale: { agentId: string; parserVersion: number; sources: number }[]
}

/**
 * §5.3 drift signal: a source stored by an older parser is re-read in full by the next scan,
 * which is safe only because writes are idempotent (§4.2). `currentVersions` is whatever the
 * caller's adapter set reports — the CLI passes its probes, the server its injected adapters.
 */
export function parserVersionDrift(db: DatabaseSync, currentVersions: Record<string, number | undefined>): ParserVersionDrift {
  const byVersion = rowsOf(
    db,
    `SELECT COALESCE(agent_id, '') AS agent, parser_version AS v, COUNT(*) AS n FROM sources
     WHERE parser_version IS NOT NULL GROUP BY agent, v`,
  )
  const unscanned = Number(rowsOf(db, 'SELECT COUNT(*) AS n FROM sources WHERE parser_version IS NULL')[0]?.n ?? 0)
  let checked = 0
  let drifted = 0
  let unmapped = 0
  const stale: { agentId: string; parserVersion: number; sources: number }[] = []
  for (const r of byVersion) {
    const n = Number(r.n)
    const agentId = String(r.agent)
    const current = currentVersions[agentId]
    if (current === undefined) {
      unmapped += n
      continue
    }
    checked += n
    const stored = Number(r.v)
    if (stored !== current) {
      drifted += n
      stale.push({ agentId, parserVersion: stored, sources: n })
    }
  }
  stale.sort((a, b) => b.sources - a.sources || a.agentId.localeCompare(b.agentId))
  return { checked, drifted, unmapped, unscanned, stale }
}

export interface SubagentLinkage {
  agentId: string
  total: number
  /** Of those, the ones whose parent the time heuristic could not resolve (§4.4 row 8). */
  orphan: number
}

/** §4.4 row 8: the subagent parent link has no foreign key behind it, so its gaps are a fact to print. */
export function subagentOrphans(db: DatabaseSync): SubagentLinkage[] {
  return rowsOf(
    db,
    `SELECT COALESCE(agent_id, '') AS agent, COUNT(*) AS total,
            SUM(CASE WHEN parent_event_id IS NULL THEN 1 ELSE 0 END) AS orphan
     FROM events
     WHERE type IN ('subagent.start', 'subagent.end') OR capability_type = 'subagent'
        OR json_extract(metadata, '$.subagentThread') IS 1
     GROUP BY agent ORDER BY total DESC`,
  ).map((r) => ({ agentId: String(r.agent), total: Number(r.total), orphan: Number(r.orphan ?? 0) }))
}

export interface RetentionCounts {
  /** Sources upstream deleted. */
  gone: number
  /** Sources upstream rotated out; the collector moved on, the events stay. */
  rotated: number
  /** Sources read to their end. */
  active: number
}

/** §4.4 row 4: coverage stops where upstream retention stops, and the report has to say so. */
export function sourceRetention(db: DatabaseSync): RetentionCounts {
  const row = rowsOf(
    db,
    `SELECT SUM(CASE WHEN status = 'gone' THEN 1 ELSE 0 END) AS gone,
            SUM(CASE WHEN status = 'rotated' THEN 1 ELSE 0 END) AS rotated,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
     FROM sources`,
  )[0]
  return { gone: Number(row?.gone ?? 0), rotated: Number(row?.rotated ?? 0), active: Number(row?.active ?? 0) }
}
