/**
 * `doctor`'s Usage quality section (§11). Three views of the same rows are compared,
 * never re-derived: the cube's policy-aware SQL fold (§7/§18), event-model's own
 * `aggregateUsage`/`aggregateRequestTokens` kernel, and the raw per-record SUM a naive
 * report would have printed. When two of them disagree the number is wrong somewhere,
 * and this section is where that has to surface.
 *
 * §18 row 2 made the fold a per-agent declaration, so every number below is labelled
 * with the policy that produced it and no global rule is ever applied to a mixed database.
 * The measurement itself is shared with `GET /api/doctor` (storage's `usageQuality`),
 * because §14 forbids the two reports from disagreeing about it.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import {
  loadAgentAggregations,
  usageFoldModes,
  usageQuality,
  type AgentUsageQuality,
  type CubeAgentTotal,
} from '@agentlens/storage'
import { query } from '@agentlens/query'
import type { Ctx } from '../context.ts'
import { GLYPH, formatCount, formatTokens } from '../render.ts'

/** The measurement lives in storage so this report and `GET /api/doctor` share one implementation. */
export type AgentQuality = AgentUsageQuality

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

/** §11's per-agent measurement, with this build's cube totals handed to the shared check. */
export function measureUsageQuality(db: DatabaseSync, adapters: readonly AgentAdapter[]): AgentQuality[] {
  const { persisted, declared } = usagePolicies(db, adapters)
  const cube = query(
    db,
    { metrics: ['events', 'tokens_total'], dims: ['agent'] },
    { aggregation: persisted },
  )
  const totals: CubeAgentTotal[] = cube.rows.map((r) => ({
    agentId: String(r.agent),
    events: Number(r.events ?? 0),
    tokensTotal: Number(r.tokens_total ?? 0),
  }))
  return usageQuality(db, totals, declared)
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
  const modes = usageFoldModes(qualities)
  if (modes.length > 1) {
    ctx.out(
      `${GLYPH.warn} mixed folds in one database (${modes.join(', ')}): every total above is that agent's own fold, ` +
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
