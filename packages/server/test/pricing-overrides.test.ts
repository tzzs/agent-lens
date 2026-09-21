/**
 * §14 on the pricing side: the served `/api/doctor` must print the price-table size of
 * the SAME merged table (`price-snapshot.json` + `pricing-overrides.jsonl`) that
 * `agl doctor` counts. The audited defect: the server derived `priceTableSize` from the
 * snapshot alone, so a store with one override printed 432 where the CLI printed 433.
 * Every file below is synthetic and lives in a `mkdtemp` dir; no real agent data is read.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { PriceEntry, PriceSnapshot } from '@agentlens/pricing'
import { priceTableFor, startServer } from '../src/serve.ts'
import { loadPricing } from '../../../apps/cli/src/pricing-store.ts'

const NOW = Date.UTC(2026, 8, 21)

const entry = (model: string, input: number, output: number): PriceEntry => ({
  provider: 'anthropic',
  model,
  tier: null,
  inputPerMTok: input,
  outputPerMTok: output,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
  reasoningPerMTok: null,
  // Same effective date as the snapshot entries (they inherit `fetchedAt`): the override
  // then wins the tie through PricingTable's source priority, exactly as §8 intends.
  effectiveFrom: NOW,
  source: 'litellm',
})

const SNAPSHOT: PriceSnapshot = {
  schemaVersion: 1,
  fetchedAt: NOW,
  source: 'test-snapshot',
  entries: [
    { model: 'anthropic/alpha', litellm_provider: 'anthropic', input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 },
    { model: 'anthropic/beta', litellm_provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  ],
}

/** One line repricing `alpha`, one line pricing a model the snapshot never heard of. */
const OVERRIDES: PriceEntry[] = [
  { ...entry('alpha', 2, 9), source: 'override' },
  { ...entry('gamma', 7, 8), source: 'override' },
]

function storeDir(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentlens-pricing-overrides-'))
  const dbPath = join(dir, 'agentlens.db')
  writeFileSync(join(dir, 'price-snapshot.json'), JSON.stringify(SNAPSHOT), 'utf8')
  writeFileSync(
    join(dir, 'pricing-overrides.jsonl'),
    OVERRIDES.map((o) => JSON.stringify(o)).join('\n') + '\n',
    'utf8',
  )
  return { dir, dbPath }
}

describe('priceTableFor merges pricing-overrides.jsonl (defect 1)', () => {
  it('the table it returns prices the overrides and counts the extra model', () => {
    const { dir, dbPath } = storeDir()
    try {
      const { table } = priceTableFor(dbPath)
      // snapshot(2) + one newly priced override model, the repriced one folds in.
      expect(table.size()).toBe(3)
      expect(table.lookup('anthropic', 'alpha', NOW)).toMatchObject({ inputPerMTok: 2, outputPerMTok: 9 })
      expect(table.lookup('anthropic', 'gamma', NOW)).toMatchObject({ inputPerMTok: 7, outputPerMTok: 8 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('equals the CLI loadPricing view for the same store, entry for entry (§14)', () => {
    const { dir, dbPath } = storeDir()
    try {
      const served = priceTableFor(dbPath).table
      const cli = loadPricing(dbPath).table
      expect(served.size()).toBe(cli.size())
      for (const model of ['alpha', 'beta', 'gamma']) {
        expect(served.lookup('anthropic', model, NOW)).toEqual(cli.lookup('anthropic', model, NOW))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a store without overrides still prices from the snapshot alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentlens-pricing-bare-'))
    const dbPath = join(dir, 'agentlens.db')
    writeFileSync(join(dir, 'price-snapshot.json'), JSON.stringify(SNAPSHOT), 'utf8')
    try {
      expect(priceTableFor(dbPath).table.size()).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('startServer serves the merged numbers (defect 1 + defect 2 wiring)', () => {
  it('priceTableSize counts overrides and the billing file is honoured without injection', async () => {
    const { dir, dbPath } = storeDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ billing: { 'claude-code': 'subscription' } }), 'utf8')
    // Port 0: the OS picks, so concurrent runs cannot collide; only `ctx` is inspected.
    const running = startServer({ dbPath, port: 0 })
    try {
      expect(running.ctx.priceTableSize?.()).toBe(3)
      expect(running.ctx.billingModeFor?.('claude-code')).toBe('subscription')
      expect(running.ctx.billingModeFor?.('unknown-agent')).toBe('api')
      expect(running.ctx.cubeDeps.billingModeFor?.('claude-code')).toBe('subscription')
    } finally {
      // close() waits for the bind itself (port 0 listens asynchronously); see serve.ts.
      await running.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
