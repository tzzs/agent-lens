/**
 * §5.3: `loadMergedPricing` is the one truth both the CLI and the server call.
 * These tests live in the package so a rule here (merge order, path convention,
 * malformed-line handling) is pinned where it can no longer drift per-caller.
 * Every file is synthetic and lives under a `mkdtemp` dir.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bundledSnapshot,
  loadMergedPricing,
  pricingStoreDir,
  PricingTable,
  OPENROUTER_SNAPSHOT_FILENAME,
  PRICE_SNAPSHOT_FILENAME,
  PRICING_OVERRIDES_FILENAME,
  PricingOverrideFileError,
  type OpenRouterSnapshot,
  type PriceEntry,
  type PriceSnapshot,
} from '../src/index.ts'

const NOW = Date.UTC(2026, 8, 21)

const SNAPSHOT: PriceSnapshot = {
  schemaVersion: 1,
  fetchedAt: NOW,
  source: 'test-snapshot',
  entries: [
    { model: 'anthropic/alpha', litellm_provider: 'anthropic', input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 },
    { model: 'anthropic/beta', litellm_provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  ],
}

/** `alpha` is the disagreement case (§8: the reseller rate loses); `omega` is a litellm gap. */
const FALLBACK: OpenRouterSnapshot = {
  schemaVersion: 1,
  fetchedAt: NOW,
  source: 'test-openrouter',
  entries: [
    { model: 'anthropic/alpha', pricing: { prompt: '0.000009', completion: '0.000036' }, effective_from: 0 },
    { model: 'z-ai/omega', pricing: { prompt: '0.00000015', completion: '0.0000005' }, effective_from: 0 },
  ],
}

const override = (model: string, input: number, over: Partial<PriceEntry> = {}): PriceEntry => ({
  provider: 'anthropic',
  model,
  tier: null,
  inputPerMTok: input,
  outputPerMTok: input * 4,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
  reasoningPerMTok: null,
  effectiveFrom: NOW,
  source: 'override',
  ...over,
})

function store(files: { snapshot?: string; fallback?: string; overrides?: string } = {}): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentlens-merge-'))
  if (files.snapshot !== undefined) writeFileSync(join(dir, PRICE_SNAPSHOT_FILENAME), files.snapshot, 'utf8')
  if (files.fallback !== undefined) writeFileSync(join(dir, OPENROUTER_SNAPSHOT_FILENAME), files.fallback, 'utf8')
  if (files.overrides !== undefined) writeFileSync(join(dir, PRICING_OVERRIDES_FILENAME), files.overrides, 'utf8')
  return { dir, dbPath: join(dir, 'agentlens.db') }
}

describe('loadMergedPricing: the OpenRouter fallback layer (§8)', () => {
  it('adds only the models the primary snapshot lacks, and counts them', () => {
    const { dir, dbPath } = store({ snapshot: JSON.stringify(SNAPSHOT), fallback: JSON.stringify(FALLBACK) })
    try {
      const merged = loadMergedPricing(dbPath)
      expect(merged.fallback?.source).toBe('test-openrouter')
      expect(merged.fallbackAdded).toBe(1)
      expect(merged.table.lookup('anthropic', 'alpha', NOW)).toMatchObject({ inputPerMTok: 3, source: 'litellm' })
      expect(merged.table.lookup('z-ai', 'omega', NOW)).toMatchObject({ inputPerMTok: 0.15, source: 'openrouter' })
      // Undated, so an event from before the fetch is still priced (§19).
      expect(merged.table.lookup('z-ai', 'omega', Date.UTC(2020, 0, 1))?.source).toBe('openrouter')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an absent fallback is reported as absent, and a broken one is ignored like a broken snapshot', () => {
    const none = store({ snapshot: JSON.stringify(SNAPSHOT) })
    try {
      const merged = loadMergedPricing(none.dbPath)
      expect(merged.fallback).toBeNull()
      expect(merged.fallbackAdded).toBe(0)
    } finally {
      rmSync(none.dir, { recursive: true, force: true })
    }

    const broken = store({ snapshot: JSON.stringify(SNAPSHOT), fallback: '<html>rate limited</html>' })
    try {
      const merged = loadMergedPricing(broken.dbPath)
      expect(merged.fallback).toBeNull()
      expect(merged.snapshot.source).toBe('test-snapshot')
    } finally {
      rmSync(broken.dir, { recursive: true, force: true })
    }
  })

  it('an override line still wins over both snapshot sources', () => {
    const { dir, dbPath } = store({
      snapshot: JSON.stringify(SNAPSHOT),
      fallback: JSON.stringify(FALLBACK),
      overrides: JSON.stringify(override('omega', 12, { provider: 'z-ai' })) + '\n',
    })
    try {
      const merged = loadMergedPricing(dbPath)
      expect(merged.table.lookup('z-ai', 'omega', NOW)).toMatchObject({ inputPerMTok: 12, source: 'override' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a pasted fallback row in the overrides file is promoted to an override, not left below litellm', () => {
    const { dir, dbPath } = store({ snapshot: JSON.stringify(SNAPSHOT), overrides: JSON.stringify(override('alpha', 1, { source: 'openrouter' })) + '\n' })
    try {
      expect(loadMergedPricing(dbPath).table.lookup('anthropic', 'alpha', NOW)).toMatchObject({
        inputPerMTok: 1,
        source: 'override',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loadMergedPricing: snapshot + overrides (§8, §14)', () => {
  it('merges overrides over the snapshot file, counting what was applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlens-merge-'))
    try {
      const dbPath = join(dir, 'agentlens.db')
      writeFileSync(join(dir, PRICE_SNAPSHOT_FILENAME), JSON.stringify(SNAPSHOT), 'utf8')
      writeFileSync(
        join(dir, PRICING_OVERRIDES_FILENAME),
        [JSON.stringify(override('alpha', 2)), '', '   ', JSON.stringify(override('gamma', 7))].join('\n') + '\n',
        'utf8',
      )
      const merged = loadMergedPricing(dbPath)
      expect(merged.snapshot.source).toBe('test-snapshot')
      expect(merged.overrideCount).toBe(2) // blank lines skipped, not counted
      expect(merged.table.size()).toBe(3) // snapshot(2) + gamma; alpha repriced
      expect(merged.table.lookup('anthropic', 'alpha', NOW)).toMatchObject({ inputPerMTok: 2, source: 'override' })
      expect(merged.table.lookup('anthropic', 'gamma', NOW)).toMatchObject({ inputPerMTok: 7 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('later lines win over earlier ones for the same (provider, model)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlens-merge-'))
    try {
      writeFileSync(join(dir, PRICE_SNAPSHOT_FILENAME), JSON.stringify(SNAPSHOT), 'utf8')
      writeFileSync(
        join(dir, PRICING_OVERRIDES_FILENAME),
        [JSON.stringify(override('delta', 1)), JSON.stringify(override('delta', 9))].join('\n') + '\n',
        'utf8',
      )
      expect(loadMergedPricing(dir).table.lookup('anthropic', 'delta', NOW)).toMatchObject({ inputPerMTok: 9 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the bundled snapshot when none is on disk (or it is invalid)', () => {
    const absent = store()
    rmSync(absent.dir, { recursive: true, force: true })
    expect(loadMergedPricing(absent.dbPath).snapshot).toBe(bundledSnapshot())

    const broken = store({ snapshot: 'not json at all' })
    try {
      // readSnapshotFile's documented contract: unreadable → null → bundled, both ends.
      expect(loadMergedPricing(broken.dbPath).snapshot).toBe(bundledSnapshot())
    } finally {
      rmSync(broken.dir, { recursive: true, force: true })
    }
  })

  it('an undefined store means "no store files": bundled snapshot, nothing merged', () => {
    const merged = loadMergedPricing(undefined)
    expect(merged.overrideCount).toBe(0)
    expect(merged.snapshot).toBe(bundledSnapshot())
    expect(merged.table.size()).toBe(PricingTable.fromSnapshot(bundledSnapshot()).size())
  })
})

describe('loadMergedPricing: path convention (§5.3, one spelling)', () => {
  it('db file, data dir and snapshot file all resolve to the same store', () => {
    const { dir, dbPath } = store({
      snapshot: JSON.stringify(SNAPSHOT),
      fallback: JSON.stringify(FALLBACK),
      overrides: JSON.stringify(override('gamma', 7)) + '\n',
    })
    try {
      const byDb = loadMergedPricing(dbPath)
      expect(loadMergedPricing(dir)).toEqual(byDb)
      expect(loadMergedPricing(join(dir, PRICE_SNAPSHOT_FILENAME))).toEqual(byDb)
      // The fallback file is found the same way from every spelling of the store.
      expect(loadMergedPricing(join(dir, OPENROUTER_SNAPSHOT_FILENAME))).toEqual(byDb)
      expect(byDb.overrideCount).toBe(1)
      expect(byDb.fallbackAdded).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pricingStoreDir keeps the bare-name and root cases the CLI used', () => {
    expect(pricingStoreDir('agentlens.db')).toBe('.')
    expect(pricingStoreDir('/agentlens.db')).toBe('/')
    expect(pricingStoreDir('/tmp/x/agentlens.db')).toBe('/tmp/x')
    expect(pricingStoreDir('/tmp/x/price-snapshot.json')).toBe('/tmp/x')
  })

  it('opts can point at files outside the convention', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlens-merge-opts-'))
    try {
      const snapPath = join(dir, 'mirror.json')
      const overPath = join(dir, 'mirror-overrides.jsonl')
      writeFileSync(snapPath, JSON.stringify(SNAPSHOT), 'utf8')
      writeFileSync(overPath, JSON.stringify(override('gamma', 7)) + '\n', 'utf8')
      const merged = loadMergedPricing(join(dir, 'agentlens.db'), { snapshotFile: snapPath, overridesFile: overPath })
      expect(merged.overrideCount).toBe(1)
      expect(merged.snapshot.source).toBe('test-snapshot')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loadMergedPricing: malformed lines are surfaced, never skipped silently (§5.2)', () => {
  it('throws one counted error naming every bad line, and merges nothing', () => {
    const { dir, dbPath } = store({
      snapshot: JSON.stringify(SNAPSHOT),
      overrides:
        JSON.stringify(override('gamma', 7)) +
        '\n' +
        '{oops not json\n' +
        '\n' +
        JSON.stringify({ ...override('bad1', 1), provider: 42 }) +
        '\n' +
        '42\n',
    })
    try {
      expect(() => loadMergedPricing(dbPath)).toThrow(PricingOverrideFileError)
      const message = (() => {
        try {
          loadMergedPricing(dbPath)
          return ''
        } catch (e) {
          return (e as Error).message
        }
      })()
      expect(message).toContain('3 malformed override line(s)')
      expect(message).toContain('line 2: not valid JSON')
      expect(message).toContain('line 4: provider must be a non-empty string')
      expect(message).toContain('line 5: line is not a JSON object')
      // A store the CLI refuses, the server refuses too: both call this one function.
      expect(() => loadMergedPricing(dir)).toThrow(/nothing was merged/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown source and a missing effectiveFrom, accepts null/absent prices as no-price (§8 n/a)', () => {
    const bad = store({ snapshot: JSON.stringify(SNAPSHOT), overrides: JSON.stringify({ ...override('m', 1), source: 'guess' }) + '\n' })
    try {
      expect(() => loadMergedPricing(bad.dbPath)).toThrow(/source must be one of/)
    } finally {
      rmSync(bad.dir, { recursive: true, force: true })
    }
    const noDate = store({ snapshot: JSON.stringify(SNAPSHOT), overrides: JSON.stringify(override('m', 1, { effectiveFrom: undefined })) + '\n' })
    try {
      expect(() => loadMergedPricing(noDate.dbPath)).toThrow(/effectiveFrom must be a finite/)
    } finally {
      rmSync(noDate.dir, { recursive: true, force: true })
    }
    // JSON.stringify(NaN) writes `null`; a line with null/absent prices must still merge —
    // unpriced fields render n/a, never $0 (§8).
    const nulls = store({
      snapshot: JSON.stringify(SNAPSHOT),
      overrides:
        JSON.stringify({ provider: 'anthropic', model: 'sparse', effectiveFrom: NOW, inputPerMTok: null }) + '\n',
    })
    try {
      const merged = loadMergedPricing(nulls.dbPath)
      expect(merged.overrideCount).toBe(1)
      expect(merged.table.lookup('anthropic', 'sparse', NOW)).toMatchObject({ inputPerMTok: null, source: 'override' })
    } finally {
      rmSync(nulls.dir, { recursive: true, force: true })
    }
  })
})
