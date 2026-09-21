/**
 * `tools|skills|mcp|plugins|connectors|subagents` and `projects` — all one
 * function over the cube's capability dims (§7), plus the §9 tree layout for
 * projects. Nothing here composes token SQL.
 */
import type { DatabaseSync } from 'node:sqlite'
import { query, type CapabilityDim } from '@agentlens/query'
import type { FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { queryDeps } from '../context.ts'
import { getAdapters } from '../adapters.ts'
import { formatMs, formatTokens, formatUsd, table } from '../render.ts'
import { filter } from './shared.ts'

const CAP_COMMANDS: Record<string, CapabilityDim> = {
  tools: 'tool',
  skills: 'skill',
  mcp: 'mcp',
  plugins: 'plugin',
  connectors: 'connector',
  commands: 'command',
  subagents: 'subagent',
  hooks: 'hook',
}

export function isCapabilityCommand(word: string): boolean {
  return word in CAP_COMMANDS
}

export async function cmdCapability(db: DatabaseSync, flags: FlagView, ctx: Ctx, dbPath: string, command: string): Promise<number> {
  const dim = CAP_COMMANDS[command]
  if (!dim) return 2
  const baseFilter = filter(db, ctx, flags)
  const res = query(
    db,
    {
      metrics: ['events', 'duration', 'tokens_total', 'cost_api_equiv'],
      dims: [dim],
      filter: baseFilter,
      order: 'metric:events:desc',
      limit: flags.num('limit') ?? 30,
    },
    queryDeps(db, dbPath, ctx),
  )
  const errs = query(db, {
    metrics: ['events'],
    dims: [dim],
    filter: { ...baseFilter, status: ['error'] },
  })
  const errBy = new Map(errs.rows.map((r) => [String(r[dim]), Number(r.events)]))

  const rows = res.rows.map((r) => [
    String(r[dim] ?? '') || '(unnamed)',
    (r.events as number) ?? 0,
    formatMs(r.duration as number),
    formatTokens(r.tokens_total as number),
    formatUsd(r.cost_api_equiv as number | null),
    (errBy.get(String(r[dim] ?? '')) ?? 0),
  ])
  ctx.out(table([command.replace(/s$/, '').toUpperCase(), 'Calls', 'Duration', 'Tokens', 'Cost(api-equiv)', 'Errors'], rows,
    ['left', 'right', 'right', 'right', 'right', 'right']))
  if (res.truncated) ctx.out(`! truncated to ${flags.num('limit') ?? 30} rows`)

  // §11 "installed but never used": static catalogs come from adapters when present.
  if (dim === 'skill' || dim === 'mcp' || dim === 'hook') {
    const adapters = await getAdapters()
    let installed = 0
    let any = false
    for (const a of adapters) {
      if (!a.capabilities) continue
      try {
        const cats = await a.capabilities(await firstDiscoverCtx(a, ctx))
        any = true
        installed += cats.filter((c) => c.type === dim).length
      } catch {
        // catalog unavailable — degrade silently, doctor covers it
      }
    }
    if (any) ctx.out(`installed (static catalog): ${installed} · invoked: ${rows.length}`)
  }
  return 0
}

async function firstDiscoverCtx(a: Awaited<ReturnType<typeof getAdapters>>[number], ctx: Ctx) {
  const { makeHostCtx } = await import('../context.ts')
  const d = await a.detect(makeHostCtx(ctx))
  return makeHostCtx(ctx, d.dataRoot ?? null)
}

/** §9 tree: project row + per-agent indented sub-rows. */
export function cmdProjects(db: DatabaseSync, flags: FlagView, ctx: Ctx, dbPath: string): number {
  const baseFilter = filter(db, ctx, flags)
  const deps = queryDeps(db, dbPath, ctx)
  const top = query(
    db,
    { metrics: ['sessions', 'tokens_total', 'cost_api_equiv'], dims: ['project'], filter: baseFilter, order: 'metric:tokens_total:desc', limit: flags.num('limit') ?? 30 },
    deps,
  )
  const sub = query(
    db,
    { metrics: ['sessions', 'tokens_total', 'cost_api_equiv'], dims: ['project', 'agent'], filter: baseFilter },
    deps,
  )
  const subByProject = new Map<string, { agents: string[]; rows: (string | number)[][] }>()
  for (const r of sub.rows) {
    const p = String(r.project ?? '')
    const entry = subByProject.get(p) ?? { agents: [], rows: [] }
    entry.agents.push(String(r.agent))
    entry.rows.push([
      String(r.agent),
      (r.sessions as number) ?? 0,
      formatTokens(r.tokens_total as number),
      formatUsd(r.cost_api_equiv as number | null),
    ])
    subByProject.set(p, entry)
  }
  const body: string[][] = []
  for (const r of top.rows) {
    const p = String(r.project ?? '(none)')
    const info = subByProject.get(p)
    body.push([
      p,
      info?.agents.join(',') ?? '',
      String((r.sessions as number) ?? 0),
      formatTokens(r.tokens_total as number),
      formatUsd(r.cost_api_equiv as number | null),
    ])
    const subRows = info?.rows ?? []
    subRows.forEach((sr, i) => {
      const last = i === subRows.length - 1
      body.push([`${last ? '  └──' : '  ├──'} ${sr[0]}`, '', String(sr[1]), String(sr[2]), String(sr[3])])
    })
  }
  ctx.out(table(['Project', 'Agents', 'Sessions', 'Tokens', 'Cost(est)'], body))
  if (top.truncated) ctx.out(`! truncated to ${flags.num('limit') ?? 30} projects`)
  return 0
}
