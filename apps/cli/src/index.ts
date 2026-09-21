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
import { cmdScan, runScan } from './commands/scan.ts'
import { cmdWatch } from './commands/watch.ts'
import { cmdStatus } from './commands/status.ts'
import { cmdDoctor } from './commands/doctor.ts'
import { cmdUsage } from './commands/usage.ts'
import { cmdSession, cmdSessions } from './commands/sessions.ts'
import { cmdCapability, cmdProjects, isCapabilityCommand } from './commands/capabilities.ts'
import { cmdExport } from './commands/export.ts'
import { cmdPricingOverride, cmdPricingUpdate, cmdPrune } from './commands/admin.ts'
import { query } from '@agentlens/query'
import { queryDeps } from './context.ts'
import { serveDashboard } from './serve.ts'
import { filter } from './commands/shared.ts'

export const DASHBOARD_URL = 'http://localhost:7317'

const HELP = `agentlens (agl) — the activity monitor for AI agents

Usage:
  agentlens                        scan registered adapters, print summary (§14)
  agentlens scan [--agent X]       manual incremental scan
  agentlens watch [--agent X] [--interval <ms>]
                                   scan once, then stay resident printing new activity (§9)
  agentlens status                 agent discovery + source counts + today's totals
  agentlens doctor                 data-trust report (§11)
  agentlens usage  [--agent --host --project --model --since --until --by <dim> [--limit N] [--explain]]
                                   §7 cube; --by takes any dim or comma-list of dims
  agentlens sessions [--agent --project --limit N]
  agentlens session <id>           ordered timeline (metrics-only when content layer is off)
  agentlens tools|skills|mcp|plugins|connectors|subagents|hooks
                                   capability views (same cube, capability dims)
  agentlens projects               cross-agent project tree (§9)
  agentlens export --format jsonl|csv|otel [--since ...] [--agent ...]
  agentlens pricing update         refresh litellm price snapshot
  agentlens pricing override --model M --input N --output N [--cache-read N] [--cache-write N]
                             [--reasoning N] [--provider P] [--effective-from MS]
  agentlens prune [--older-than 90d]

Global flags:
  --db <path>          database file (default ~/.agentlens/agentlens.db)
  --no-content         do not store the content layer (payloads) during scan
  --serve              with bare command, print the dashboard URL (server itself is a later milestone)
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
  }
  const deps = queryDeps(db, dbPath, ctx)
  const totals = query(db, { metrics: ['sessions', 'events', 'tokens_total', 'cost_api_equiv'] }, deps).totals
  const caps = query(db, { metrics: ['events'], dims: ['capability_type'] })
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
  if (flags.bool('serve')) {
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
    case 'pricing': {
      const sub = rest[0]
      if (sub === 'update') return cmdPricingUpdate(dbPath, ctx)
      if (sub === 'override') return cmdPricingOverride(dbPath, flags, ctx)
      throw new UsageError('pricing requires `update` or `override`')
    }
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
    return await dispatch(db, words, flags, ctx, dbPath)
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
