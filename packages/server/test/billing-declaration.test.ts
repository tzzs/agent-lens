/**
 * §14 on the billing side, at the seam the audit found broken: a declaration made
 * through the API (or `agl pricing billing set`) must fold into the NEXT request, even
 * when nobody injected `billingModeFor`. Before the fix, a server not started through
 * the CLI answered every cost with the `'api'` fallback, so `/api/overview` kept showing
 * `actualUsd === apiEquivalentUsd` after a `subscription` declaration returned 200.
 * The harness drives the Hono app in-process; all data is synthetic.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { billingConfigPath } from '@agentlens/pricing'
import { createApp } from '../src/app.ts'
import { harness, type Response_ } from './helpers.ts'

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-billing-declaration-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** Like the CLI's `--serve` minus the CLI: dbPath set, NO billingModeFor injected. */
function plainServeHarness() {
  const dbPath = join(mkdtempSync(join(tmp, 'case-')), 'agentlens.db')
  const h = harness({ dbPath })
  expect(h.ctx.billingModeFor).toBeDefined()
  return { h, dbPath }
}

async function put(app: ReturnType<typeof createApp>, path: string, body: unknown): Promise<Response_> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text, text, headers: res.headers }
}

/**
 * The priced window of the fixture: the other session's model is unpriced on purpose,
 * and `since` reaches back over the 2023-vintage timestamps from the real clock.
 */
const PRICED = '/api/overview?model=test-model&since=9999d'
/** /api/overview carries its §8 cost block under `cards.cost`. */
function overviewCost(res: Response_): any {
  expect(res.status).toBe(200)
  return res.body.cards.cost
}

describe('a billing declaration without any injected billingModeFor (defect 2)', () => {
  it('defaults to api before anything is declared', async () => {
    const { h } = plainServeHarness()
    try {
      const res = await h.get(PRICED)
      expect(res.status).toBe(200)
      const cost = overviewCost(res)
      expect(cost.pricingConfigured).toBe(true)
      expect(cost.apiEquivalentUsd).toBeGreaterThan(0)
      expect(cost.actualUsd).toBe(cost.apiEquivalentUsd)
    } finally {
      h.close()
    }
  })

  it('POST /api/settings/billing changes the next GET /api/overview, no restart', async () => {
    const { h, dbPath } = plainServeHarness()
    try {
      const declared = await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'subscription' })
      expect(declared.status).toBe(200)
      expect(JSON.parse(declared.text)).toMatchObject({ agent: 'claude-code', mode: 'subscription' })

      const res = await h.get(PRICED)
      const cost = overviewCost(res)
      // §8: the plan's cash is $0 while the API-equivalent keeps pricing.
      expect(cost.apiEquivalentUsd).toBeGreaterThan(0)
      expect(cost.actualUsd).toBe(0)
      expect(cost.actualUsd).not.toBe(cost.apiEquivalentUsd)
      const slice = cost.perAgent.find((s: { agentId: string }) => s.agentId === 'claude-code')
      expect(slice).toMatchObject({ billingMode: 'subscription', actualUsd: 0 })

      // The agents route folds the same declaration, and says so per row.
      const agents = await h.get('/api/agents?model=test-model')
      expect(agents.body.rows[0].billingMode).toBe('subscription')
      expect(agents.body.cost.actualUsd).toBe(0)
    } finally {
      h.close()
      rmSync(billingConfigPath(dbPath), { force: true })
    }
  })

  it('a local declaration zeroes cash too, and clearing restores the api view', async () => {
    const { h } = plainServeHarness()
    try {
      await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'local' })
      expect(overviewCost(await h.get(PRICED)).actualUsd).toBe(0)

      await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: null })
      const back = overviewCost(await h.get(PRICED))
      expect(back.actualUsd).toBe(back.apiEquivalentUsd)
      expect(back.actualUsd).toBeGreaterThan(0)
    } finally {
      h.close()
    }
  })

  it('a config.json written outside the API (CLI-style hand edit) is honoured as well', async () => {
    const { h, dbPath } = plainServeHarness()
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(billingConfigPath(dbPath), JSON.stringify({ billing: { 'claude-code': 'subscription' } }), 'utf8')
      const cost = overviewCost(await h.get(PRICED))
      expect(cost.actualUsd).toBe(0)
      expect(cost.apiEquivalentUsd).toBeGreaterThan(0)
    } finally {
      h.close()
      rmSync(billingConfigPath(dbPath), { force: true })
    }
  })
})
