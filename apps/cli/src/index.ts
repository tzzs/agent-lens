/**
 * `agentlens` / `agl` entry point (§9). Every read command is a thin shell over
 * packages/query — that is the whole anti-drift design; keep it that way.
 * Exit codes: 0 ok · 1 runtime error · 2 usage error.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbPath, migrate, openDatabase } from '@agentlens/storage'
import { CLI_FLAG_SCHEMA, parseArgs, UsageError, type FlagView } from './args.ts'
import { getAdapters } from './adapters.ts'
import { defaultCtx, redactHome, type Ctx } from './context.ts'
import { ensureDataDir } from './pricing-store.ts'
import { bucketTs } from '@agentlens/query'
import { GLYPH, formatCount, formatTokens, formatUsd } from './render.ts'
import { cmdScan, refusalLines, runScan, snapshotsDirFor } from './commands/scan.ts'
import { cmdWatch } from './commands/watch.ts'
import { cmdStatus } from './commands/status.ts'
import { cmdDoctor } from './commands/doctor.ts'
import { cmdUsage } from './commands/usage.ts'
import { cmdSession, cmdSessions } from './commands/sessions.ts'
import { cmdCapability, cmdProjects, isCapabilityCommand } from './commands/capabilities.ts'
import { cmdExport } from './commands/export.ts'
import { cmdPricing, cmdPrune } from './commands/admin.ts'
import { query } from '@agentlens/query'
import { queryDeps } from './context.ts'
import { serveDashboard } from './serve.ts'
import { filter, rowsOf } from './commands/shared.ts'
import { createContext, coverageReport } from '@agentlens/server'

export const DASHBOARD_URL = 'http://localhost:7317'

const HELP = `agentlens (agl) — the activity monitor for AI agents

Usage:
  agentlens                        scan, print the §14 summary, then serve the dashboard
  agentlens scan [--agent X]       manual incremental scan
  agentlens watch [--agent X] [--interval <ms>]
                                   scan once, then stay resident printing new activity (§9)
  agentlens status                 agent discovery + source counts + today's totals
  agentlens doctor                 data-trust report (§11)
  agentlens usage  [--agent --host --project --model --since --until --by <dim> [--limit N]
                   [--no-subagents] [--explain]]
                                   §7 cube; --by takes any dim or comma-list of dims,
                                   --no-subagents drops subagent threads from the totals (§18)
  agentlens sessions [--agent --project --limit N]
  agentlens session <id>           ordered timeline (metrics-only when content layer is off)
  agentlens tools|skills|mcp|plugins|connectors|subagents|hooks
                                   capability views (same cube, capability dims)
  agentlens projects               cross-agent project tree (§9)
  agentlens export --format jsonl|csv|otel [--since ...] [--agent ...]
                     --format otel [--push <otlp-url>] [--push-header "Name: value"]
                     (§12: the OTel mapping, optionally POSTed to a Langfuse/Phoenix collector)
  agentlens pricing update         refresh litellm price snapshot
  agentlens pricing override --model M --input N --output N [--cache-read N] [--cache-write N]
                             [--reasoning N] [--provider P] [--effective-from MS]
  agentlens pricing billing list   show each agent's declared §8 billing mode
  agentlens pricing billing set <agent> api|subscription|local
  agentlens pricing billing clear <agent>
  agentlens prune [--older-than 90d]

Global flags:
  --db <path>          database file (default ~/.agentlens/agentlens.db)
  --content            store the content layer (payloads) during scan — off by default (§6)
  --no-content         force the content layer off, even alongside --content
  --serve              bare command: serve the dashboard even when stdout is not a terminal
  --no-serve           bare command: stop after the summary (§9 serves by default)
  -h, --help           this text
  -V, --version        print version

Exit codes: 0 ok · 1 runtime error · 2 usage error (unknown command/flag)
Filters accept names or ids; --since/--until accept 7d, 24h, 30m, 2026-09-01, 20260901 or ms epoch.`

function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * §14: what the first screen owes the user is coverage and the host split, not a
 * disclaimer that the numbers are estimates. A scan that looks complete while
 * upstream retention already deleted history has to say so, and §1.5's measured
 * 94.6%-desktop split is the single easiest way to misread a total.
 */
const HOST_SKEW_FLOOR = 0.8
const HOST_SKEW_MIN_EVENTS = 20

function hostSkew(db: DatabaseSync): string | null {
  const byAgent = new Map<string, { host: string; n: number }[]>()
  for (
    const r of rowsOf(
      db,
      `SELECT agent_id, COALESCE(NULLIF(host_id, ''), '(none)') AS host, COUNT(*) AS n
       FROM events GROUP BY agent_id, host`,
    )
  ) {
    const agent = String(r.agent_id)
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), { host: String(r.host), n: Number(r.n) }])
  }
  let best: { agent: string; host: string; share: number; other: string } | null = null
  for (const [agent, hosts] of byAgent) {
    if (hosts.length < 2) continue
    const total = hosts.reduce((sum, h) => sum + h.n, 0)
    if (total < HOST_SKEW_MIN_EVENTS) continue
    const ranked = [...hosts].sort((a, b) => b.n - a.n)
    const share = ranked[0]!.n / total
    if (share < HOST_SKEW_FLOOR || ranked[0]!.host === agent) continue
    if (best && best.share >= share) continue
    best = { agent, host: ranked[0]!.host, share, other: ranked[1]!.host }
  }
  if (!best) return null
  return (
    `${GLYPH.warn} ${(best.share * 100).toFixed(1)}% of ${best.agent} events came from host ` +
    `${best.host}, not ${best.other} — every figure above is split by host (§1.5)`
  )
}

/** The §14 warning lines, or nothing at all when coverage and hosts are clean. */
export function bannerWarnings(db: DatabaseSync, ctx: Ctx): string[] {
  const lines: string[] = []
  const coverage = coverageReport(createContext({ db, now: ctx.now, homedir: ctx.homedir }))
  if (coverage.banner) lines.push(`${GLYPH.warn} ${coverage.banner}`)
  const skew = hostSkew(db)
  if (skew) lines.push(skew)
  return lines
}

async function cmdBare(db: DatabaseSync, flags: FlagView, ctx: Ctx, dbPath: string): Promise<number> {
  ctx.out('AgentLens')
  ctx.out('')
  ctx.out('Scanning local agents...')
  const outcome = await runScan(db, flags, ctx)
  if (outcome.adaptersFound === 0) {
    ctx.out(
      (await getAdapters()).length === 0
        ? `${GLYPH.none} no adapters installed — nothing new to scan (ingested history stays queryable).`
        : `${GLYPH.none} no agents detected on this host — nothing new to scan (ingested history stays queryable).`,
    )
  } else {
    ctx.out(`${GLYPH.ok} ${outcome.adaptersFound} adapter(s) scanned · ${outcome.events} new events · ${outcome.failures} parse failures`)
    for (const line of refusalLines(outcome, ctx)) ctx.out(line)
  }
  const deps = queryDeps(db, dbPath, ctx)
  const totals = query(db, { metrics: ['sessions', 'events', 'tokens_total', 'cost_api_equiv'] }, deps).totals
  const caps = query(db, { metrics: ['events'], dims: ['capability_type'], totals: false })
  const capBy = new Map(caps.rows.map((r) => [String(r.capability_type), Number(r.events)]))
  ctx.out('')
  ctx.out(
    `${formatCount(totals.sessions ?? 0)} sessions · ${formatTokens(totals.tokens_total)} tokens · ` +
      `deduped per request (§3.1) · ${formatUsd(totals.cost_api_equiv)} est. cost (missing prices shown as n/a)`,
  )
  ctx.out(
    `${formatCount(capBy.get('tool') ?? 0)} tool calls · ${formatCount(capBy.get('hook') ?? 0)} hook fires · ` +
      `${formatCount(capBy.get('mcp') ?? 0)} MCP calls · ${formatCount(capBy.get('skill') ?? 0)} skill invocations`,
  )
  const today = query(
    db,
    { metrics: ['tokens_total', 'cost_api_equiv'], filter: { since: bucketTs(ctx.now(), 'day') } },
    deps,
  ).totals
  ctx.out(
    `today: ${formatTokens(today.tokens_total)} tokens · ${formatUsd(today.cost_api_equiv)} api-equiv`,
  )
  for (const line of bannerWarnings(db, ctx)) ctx.out(line)
  // §9: the bare command is scan + serve + browser. A pipe or CI run gets the summary
  // alone, because a server nobody can see — or interrupt — is worse than none.
  const wantsServe = flags.bool('serve') || (ctx.interactive && !flags.bool('no-serve'))
  if (wantsServe) {
    const handle = await (ctx.serve ?? serveDashboard)(db, dbPath, flags, ctx, deps)
    ctx.out('')
    ctx.out(`Dashboard → ${handle.url}`)
    ctx.out(`${GLYPH.ok} serving until you press Ctrl-C`)
    await handle.closed
  }
  return 0
}

function dispatch(
  db: DatabaseSync,
  words: string[],
  flags: FlagView,
  ctx: Ctx,
  dbPath: string,
): Promise<number> | number {
  const [command, ...rest] = words
  switch (command) {
    case undefined:
      return cmdBare(db, flags, ctx, dbPath)
    case 'scan':
      return cmdScan(db, flags, ctx)
    case 'watch':
      return cmdWatch(db, flags, ctx)
    case 'status':
      return cmdStatus(db, flags, ctx, dbPath)
    case 'doctor':
      return cmdDoctor(db, flags, ctx, dbPath)
    case 'usage':
      return cmdUsage(db, flags, ctx, dbPath)
    case 'sessions':
      return cmdSessions(db, flags, ctx, dbPath)
    case 'session':
      return cmdSession(db, rest, flags, ctx)
    case 'projects':
      return cmdProjects(db, flags, ctx, dbPath)
    case 'export':
      return cmdExport(db, flags, ctx)
    case 'pricing':
      return cmdPricing(db, dbPath, rest, flags, ctx)
    case 'prune':
      return cmdPrune(db, flags, ctx)
    default:
      if (isCapabilityCommand(command!)) return cmdCapability(db, flags, ctx, dbPath, command!)
      throw new UsageError(`unknown command: ${command}`)
  }
}

export async function runCli(ctx: Ctx): Promise<number> {
  let words: string[]
  let flags: FlagView
  try {
    const parsed = parseArgs(ctx.argv, CLI_FLAG_SCHEMA)
    words = parsed.words
    flags = parsed.flags
    if (flags.bool('help')) {
      ctx.out(HELP)
      return 0
    }
    if (flags.bool('version')) {
      ctx.out(`agentlens ${cliVersion()}`)
      return 0
    }
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.err(`error: ${err.message}`)
      ctx.err("run 'agentlens --help' for the command surface")
      return 2
    }
    ctx.err(`error: ${redactHome((err as Error).message, ctx.homedir)}`)
    return 1
  }

  const dbPath = flags.str('db') ?? defaultDbPath(ctx.homedir)
  // Copies of other apps' WAL stores live beside our own database, never next to
  // theirs (§18 row 7).
  const scanCtx: Ctx = { ...ctx, snapshotDir: snapshotsDirFor(dbPath) }
  let db: DatabaseSync
  try {
    ensureDataDir(dbPath)
    db = openDatabase(dbPath)
    migrate(db)
  } catch (err) {
    ctx.err(`error: cannot open database: ${redactHome((err as Error).message, ctx.homedir)}`)
    return 1
  }
  try {
    return await dispatch(db, words, flags, scanCtx, dbPath)
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.err(`error: ${err.message}`)
      return 2
    }
    ctx.err(`error: ${redactHome((err as Error).message ?? String(err), ctx.homedir)}`)
    return 1
  } finally {
    db.close()
  }
}

export function main(argv: string[] = process.argv.slice(2)): void {
  void runCli(defaultCtx(argv)).then((code) => {
    process.exitCode = code
  })
}
