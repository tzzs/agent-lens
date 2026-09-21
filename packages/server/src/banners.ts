/**
 * The two persistent first-screen banners (§14, §18 round 2 item 6).
 *
 * Both are trust facts, not decorations: the host split stops "how much did I
 * spend in Claude Code?" from being off by ~30x, and the coverage line stops a
 * partial history from reading as a complete one.
 */
import { query, type QueryFilter } from '@agentlens/query'
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
  const res = query(ctx.db, { metrics: ['events'], dims: ['agent', 'host'], filter }, ctx.cubeDeps)
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
  const splits = hostSplitsByAgent(ctx, filter)
  let best: { agentId: string; hosts: HostShare[] } | null = null
  let bestEvents = 0
  for (const [agentId, hosts] of splits) {
    const total = hosts.reduce((a, b) => a + b.events, 0)
    if (hosts.length < 2 || total === 0) continue
    const dominant = hosts[0]
    if (!dominant || dominant.share <= 0.5) continue
    if (total > bestEvents) {
      bestEvents = total
      best = { agentId, hosts }
    }
  }
  if (!best) return null
  const dominant = best.hosts[0]!
  const others = best.hosts.slice(1).map((h) => h.host).join(', ')
  return {
    agentId: best.agentId,
    dominantHost: dominant.host,
    dominantShare: dominant.share,
    hosts: best.hosts,
    splitByDefault: true,
    message: `${(dominant.share * 100).toFixed(1)}% of ${best.agentId} records came from ${dominant.host}, not ${others || 'the other host'} — shown split by default`,
  }
}

export function banners(ctx: ServerCtx, filter?: QueryFilter): BannerPair {
  return { hostSplit: hostSplitBanner(ctx, filter), coverage: coverageReport(ctx) }
}
