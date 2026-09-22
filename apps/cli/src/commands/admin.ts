/**
 * `pricing update|override|billing`, `prune` (§9). Cost policy stays "unknown -> n/a,
 * never $0" (§8); these commands only manage the price data and the billing-mode
 * declaration feeding the cube.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { BillingMode, PriceEntry } from '@agentlens/pricing'
import { assertBillingMode, fetchLitellmSnapshot, LITELLM_PRICES_URL } from '@agentlens/pricing'
import { prune } from '@agentlens/storage'
import { UsageError, type FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { redactHome } from '../context.ts'
import { configPath, loadBillingModes, setBillingMode, snapshotPath, appendOverride, writeSnapshot } from '../pricing-store.ts'
import { GLYPH, formatCount, table } from '../render.ts'

const BILLING_USAGE = 'pricing billing <list | set <agent> <mode> | clear <agent>>'

/** Top-level `pricing` dispatch, so adding a subcommand never touches the arg parser. */
export async function cmdPricing(
  db: DatabaseSync,
  dbPath: string,
  words: string[],
  flags: FlagView,
  ctx: Ctx,
): Promise<number> {
  const [sub, ...rest] = words
  switch (sub) {
    case 'update':
      return cmdPricingUpdate(dbPath, ctx)
    case 'override':
      return cmdPricingOverride(dbPath, flags, ctx)
    case 'billing':
      return cmdPricingBilling(db, dbPath, rest, ctx)
    default:
      throw new UsageError(`unknown pricing subcommand: ${sub ?? '(none)'} — use update | override | ${BILLING_USAGE}`)
  }
}

export interface PricingUpdateDeps {
  /** Upstream price map; overridden only by tests and mirrors (§9). */
  url?: string
  /** Stands in for `globalThis.fetch` so the refresh path is testable offline. */
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  now?: () => number
}

/**
 * §8: the fetched map is what every historical cost is priced from, CLI and dashboard
 * alike — both read the one file written here through `loadPricing`.
 */
export async function cmdPricingUpdate(
  dbPath: string,
  ctx: Ctx,
  deps: PricingUpdateDeps = {},
): Promise<number> {
  try {
    const snapshot = await fetchLitellmSnapshot(deps.url ?? LITELLM_PRICES_URL, {
      fetchImpl: deps.fetchImpl,
      now: deps.now,
    })
    writeSnapshot(dbPath, snapshot)
    ctx.out(
      `${GLYPH.ok} price snapshot updated: ${formatCount(snapshot.entries.length)} entries ` +
        `(source: ${snapshot.source}) → ${redactHome(snapshotPath(dbPath), ctx.homedir)}`,
    )
    return 0
  } catch (err) {
    ctx.err(`${GLYPH.err} pricing update failed: ${redactHome((err as Error).message, ctx.homedir)}`)
    return 1
  }
}

function numFlag(flags: FlagView, name: string): number | undefined {
  const s = flags.str(name)
  if (s === undefined) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} expects a USD-per-1M-tokens number, got ${JSON.stringify(s)}`)
  return n
}

export function cmdPricingOverride(dbPath: string, flags: FlagView, ctx: Ctx): number {
  const model = flags.list('model')[0]
  if (!model) throw new UsageError('pricing override requires --model <name> and --input/--output prices (USD per 1M tokens)')
  const input = numFlag(flags, 'input')
  const output = numFlag(flags, 'output')
  if (input === undefined || output === undefined) {
    throw new UsageError('pricing override requires at least --input and --output (USD per 1M tokens)')
  }
  const cacheRead = numFlag(flags, 'cache-read') ?? input
  const cacheWrite = numFlag(flags, 'cache-write') ?? input
  const reasoning = numFlag(flags, 'reasoning')
  const effectiveFrom = flags.str('effective-from')
  const entry: PriceEntry = {
    provider: flags.list('provider')[0] ?? 'unknown',
    model,
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: cacheRead,
    cacheWritePerMTok: cacheWrite,
    reasoningPerMTok: reasoning ?? null,
    effectiveFrom: effectiveFrom !== undefined ? Number(effectiveFrom) : 0,
    source: 'override',
  }
  if (!Number.isFinite(entry.effectiveFrom)) throw new UsageError('--effective-from expects a ms epoch number')
  appendOverride(dbPath, entry)
  ctx.out(`${GLYPH.ok} override saved for ${entry.provider}/${entry.model} — costs are computed at query time, so it applies immediately`)
  return 0
}

function ingestedAgents(db: DatabaseSync): string[] {
  return (db.prepare('SELECT id FROM agents ORDER BY id').all() as { id: unknown }[]).map((r) => String(r.id))
}

const MODE_NOTE: Record<BillingMode, string> = {
  api: 'actual spend is tokens x price',
  subscription: 'actual spend shows $0 (the plan fee is flat); the tokens still price out as an API-equivalent',
  local: 'actual spend is always $0; the tokens still price out as an API-equivalent (§8)',
}

/** A typo in an agent id would otherwise be stored and then never consulted. */
function knownAgent(db: DatabaseSync, agent: string, declared: string[]): string {
  const known = new Set([...ingestedAgents(db), ...declared])
  if (!known.has(agent)) {
    throw new UsageError(
      `unknown agent ${JSON.stringify(agent)} — declared or ingested: ${[...known].join(', ') || '(none; run "agl scan" first)'}`,
    )
  }
  return agent
}

function listBilling(db: DatabaseSync, dbPath: string, ctx: Ctx): number {
  const modes = loadBillingModes(dbPath)
  const declared = Object.keys(modes).sort()
  const agents = [...new Set([...ingestedAgents(db), ...declared])].sort()
  ctx.out(
    table(
      ['Agent', 'Billing mode', 'Source'],
      agents.map((a) => [a, modes[a] ?? 'api', modes[a] ? 'declared' : 'default']),
    ),
  )
  for (const a of declared.filter((d) => !ingestedAgents(db).includes(d))) {
    ctx.out(`${GLYPH.warn} ${a} has a billing declaration but no ingested events — the cost figures above come from the mode it is declared with`)
  }
  if (agents.length === 0) ctx.out(`${GLYPH.none} no agents known yet — declare a mode after "agl scan"`)
  ctx.out(`declarations live in ${redactHome(configPath(dbPath), ctx.homedir)} · unset agents default to api`)
  return 0
}

/** §8's "let the user declare a billing mode per agent", on the same file the cube reads. */
export function cmdPricingBilling(db: DatabaseSync, dbPath: string, words: string[], ctx: Ctx): number {
  const [op, agent, mode] = words
  if (op === 'list') return listBilling(db, dbPath, ctx)
  const declared = Object.keys(loadBillingModes(dbPath))
  if (op === 'set') {
    if (!agent || !mode) throw new UsageError(`usage: pricing billing set <agent> <mode> — mode is api | subscription | local (§8)`)
    let resolved: BillingMode
    try {
      resolved = assertBillingMode(mode)
    } catch (err) {
      // A rejected declaration is a wrong command, not a broken install (§9 exit codes).
      throw new UsageError((err as Error).message)
    }
    const known = knownAgent(db, agent, declared)
    setBillingMode(dbPath, known, resolved)
    ctx.out(`${GLYPH.ok} billing mode set: ${known} = ${resolved} — ${MODE_NOTE[resolved]}`)
    ctx.out(`  saved in ${redactHome(configPath(dbPath), ctx.homedir)} — it applies to history too, cost is computed at query time`)
    return 0
  }
  if (op === 'clear') {
    if (!agent) throw new UsageError(`usage: pricing billing clear <agent>`)
    const known = knownAgent(db, agent, declared)
    const wasDeclared = known in loadBillingModes(dbPath)
    setBillingMode(dbPath, known, null)
    ctx.out(
      `${GLYPH.ok} billing declaration cleared for ${known} — back to the api default` +
        (wasDeclared ? '' : ' (nothing was declared)'),
    )
    return 0
  }
  throw new UsageError(`usage: ${BILLING_USAGE} — mode is api | subscription | local (§8)`)
}

export function cmdPrune(db: DatabaseSync, flags: FlagView, ctx: Ctx): number {
  const older = flags.str('older-than')
  let olderThanDays: number | undefined
  if (older !== undefined) {
    const m = /^(\d+)d$/.exec(older)
    if (!m) throw new UsageError(`--older-than expects a duration like 90d, got ${JSON.stringify(older)}`)
    olderThanDays = Number(m[1])
  }
  const res = prune(db, olderThanDays === undefined ? {} : { olderThanDays })
  ctx.out(
    `${GLYPH.ok} pruned: ${formatCount(res.payloadsDeleted)} payloads deleted` +
      (olderThanDays === undefined ? '' : ` · ${formatCount(res.eventsDeleted)} events older than ${olderThanDays}d`),
  )
  if (olderThanDays === undefined) ctx.out('  (events are permanent by default; pass --older-than 90d to trim them too)')
  return 0
}
