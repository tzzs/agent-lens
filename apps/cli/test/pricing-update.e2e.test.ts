/**
 * §9 `pricing update` — the price-snapshot refresh feeding every cost figure in the product.
 * The fetch already sits behind `fetchLitellmSnapshot`'s injectable `fetchImpl`, so these
 * tests drive the whole command against a synthetic local map and never touch a URL.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { readSnapshotFile } from '@agentlens/pricing'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { runCli } from '../src/index.ts'
import type { Ctx } from '../src/context.ts'
import { cmdPricingUpdate } from '../src/commands/admin.ts'
import { snapshotPath } from '../src/pricing-store.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-pricing-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 8, 20, 9)
/** Synthetic litellm map: $2 / 1M input, $10 / 1M output. */
const FIXTURE_MAP = JSON.stringify({
  'testprovider/test-priced-model': {
    litellm_provider: 'testprovider',
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
  },
  'testprovider/test-second-model': {
    litellm_provider: 'testprovider',
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
  },
})

/** The seam `packages/pricing` documents for offline runs: a stand-in for `globalThis.fetch`. */
function seam(body: string, opts: { ok?: boolean; status?: number } = {}) {
  const urls: string[] = []
  const response = {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => body,
  } as unknown as Response
  return {
    urls,
    fetchImpl: async (url: string): Promise<Response> => {
      urls.push(url)
      return response
    },
  }
}

function throwing(message: string) {
  return {
    fetchImpl: async (): Promise<Response> => {
      throw new Error(message)
    },
  }
}

/** One directory per case: the snapshot file sits next to the db, so a shared dir would leak. */
function dbIn(name: string): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'agentlens.db')
}

function makeCtx(dbPath: string, argv: string[] = []): { ctx: Ctx; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    ctx: { argv, out: (l) => lines.push(l), err: (l) => lines.push(l), homedir: tmp, env: {}, now: () => T0 },
  }
}

/** One priced request: 1000 in + 500 out of a model only the fetched snapshot knows. */
function seedPricedDb(dbPath: string): void {
  const ev: AgentEvent = {
    id: 'c'.repeat(64),
    schemaVersion: 1,
    agentId: 'claude-code',
    hostId: 'claude-code',
    sourceId: 'src-price',
    sessionId: 'sess-price',
    projectId: 'proj-price',
    timestamp: T0,
    type: 'generation.end',
    usageSource: 'reported',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    requestId: 'req-priced',
    model: { provider: 'testprovider', name: 'test-priced-model', tier: null },
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }
  const db = openDatabase(dbPath)
  migrate(db)
  insertEvents(db, [ev])
  db.close()
}

describe('agl pricing update (§9, §8)', () => {
  it('writes the fetched snapshot, and the cube then prices history from it', async () => {
    const dbPath = dbIn('update')
    seedPricedDb(dbPath)
    const before = makeCtx(dbPath, ['usage', '--by', 'model', '--db', dbPath])
    expect(await runCli(before.ctx)).toBe(0)
    expect(before.lines.join('\n')).toContain('n/a') // unpriced model is n/a, never $0 (§8)

    const fetch = seam(FIXTURE_MAP)
    const { ctx, lines } = makeCtx(dbPath)
    const code = await cmdPricingUpdate(dbPath, ctx, { fetchImpl: fetch.fetchImpl, now: () => T0 - 86_400_000 })
    const out = lines.join('\n')
    expect(code, out).toBe(0)
    expect(out).toContain('price snapshot updated: 2 entries')
    expect(out).not.toContain(tmp)
    // A literal, not the constant: asserting against LITELLM_PRICES_URL let a typo in
    // the org name ship, and `agl pricing update` could then never succeed.
    expect(fetch.urls).toEqual([
      'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    ])

    const stored = readSnapshotFile(snapshotPath(dbPath))
    expect(stored?.entries.map((e) => e.model)).toEqual(['testprovider/test-priced-model', 'testprovider/test-second-model'])
    expect(stored?.fetchedAt).toBe(T0 - 86_400_000)

    // 1000 in x $2/M + 500 out x $10/M = $0.002 + $0.005 — the same file the dashboard reads.
    const after = makeCtx(dbPath, ['usage', '--by', 'model', '--db', dbPath])
    expect(await runCli(after.ctx)).toBe(0)
    const usageOut = after.lines.join('\n')
    expect(usageOut).toContain('test-priced-model')
    expect(usageOut).toContain('$0.0070')
    expect(usageOut).not.toContain('n/a')
  })

  it('an HTTP failure exits 1 and leaves the previous snapshot byte-identical', async () => {
    const dbPath = dbIn('http-fail')
    expect(await cmdPricingUpdate(dbPath, makeCtx(dbPath).ctx, { fetchImpl: seam(FIXTURE_MAP).fetchImpl })).toBe(0)
    const before = readFileSync(snapshotPath(dbPath), 'utf8')

    const { ctx, lines } = makeCtx(dbPath)
    expect(await cmdPricingUpdate(dbPath, ctx, { fetchImpl: seam('', { ok: false, status: 503 }).fetchImpl })).toBe(1)
    const out = lines.join('\n')
    expect(out).toContain('pricing update failed')
    expect(out).toContain('HTTP 503')
    expect(readFileSync(snapshotPath(dbPath), 'utf8')).toBe(before)
  })

  it('a body that is not JSON is a reported parse failure, not a cleared price table', async () => {
    const dbPath = dbIn('bad-json')
    const { ctx, lines } = makeCtx(dbPath)
    expect(await cmdPricingUpdate(dbPath, ctx, { fetchImpl: seam('<html>gateway timeout</html>').fetchImpl })).toBe(1)
    expect(lines.join('\n')).toContain('not valid JSON')
    expect(existsSync(snapshotPath(dbPath))).toBe(false)
  })

  it('a JSON body that is not a model map is rejected and nothing is written', async () => {
    const dbPath = dbIn('array-body')
    const { ctx, lines } = makeCtx(dbPath)
    expect(await cmdPricingUpdate(dbPath, ctx, { fetchImpl: seam('[1,2,3]').fetchImpl })).toBe(1)
    expect(lines.join('\n')).toContain('must be a JSON object keyed by model id')
    expect(existsSync(snapshotPath(dbPath))).toBe(false)
  })

  it('a transport rejection is reported with its reason', async () => {
    const dbPath = dbIn('reject')
    const { ctx, lines } = makeCtx(dbPath)
    expect(await cmdPricingUpdate(dbPath, ctx, throwing('socket hang up'))).toBe(1)
    expect(lines.join('\n')).toContain('failed to fetch price snapshot')
    expect(lines.join('\n')).toContain('socket hang up')
  })
})
