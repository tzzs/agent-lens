/**
 * `doctor`'s Usage quality section (§11). Three views of the same rows are compared,
 * never re-derived: the cube's policy-aware SQL fold (§7/§18), event-model's own
 * `aggregateUsage`/`aggregateRequestTokens` kernel, and the raw per-record SUM a naive
 * report would have printed. When two of them disagree the number is wrong somewhere,
 * and this section is where that has to surface.
 *
 * §18 row 2 made the fold a per-agent declaration, so every number below is labelled
 * with the policy that produced it and no global rule is ever applied to a mixed database.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  aggregateRequestTokens,
  aggregateUsage,
  DEFAULT_AGGREGATION,
  type AgentAdapter,
  type AgentEvent,
  type AggregationPolicy,
  type Usage,
} from '@agentlens/event-model'
import { loadAgentAggregations, rowToEvent } from '@agentlens/storage'
import { query } from '@agentlens/query'
import type { Ctx } from '../context.ts'
import { GLYPH, formatCount, formatTokens } from '../render.ts'
import { rowsOf } from './shared.ts'

/** Grand total of the five buckets — the presentation twin of `tokens_total`. */
function grand(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.reasoningTokens
}

const PER_RECORD_SUM: AggregationPolicy = Object.freeze({ mode: 'per_record_sum', subagentsIncluded: true })

/**
 * Two records of the same rule, deliberately kept apart so their disagreement is visible:
 * the persisted one (`agents.aggregation_mode`, written at scan time and read by `queryDeps`
 * for every real query — the rule the numbers above were produced with) and the one the
 * installed adapter declares now. Reading the persisted map instead of the adapter is what
 * makes the section work for an agent whose package is absent from this build.
 */
export interface PolicyRecord {
  persisted: Record<string, AggregationPolicy>
  declared: Record<string, AggregationPolicy | undefined>
}

export function usagePolicies(db: DatabaseSync, adapters: readonly AgentAdapter[]): PolicyRecord {
  const declared: Record<string, AggregationPolicy | undefined> = {}
  for (const a of adapters) declared[a.id] = a.aggregation ?? undefined
  return { persisted: loadAgentAggregations(db), declared }
}

export interface AgentQuality {
  agentId: string
  events: number
  reported: number
  estimated: number
  missing: number
  /** Records the §3.1 fallback key had to cover. */
  noRequestId: number
  noRequestIdWithUsage: number
  usageRows: number
  /** Raw SUM over every usage row: what a report that ignores the fold prints. */
  naive: number
  /** The cube's policy-aware total: the number the product reports. */
  folded: number
  /** event-model's fold of the same rows under the same policy — the cross-check. */
  modelFolded: number
  /** What a single GLOBAL `request_max` would have produced, for the mixed-fold warning. */
  globalFolded: number
  /** Fold groups the policy produced: 1 per request under `request_max`, 1 per row otherwise. */
  groups: number
  policy: AggregationPolicy
  /** Where `policy` came from: persisted rows, or the default because nothing was. */
  policySource: 'persisted' | 'default'
  /** The installed adapter's own declaration, if any. */
  declared: AggregationPolicy | null
}

export function measureUsageQuality(db: DatabaseSync, adapters: readonly AgentAdapter[]): AgentQuality[] {
  const { persisted, declared } = usagePolicies(db, adapters)

  const cube = query(
    db,
    { metrics: ['events', 'tokens_total'], dims: ['agent'] },
    { aggregation: persisted },
  )
  const srcRes = query(db, { metrics: ['events'], dims: ['agent', 'usage_source'] })
  const eventCounts = new Map<string, { reported: number; estimated: number; missing: number }>()
  for (const r of srcRes.rows) {
    const agent = String(r.agent)
    const cur = eventCounts.get(agent) ?? { reported: 0, estimated: 0, missing: 0 }
    const n = Number(r.events)
    const source = String(r.usage_source)
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
    const agent = ev.agentId
    const list = byAgent.get(agent)
    if (list) list.push(ev)
    else byAgent.set(agent, [ev])
  }

  const agents = new Set<string>([
    ...cube.rows.map((r) => String(r.agent)),
    ...byAgent.keys(),
    ...eventCounts.keys(),
  ])
  const out: AgentQuality[] = []
  for (const agentId of [...agents].sort()) {
    const row = cube.rows.find((r) => String(r.agent) === agentId)
    const rows = byAgent.get(agentId) ?? []
    const policy = persisted[agentId] ?? DEFAULT_AGGREGATION
    const naive = grand(aggregateUsage(rows, PER_RECORD_SUM).usage)
    const fold = aggregateUsage(rows, policy)
    // event-model's own naive-vs-folded pair for the `request_max` rule (§11's dedup line);
    // for any other policy its deduped side is kept only to show what a wrongly global
    // rule would have done to this agent's rows.
    const perRequest = aggregateRequestTokens(rows)
    const counts = eventCounts.get(agentId) ?? { reported: 0, estimated: 0, missing: 0 }
    const req = noReq.get(agentId) ?? { n: 0, withUsage: 0 }
    out.push({
      agentId,
      events: Number(row?.events ?? 0),
      ...counts,
      noRequestId: req.n,
      noRequestIdWithUsage: req.withUsage,
      usageRows: rows.length,
      naive,
      folded: Number(row?.tokens_total ?? 0),
      modelFolded: grand(fold.usage),
      globalFolded: grand(perRequest.deduped),
      groups: fold.groups,
      policy,
      policySource: persisted[agentId] ? 'persisted' : 'default',
      declared: declared[agentId] ?? null,
    })
  }
  return out
}

function pctOf(n: number, total: number): string {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`
}

function policyLabel(q: AgentQuality): string {
  const source =
    q.policySource === 'persisted'
      ? 'persisted with the stored rows, read back at query time (§18 row 2)'
      : 'DEFAULT_AGGREGATION — no policy persisted for this agent, so the cube defaulted'
  return `fold ${q.policy.mode} · ${q.policy.subagentsIncluded ? 'subagents counted' : 'subagents excluded'} (${source})`
}

export function renderUsageQuality(
  ctx: Ctx,
  qualities: readonly AgentQuality[],
  adapters: readonly AgentAdapter[],
): void {
  if (qualities.length === 0) {
    ctx.out(`${GLYPH.none} no events ingested — nothing to quality-check`)
    return
  }
  for (const q of qualities) {
    const noReq = q.noRequestId > 0
      ? ` (${formatCount(q.noRequestId)} records without request_id, counted individually${q.noRequestIdWithUsage > 0 ? `, ${formatCount(q.noRequestIdWithUsage)} of them carrying usage` : ''})`
      : ''
    ctx.out(
      `${q.agentId.padEnd(16)} reported ${pctOf(q.reported, q.events)} · estimated ${pctOf(q.estimated, q.events)} · ` +
        `missing ${pctOf(q.missing, q.events)}${noReq}`,
    )
    const avoided = q.naive === 0 ? 0 : (1 - q.folded / q.naive) * 100
    const signed = `${avoided >= 0 ? `-${avoided.toFixed(1)}` : `+${(-avoided).toFixed(1)}`}%`
    const agreed = q.folded === q.modelFolded
    const glyph = !agreed ? GLYPH.err : q.naive > q.folded ? GLYPH.ok : GLYPH.none
    const head =
      q.policy.mode === 'request_max'
        ? `${glyph} ${q.agentId.padEnd(16)} request_id dedup ${q.naive > q.folded ? 'active' : 'not needed'}: ` +
          `raw sum ${formatTokens(q.naive)} → ${formatTokens(q.folded)} (${signed} inflation avoided) · ` +
          `${formatCount(q.groups)} folded groups from ${formatCount(q.usageRows)} usage rows`
        : `${glyph} ${q.agentId.padEnd(16)} no request_id dedup: raw sum ${formatTokens(q.naive)} = ${formatTokens(q.folded)} · ` +
          `${formatCount(q.usageRows)} usage rows summed once each`
    ctx.out(`${head} · ${policyLabel(q)}`)
    if (!agreed) {
      ctx.out(
        `${GLYPH.err} ${q.agentId} cube and event-model disagree (${formatTokens(q.folded)} vs ${formatTokens(q.modelFolded)}) — ` +
          'one of the two paths is wrong; every token and cost number for this agent is untrustworthy until they match',
      )
    }
    if (q.policy.mode !== 'request_max' && q.globalFolded !== q.folded) {
      ctx.out(
        `${GLYPH.warn} ${q.agentId} declares ${q.policy.mode}: one GLOBAL request_max would have reported ` +
          `${formatTokens(q.globalFolded)} instead of ${formatTokens(q.folded)} (§18 row 2 — the fold is per agent)`,
      )
    }
  }
  const modes = new Set(qualities.map((q) => q.policy.mode))
  if (modes.size > 1) {
    ctx.out(
      `${GLYPH.warn} mixed folds in one database (${[...modes].sort().join(', ')}): every total above is that agent's own fold, ` +
        'no global rule was applied and none would be correct (§18 row 2)',
    )
  }
  for (const q of qualities) {
    if (!q.declared) {
      // `adapterAggregations` refuses to scan such an adapter, so its rows keep whatever
      // policy was persisted before — which this report must not present as a current fact.
      ctx.out(
        `${GLYPH.err} ${q.agentId}: its installed adapter declares no aggregation policy — \`agl scan\` aborts on that (§18 row 2), ` +
          `so the ${q.policy.mode} fold above is only what the stored rows recorded`,
      )
      continue
    }
    if (q.declared.mode !== q.policy.mode || q.declared.subagentsIncluded !== q.policy.subagentsIncluded) {
      ctx.out(
        `${GLYPH.warn} ${q.agentId}: its adapter now declares ${q.declared.mode}` +
          `${q.declared.subagentsIncluded ? '' : ' with subagents excluded'} but the stored rows are folded ${q.policy.mode}` +
          `${q.policy.subagentsIncluded ? '' : ' with subagents excluded'} — the totals above describe the rows, not the next scan`,
      )
    }
  }
  const undeclared = adapters.map((a) => [a.id, a.aggregation] as const).filter(([, p]) => !p).map(([id]) => id)
  for (const id of undeclared.filter((i) => !qualities.some((q) => q.agentId === i))) {
    ctx.out(`${GLYPH.err} ${id}: installed adapter declares no aggregation policy at all — it cannot be scanned (§18 row 2)`)
  }
  if (qualities.every((q) => q.folded === q.modelFolded)) {
    ctx.out(`${GLYPH.ok} cube (SQL) and event-model folds agree on every agent`)
  }
}
