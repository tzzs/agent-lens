/**
 * Doctor's Usage quality block (§11), served. The fold is read back from the rows' own
 * `agents.aggregation_mode` — the same `loadAgentAggregations` the CLI's `queryDeps` uses —
 * because §18 row 2 made the rule per agent: one GLOBAL `request_max` over a `last_call_sum`
 * agent deletes tokens, and that is the number this report exists to defend.
 *
 * The arithmetic itself lives in storage's shared doctor checks, so the CLI and this route
 * cannot drift apart (§14); this file only decides what the JSON says.
 */
import type { AgentAdapter, AggregationPolicy } from '@agentlens/event-model'
import { loadAgentAggregations, usageFoldModes, usageQuality, type CubeAgentTotal } from '@agentlens/storage'
import { query } from '@agentlens/query'
import type { ServerCtx } from './types.ts'
import type { DoctorUsageAgentRow } from './doctor-types.ts'

export interface ServedUsageQuality {
  reported: number
  estimated: number
  missing: number
  withoutRequestId: number
  naiveTokens: number
  dedupedTokens: number
  inflationAvoidedPct: number
  dedupActive: boolean
  modes: ReturnType<typeof usageFoldModes>
  perAgent: DoctorUsageAgentRow[]
}

export function usageQualityBlock(ctx: ServerCtx, adapters: readonly AgentAdapter[]): ServedUsageQuality {
  const declared: Record<string, AggregationPolicy | undefined> = {}
  for (const a of adapters) declared[a.id] = a.aggregation ?? undefined

  // Persisted, not runtime: the stored rows keep the rule that wrote them even if this
  // build's adapter set changed or is absent entirely.
  const persisted = loadAgentAggregations(ctx.db)
  const cube = query(
    ctx.db,
    { metrics: ['events', 'tokens_total'], dims: ['agent'] },
    { ...ctx.cubeDeps, aggregation: persisted },
  )
  const totals: CubeAgentTotal[] = cube.rows.map((r) => ({
    agentId: String(r.agent),
    events: Number(r.events ?? 0),
    tokensTotal: Number(r.tokens_total ?? 0),
  }))
  const perAgent: DoctorUsageAgentRow[] = usageQuality(ctx.db, totals, declared).map((q) => ({
    ...q,
    // Two paths to the same total: the cube's SQL fold and event-model's fold of the rows.
    agrees: q.folded === q.modelFolded,
  }))

  const sum = (pick: (q: DoctorUsageAgentRow) => number): number => perAgent.reduce((a, q) => a + pick(q), 0)
  const naive = sum((q) => q.naive)
  const deduped = sum((q) => q.folded)
  return {
    reported: sum((q) => q.reported),
    estimated: sum((q) => q.estimated),
    missing: sum((q) => q.missing),
    withoutRequestId: sum((q) => q.noRequestId),
    naiveTokens: naive,
    dedupedTokens: deduped,
    inflationAvoidedPct: naive === 0 ? 0 : (1 - deduped / naive) * 100,
    dedupActive: naive > 0 && (naive - deduped) / naive > 0.001,
    modes: usageFoldModes(perAgent),
    perAgent,
  }
}
