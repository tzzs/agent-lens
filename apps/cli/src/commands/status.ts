import type { DatabaseSync } from 'node:sqlite'
import { query, resolveSince } from '@agentlens/query'
import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { makeHostCtx, queryDeps, redactHome } from '../context.ts'
import { getAdapters } from '../adapters.ts'
import { formatCount, formatTokens, formatUsd, table } from '../render.ts'
import { rowsOf } from './shared.ts'

export async function cmdStatus(db: DatabaseSync, flags: FlagView, ctx: Ctx, dbPath: string): Promise<number> {
  const adapters = await getAdapters()
  const agentRows = rowsOf(db, 'SELECT id FROM agents ORDER BY id')
  const perSource = rowsOf(db, "SELECT agent_id, COUNT(*) AS n FROM sources GROUP BY agent_id")
  const perEvent = rowsOf(db, 'SELECT agent_id, COUNT(*) AS n FROM events GROUP BY agent_id')
  const srcBy = new Map(perSource.map((r) => [String(r.agent_id), Number(r.n)]))
  const evBy = new Map(perEvent.map((r) => [String(r.agent_id), Number(r.n)]))

  ctx.out('Agents')
  const seen = new Set<string>()
  for (const a of adapters) {
    try {
      const d = await a.detect(makeHostCtx(ctx))
      seen.add(a.id)
      ctx.out(`  ${d.present ? '✓' : '−'} ${a.id}  ${d.present ? 'installed' : 'not detected'}`)
    } catch {
      ctx.out(`  ! ${a.id}  detection failed`)
    }
  }
  for (const r of agentRows) {
    const id = String(r.id)
    if (seen.has(id)) continue
    ctx.out(`  ✓ ${id}  (ingested; adapter not installed in this build)`)
  }
  if (agentRows.length === 0 && adapters.length === 0) {
    ctx.out('  − no agents discovered yet (no adapters installed)')
  }

  ctx.out('')
  ctx.out('Sources')
  ctx.out(table(
    ['agent', 'sources', 'events'],
    agentRows.map((r) => {
      const id = String(r.id)
      return [id, formatCount(srcBy.get(id) ?? 0), formatCount(evBy.get(id) ?? 0)]
    }),
    ['left', 'right', 'right'],
  ))

  ctx.out('')
  ctx.out('Today (UTC)')
  const since = resolveSince(bucketStart(ctx.now()), ctx.now())
  const res = query(
    db,
    { metrics: ['events', 'sessions', 'tokens_total', 'cost_api_equiv'], filter: { since } },
    queryDeps(db, dbPath, ctx),
  )
  const t = res.totals
  ctx.out(
    `${formatCount(t.sessions ?? 0)} sessions · ${formatCount(t.events ?? 0)} events · ` +
      `${formatTokens(t.tokens_total)} tokens (deduped) · ${formatUsd(t.cost_api_equiv)} api-equiv`,
  )
  return 0
}

function bucketStart(ts: number): number {
  return ts - (ts % 86_400_000)
}

export function redactMsg(msg: string, ctx: Ctx): string {
  return redactHome(msg, ctx.homedir)
}
