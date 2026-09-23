/**
 * The two persistent first-screen banners (§14, §18 round 2 item 6).
 *
 * Both are trust facts, not decorations: the host split stops "how much did I
 * spend in Claude Code?" from being off by ~30x, and the coverage line stops a
 * partial history from reading as a complete one.
 */
import { query, type QueryFilter } from '@agentlens/query'
import { hostSplitFor, hostSplitNotice, isDegenerateHost, pickHostSplit } from '@agentlens/storage'
import type { ServerCtx } from './types.ts'
import { coverageReport, type CoverageReport } from './coverage.ts'

export interface HostShare {
  host: string
  events: number
  share: number
}

export interface HostSplitBanner {
  agentId: string
  dominantHost: string
  dominantShare: number
  hosts: HostShare[]
  /**
   * Whether the dominant host is just the agent's own name repeated. The two
   * phrasings of this banner differ on that fact, and the rule that decides it
   * belongs to `host-split.ts` — a viewer that re-derived it could disagree with
   * the terminal about what the same share means.
   */
  degenerate: boolean
  /** §1.5: the UI shows the split rather than one merged agent row by default. */
  splitByDefault: true
  message: string
}

export interface BannerPair {
  hostSplit: HostSplitBanner | null
  coverage: CoverageReport
}

/** Per-agent host shares (§18 item 6: host is an identity dimension, not metadata). */
export function hostSplitsByAgent(ctx: ServerCtx, filter?: QueryFilter): Map<string, HostShare[]> {
  const res = query(ctx.db, { metrics: ['events'], dims: ['agent', 'host'], filter, totals: false }, ctx.cubeDeps)
  const byAgent = new Map<string, { host: string; events: number }[]>()
  for (const r of res.rows) {
    const agent = String(r.agent ?? '')
    const host = String(r.host ?? '')
    const list = byAgent.get(agent) ?? []
    list.push({ host, events: Number(r.events ?? 0) })
    byAgent.set(agent, list)
  }
  const out = new Map<string, HostShare[]>()
  for (const [agent, list] of byAgent) {
    const total = list.reduce((a, b) => a + b.events, 0)
    out.set(
      agent,
      list
        .map((l) => ({ host: l.host, events: l.events, share: total === 0 ? 0 : l.events / total }))
        .sort((a, b) => b.events - a.events),
    )
  }
  return out
}

export function hostSplitBanner(ctx: ServerCtx, filter?: QueryFilter): HostSplitBanner | null {
  // Same decision as the terminal's warning line, from the same rule (§14): a majority host
  // makes this view "split by default", and the degenerate case where the dominant host carries
  // the agent's own name is phrased as the minority it is instead of a tautology. The stricter
  // alarm threshold lives in `host-split.ts` too, so neither surface can drift on its own.
  const best = pickHostSplit([...hostSplitsByAgent(ctx, filter)].map(([agentId, hosts]) => hostSplitFor(agentId, hosts)))
  if (!best) return null
  return {
    agentId: best.agentId,
    dominantHost: best.dominant.host,
    dominantShare: best.dominant.share,
    hosts: best.hosts,
    degenerate: isDegenerateHost(best.agentId, best.dominant.host),
    splitByDefault: true,
    message: `${hostSplitNotice(best)} — shown split by default`,
  }
}

export function banners(ctx: ServerCtx, filter?: QueryFilter): BannerPair {
  return { hostSplit: hostSplitBanner(ctx, filter), coverage: coverageReport(ctx) }
}
