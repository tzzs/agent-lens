/**
 * §5.3 / §14: the ONE merged price table.
 *
 * "Price table = snapshot file when present (after `pricing update`), else the bundled
 * snapshot, with the user's `pricing-overrides.jsonl` merged on top — overrides always
 * win (§8)" used to be computed twice, once in `apps/cli/src/pricing-store.ts` and once
 * in `packages/server/src/serve.ts`, and the two drifted (served doctor printed a
 * different `priceTableSize` than `agl doctor`). Both sides now call `loadMergedPricing`
 * and nothing else parses the jsonl.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PriceEntry } from './price-types.ts'
import {
  bundledSnapshot,
  type OpenRouterSnapshot,
  type PriceSnapshot,
  type RawOpenRouterEntry,
} from './snapshot.ts'
import { PricingTable } from './table.ts'
import { readSnapshotFile } from './update.ts'

/** File-name convention, shared so no caller re-spells it. */
export const PRICE_SNAPSHOT_FILENAME = 'price-snapshot.json'
export const OPENROUTER_SNAPSHOT_FILENAME = 'price-snapshot-openrouter.json'
export const PRICING_OVERRIDES_FILENAME = 'pricing-overrides.jsonl'

export interface MergedPricing {
  table: PricingTable
  snapshot: PriceSnapshot
  /** The §8 fallback snapshot when one has been fetched; null when it is absent or unreadable. */
  fallback: OpenRouterSnapshot | null
  /** Models the fallback priced and the primary snapshot did not; 0 without a fallback file. */
  fallbackAdded: number
  /** Overrides actually merged into the table; what `agl doctor` prints as "(M overrides)". */
  overrideCount: number
}

export interface LoadMergedPricingOptions {
  /** Point at a snapshot file elsewhere than the convention (mirrors, tests). */
  snapshotFile?: string
  /** Point at the OpenRouter fallback file elsewhere than the convention. */
  fallbackFile?: string
  /** Point at an overrides file elsewhere than the convention. */
  overridesFile?: string
}

export class PricingOverrideFileError extends Error {
  override readonly name = 'PricingOverrideFileError'
}

/**
 * Resolve the data dir from any path that identifies the store: the DB file
 * (`--db <dir>/agentlens.db`), the directory itself, or the snapshot file.
 * A `*.json` path is taken as the snapshot file; an existing directory is taken
 * as the data dir; anything else is a file whose `dirname` holds the store.
 */
export function pricingStoreDir(store: string): string {
  if (store.endsWith('.json')) return dirname(store)
  try {
    if (statSync(store).isDirectory()) return store
  } catch {
    // not there (yet): fall through to the file interpretation
  }
  return dirname(store)
}

const PRICE_FIELDS = ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok'] as const
const SOURCES = new Set(['litellm', 'openrouter', 'override', 'manual'])

/**
 * A line is a usable override iff it would merge without silently corrupting the
 * table: a JSON object with non-empty string `provider`/`model`, a finite numeric
 * `effectiveFrom` (§8 needs a date to price history against), and price fields that
 * are a finite number, null, or absent (null/absent = "no price", renders n/a, never $0).
 * Returns an error phrase, or null when valid.
 */
function invalidReason(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'line is not a JSON object'
  const o = value as Record<string, unknown>
  if (typeof o.provider !== 'string' || o.provider === '') return 'provider must be a non-empty string'
  if (typeof o.model !== 'string' || o.model === '') return 'model must be a non-empty string'
  if (!Number.isFinite(o.effectiveFrom as number)) return 'effectiveFrom must be a finite ms-epoch number'
  for (const field of PRICE_FIELDS) {
    const v = o[field]
    if (v !== null && v !== undefined && !Number.isFinite(v as number)) return `${field} must be a finite number or null`
  }
  if (o.reasoningPerMTok !== null && o.reasoningPerMTok !== undefined && !Number.isFinite(o.reasoningPerMTok as number)) {
    return 'reasoningPerMTok must be a finite number or null'
  }
  if (o.tier !== undefined && o.tier !== null && typeof o.tier !== 'string') return 'tier must be a string or null'
  if (o.source !== undefined && !SOURCES.has(o.source as string)) return `source must be one of ${[...SOURCES].join(', ')}`
  return null
}

/**
 * Load the merged table for a store from any path that identifies it (see
 * `pricingStoreDir`). Pass `undefined` for "no store files": bundled snapshot, no overrides.
 *
 * Snapshot layer: an absent *or unreadable/invalid* snapshot file falls back to the
 * bundled one (this is `readSnapshotFile`'s documented contract, and what both callers
 * did before the merge moved here). The OpenRouter fallback sits on top of it and may only
 * price models the primary snapshot has no price for (§8: its rate is a reseller route
 * price, so it fills gaps and never overrides).
 *
 * Overrides layer — the §5.2 rule, unified from the two sides' raw `JSON.parse` crashes:
 * blank lines are skipped; every other line must pass `invalidReason`. Malformed lines
 * are never skipped silently and never merge partially: `loadMergedPricing` throws a
 * `PricingOverrideFileError` that counts the bad lines and names each with its line
 * number and reason, so the user fixes the file instead of pricing off half of it.
 * Later valid lines win over earlier ones; lines win over the snapshot (§8).
 */
export function loadMergedPricing(store?: string, opts: LoadMergedPricingOptions = {}): MergedPricing {
  const dir = store === undefined ? null : pricingStoreDir(store)
  const snapshotFile = opts.snapshotFile ?? (dir === null ? null : join(dir, PRICE_SNAPSHOT_FILENAME))
  const fallbackFile = opts.fallbackFile ?? (dir === null ? null : join(dir, OPENROUTER_SNAPSHOT_FILENAME))
  const overridesFile = opts.overridesFile ?? (dir === null ? null : join(dir, PRICING_OVERRIDES_FILENAME))

  const snapshot = (snapshotFile ? readSnapshotFile(snapshotFile) : null) ?? bundledSnapshot()
  let table = PricingTable.fromSnapshot(snapshot)

  const fallback = fallbackFile === null ? null : readSnapshotFile<RawOpenRouterEntry>(fallbackFile)
  let fallbackAdded = 0
  if (fallback) {
    const filled = table.withGapFill(PricingTable.fromOpenRouterSnapshot(fallback))
    table = filled.table
    fallbackAdded = filled.added
  }

  let overrideCount = 0
  const malformed: string[] = []
  if (overridesFile !== null && existsSync(overridesFile)) {
    const lines = readFileSync(overridesFile, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const trimmed = (lines[i] ?? '').trim()
      if (!trimmed) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (err) {
        malformed.push(`line ${i + 1}: not valid JSON (${(err as Error).message})`)
        continue
      }
      const reason = invalidReason(parsed)
      if (reason !== null) {
        malformed.push(`line ${i + 1}: ${reason}`)
        continue
      }
      // `withOverride` owns the snapshot-source → 'override' promotion; absent source means
      // the user wrote it by hand, which is an override.
      const raw = parsed as { source?: PriceEntry['source'] }
      table = table.withOverride({ ...raw, source: raw.source ?? 'override' } as PriceEntry)
      overrideCount++
    }
  }
  if (malformed.length > 0) {
    throw new PricingOverrideFileError(
      `${overridesFile}: ${malformed.length} malformed override line(s) — nothing was merged; fix the file (§5.2, no silent failures):\n` +
        malformed.map((m) => `  ${m}`).join('\n'),
    )
  }
  return { table, snapshot, fallback, fallbackAdded, overrideCount }
}
