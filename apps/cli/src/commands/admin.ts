/**
 * `pricing update|override`, `prune` (§9). Cost policy stays "unknown -> n/a,
 * never $0" (§8); the cube already encodes that, these commands only manage
 * the price data feeding it.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { PriceEntry } from '@agentlens/pricing'
import { fetchLitellmSnapshot } from '@agentlens/pricing'
import { prune } from '@agentlens/storage'
import { UsageError, type FlagView } from '../args.ts'
import type { Ctx } from '../context.ts'
import { redactHome } from '../context.ts'
import { snapshotPath, appendOverride, writeSnapshot } from '../pricing-store.ts'
import { GLYPH, formatCount } from '../render.ts'

export async function cmdPricingUpdate(dbPath: string, ctx: Ctx): Promise<number> {
  try {
    const snapshot = await fetchLitellmSnapshot()
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
