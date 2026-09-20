/**
 * Pricing persistence for the CLI: snapshot + overrides live next to the DB
 * file, so `--db <temp>/x.db` in tests never touches ~/.agentlens.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  bundledSnapshot,
  PricingTable,
  readSnapshotFile,
  writeSnapshotFile,
  type BillingMode,
  type PriceEntry,
  type PriceSnapshot,
} from '@agentlens/pricing'

const BILLING_MODES: readonly BillingMode[] = ['api', 'subscription', 'local']

export function dataDir(dbPath: string): string {
  return dirname(dbPath)
}
export function snapshotPath(dbPath: string): string {
  return join(dataDir(dbPath), 'price-snapshot.json')
}
export function overridesPath(dbPath: string): string {
  return join(dataDir(dbPath), 'pricing-overrides.jsonl')
}
export function configPath(dbPath: string): string {
  return join(dataDir(dbPath), 'config.json')
}

export function ensureDataDir(dbPath: string): void {
  mkdirSync(dataDir(dbPath), { recursive: true })
}

export interface LoadedPricing {
  table: PricingTable
  snapshot: PriceSnapshot
  overrideCount: number
}

/** Snapshot file when present (after `pricing update`), else the bundled snapshot; overrides always win (§8). */
export function loadPricing(dbPath: string): LoadedPricing {
  let snapshot: PriceSnapshot
  try {
    snapshot = readSnapshotFile(snapshotPath(dbPath)) ?? bundledSnapshot()
  } catch (err) {
    throw new Error(`price snapshot at ${basenameSafe(snapshotPath(dbPath))} is unreadable: ${(err as Error).message}`)
  }
  let table = PricingTable.fromSnapshot(snapshot)
  let overrideCount = 0
  const op = overridesPath(dbPath)
  if (existsSync(op)) {
    for (const line of readFileSync(op, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      const entry = JSON.parse(t) as PriceEntry
      table = table.withOverride(entry)
      overrideCount++
    }
  }
  return { table, snapshot, overrideCount }
}

function basenameSafe(p: string): string {
  return p.split('/').pop() ?? p
}

export function writeSnapshot(dbPath: string, snapshot: PriceSnapshot): void {
  ensureDataDir(dbPath)
  writeSnapshotFile(snapshotPath(dbPath), snapshot)
}

export function appendOverride(dbPath: string, entry: PriceEntry): void {
  ensureDataDir(dbPath)
  appendFileSync(overridesPath(dbPath), JSON.stringify(entry) + '\n')
}

/** §8 billing modes are a user declaration, kept in <dataDir>/config.json: {"billing": {agent: mode}}. */
export function loadBillingModes(dbPath: string): Record<string, BillingMode> {
  const cp = configPath(dbPath)
  if (!existsSync(cp)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(cp, 'utf8'))
  } catch {
    return {}
  }
  const billing = (raw as { billing?: unknown }).billing
  if (typeof billing !== 'object' || billing === null) return {}
  const out: Record<string, BillingMode> = {}
  for (const [agent, mode] of Object.entries(billing as Record<string, unknown>)) {
    if (typeof mode === 'string' && BILLING_MODES.includes(mode as BillingMode)) out[agent] = mode as BillingMode
  }
  return out
}
