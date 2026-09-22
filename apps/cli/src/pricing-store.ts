/**
 * Pricing persistence for the CLI: snapshot + overrides live next to the DB
 * file, so `--db <temp>/x.db` in tests never touches ~/.agentlens.
 * The merge itself is §5.3's one-truth call into `@agentlens/pricing` —
 * this file only maps DB paths onto the store's file names.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  loadMergedPricing,
  liveBillingModes,
  PRICE_SNAPSHOT_FILENAME,
  PRICING_OVERRIDES_FILENAME,
  writeBillingMode,
  writeSnapshotFile,
  type BillingMode,
  type MergedPricing,
  type PriceEntry,
  type PriceSnapshot,
} from '@agentlens/pricing'

export function dataDir(dbPath: string): string {
  return dirname(dbPath)
}
export function snapshotPath(dbPath: string): string {
  return join(dataDir(dbPath), PRICE_SNAPSHOT_FILENAME)
}
export function overridesPath(dbPath: string): string {
  return join(dataDir(dbPath), PRICING_OVERRIDES_FILENAME)
}
export function configPath(dbPath: string): string {
  return join(dataDir(dbPath), 'config.json')
}

export function ensureDataDir(dbPath: string): void {
  mkdirSync(dataDir(dbPath), { recursive: true })
}

export type LoadedPricing = MergedPricing

/** Snapshot file when present (after `pricing update`), else the bundled snapshot; overrides always win (§8). */
export function loadPricing(dbPath: string): LoadedPricing {
  return loadMergedPricing(snapshotPath(dbPath))
}

export function writeSnapshot(dbPath: string, snapshot: PriceSnapshot): void {
  ensureDataDir(dbPath)
  writeSnapshotFile(snapshotPath(dbPath), snapshot)
}

export function appendOverride(dbPath: string, entry: PriceEntry): void {
  ensureDataDir(dbPath)
  appendFileSync(overridesPath(dbPath), JSON.stringify(entry) + '\n')
}

/**
 * §8 billing modes are a user declaration, kept in <dataDir>/config.json:
 * `{"billing": {agent: mode}}`. The returned view re-reads the file when it changes:
 * `queryDeps()` runs once per command, but `--serve` holds its deps for the lifetime of
 * the dashboard while the Settings page writes declarations into this same file (§14).
 */
export function loadBillingModes(dbPath: string): Record<string, BillingMode> {
  return liveBillingModes(configPath(dbPath))
}

/** Declare (`mode`) or undeclare (`null`) one agent; returns the validated declarations left. */
export function setBillingMode(
  dbPath: string,
  agentId: string,
  mode: BillingMode | null,
): Record<string, BillingMode> {
  ensureDataDir(dbPath)
  return writeBillingMode(configPath(dbPath), agentId, mode)
}
