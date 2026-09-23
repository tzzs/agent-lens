/**
 * The §8 billing-mode declaration route. What matters here is not the HTTP shape but
 * the seam: the route writes the SAME file the CLI's `billingModeFor` reads, so the
 * dashboard can never report a mode the terminal would deny (§14). The harness drives
 * the Hono app in-process and never binds a socket. Synthetic fixtures only.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { billingConfigPath, billingModeFor as resolveMode, liveBillingModes } from '@agentlens/pricing'
import { createApp } from '../src/app.ts'
import { harness, type Response_ } from './helpers.ts'

/** POST bodies need a real request: the shared harness only covers bodyless calls. */
async function put(app: ReturnType<typeof createApp>, path: string, body: unknown): Promise<Response_> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* keep the raw text */
  }
  return { status: res.status, body: parsed, text, headers: res.headers }
}

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-billing-route-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A harness whose pricing view is the live store, exactly as apps/cli wires it. */
function billingHarness() {
  // One directory per case: the declaration file sits next to the DB, so sharing a
  // directory would leak one test's declaration into the next.
  const dbPath = join(mkdtempSync(join(tmp, 'case-')), 'agentlens.db')
  const modes = liveBillingModes(billingConfigPath(dbPath))
  const h = harness({ dbPath, billingModeFor: (agentId, provider, model) => resolveMode(modes, agentId, provider, model) })
  return { h, dbPath, modes }
}

describe('GET /api/settings/billing', () => {
  it('lists every known agent with its declared mode, and defaults to api', async () => {
    const { h, dbPath } = billingHarness()
    try {
      writeFileSync(billingConfigPath(dbPath), JSON.stringify({ billing: { 'claude-code': 'subscription' } }), 'utf8')
      const res = await h.get('/api/settings/billing')
      expect(res.status).toBe(200)
      expect(res.body.modes).toEqual({
        'claude-code': { mode: 'subscription', planUsdPerMonth: null, models: {} },
      })
      expect(res.body.agents).toEqual([
        {
          agentId: 'claude-code',
          displayName: 'Claude Code',
          billingMode: 'subscription',
          declared: true,
          planUsdPerMonth: null,
          models: expect.arrayContaining([
            // Every model the store has events for is offered, priced at the agent default
            // until something narrower is declared for it.
            expect.objectContaining({ provider: 'anthropic', effectiveMode: 'subscription', overridden: false }),
          ]),
        },
      ])
    } finally {
      h.close()
    }
  })

  it('answers 501 when the server has no database file to declare into', async () => {
    const h = harness()
    try {
      const res = await h.get('/api/settings/billing')
      expect(res.status).toBe(501)
      expect(res.body.error.kind).toBe('not_implemented')
      expect(res.body.error.message).toContain('config.json')
    } finally {
      h.close()
    }
  })
})

describe('POST /api/settings/billing', () => {
  it('declares a mode and the cube-facing view changes in the same process', async () => {
    const { h, dbPath, modes } = billingHarness()
    try {
      expect(modes['claude-code']).toBeUndefined()
      const res = await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'local' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        agent: 'claude-code',
        mode: 'local',
        planUsdPerMonth: null,
        modes: { 'claude-code': { mode: 'local', planUsdPerMonth: null, models: {} } },
      })
      // The file the CLI reads, in the documented shape:
      expect(JSON.parse(readFileSync(billingConfigPath(dbPath), 'utf8'))).toEqual({ billing: { 'claude-code': 'local' } })
      // ...and the same view the cost routes fold through:
      expect(modes['claude-code']).toEqual({ mode: 'local', planUsdPerMonth: null, models: {} })
      // The fixture's other session uses an unpriced model, so the window is pinned to
      // the priced one: an unpriced slice must stay n/a, which would hide this assert.
      const agents = await h.get('/api/agents?model=test-model')
      expect(agents.body.rows[0].billingMode).toBe('local')
      const cost = agents.body.cost
      const slice = cost.perAgent.find((s: { agentId: string }) => s.agentId === 'claude-code')
      expect(slice.billingMode).toBe('local')
      // §8's pair, both numbers at once: cash is $0 while the tokens price out.
      expect(slice.apiEquivalentUsd).toBeGreaterThan(0)
      expect(slice.actualUsd).toBe(0)
      expect(cost.apiEquivalentUsd).toBeGreaterThan(0)
      expect(cost.actualUsd).toBe(0)
    } finally {
      h.close()
    }
  })

  it('rejects a mode outside the BillingMode union with 400 and the legal set', async () => {
    const { h, dbPath } = billingHarness()
    try {
      const res = await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'payg' })
      expect(res.status).toBe(400)
      expect(res.body.error.kind).toBe('bad_request')
      expect(res.body.error.message).toContain('api | subscription | local')
      // A rejected declaration never reaches the file — which here means it is not
      // created at all.
      expect(existsSync(billingConfigPath(dbPath))).toBe(false)
    } finally {
      h.close()
    }
  })

  it('rejects a missing agent, an unknown agent (404) and a non-JSON body (400)', async () => {
    const { h } = billingHarness()
    try {
      expect((await put(h.app, '/api/settings/billing', { mode: 'api' })).status).toBe(400)
      expect((await put(h.app, '/api/settings/billing', { agent: 'ghost', mode: 'api' })).status).toBe(404)
      const bad = await put(h.app, '/api/settings/billing', 'not json')
      expect(bad.status).toBe(400)
      expect(bad.body.error.message).toContain('JSON')
    } finally {
      h.close()
    }
  })

  it('mode null clears the declaration, and the agent returns to the default', async () => {
    const { h, dbPath, modes } = billingHarness()
    try {
      await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'local' })
      const cleared = await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: null })
      expect(cleared.status).toBe(200)
      expect(cleared.body).toEqual({ agent: 'claude-code', mode: 'api', planUsdPerMonth: null, modes: {} })
      expect(modes['claude-code']).toBeUndefined()
      // A cleared agent still lists, because the store has its events; what changed is that
      // nothing is declared for it any more.
      const res = await h.get('/api/settings/billing')
      expect(res.body.agents[0]).toEqual({
        agentId: 'claude-code',
        displayName: 'Claude Code',
        billingMode: 'api',
        declared: false,
        planUsdPerMonth: null,
        models: expect.any(Array),
      })
      // Clearing keeps the user's other settings in the same file.
      writeFileSync(billingConfigPath(dbPath), JSON.stringify({ retentionDays: 30, billing: { x: 'local' } }), 'utf8')
      await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'api' })
      expect(JSON.parse(readFileSync(billingConfigPath(dbPath), 'utf8')).retentionDays).toBe(30)
    } finally {
      h.close()
    }
  })
})

describe('§8 per-model declarations and the plan fee', () => {
  it('narrowing one model leaves the agent default and the other models alone', async () => {
    const { h } = billingHarness()
    try {
      await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'subscription' })
      const res = await put(h.app, '/api/settings/billing', {
        agent: 'claude-code',
        model: 'anthropic/test-model',
        mode: 'api',
      })
      expect(res.status).toBe(200)
      // The reply reports both halves, because a caller that only learned the default would
      // render the agent as still fully on the plan.
      expect(res.body.model).toEqual({ key: 'anthropic/test-model', mode: 'api' })
      expect(res.body.mode).toBe('subscription')
      const view = await h.get('/api/settings/billing')
      const row = view.body.agents.find((a: { agentId: string }) => a.agentId === 'claude-code')
      expect(row.billingMode).toBe('subscription')
      expect(row.models.find((m: { key: string }) => m.key === 'anthropic/test-model')).toEqual({
        key: 'anthropic/test-model',
        provider: 'anthropic',
        model: 'test-model',
        effectiveMode: 'api',
        overridden: true,
      })
      // The file holds one declaration, not a default rewritten to the model's mode.
      expect(res.body.modes['claude-code']).toEqual({
        mode: 'subscription',
        planUsdPerMonth: null,
        models: { 'anthropic/test-model': 'api' },
      })
    } finally {
      h.close()
    }
  })

  it('the metered model costs cash inside a plan-covered agent, and the pair is reported as mixed', async () => {
    const { h } = billingHarness()
    try {
      const plain = await h.get('/api/agents')
      const before = plain.body.cost.perAgent.find((s: { agentId: string }) => s.agentId === 'claude-code')
      // Undeclared, so this is the `api` default: cash and API-equivalent are the same number.
      expect(before.mixedBilling).toBe(false)
      expect(before.actualUsd).toBeCloseTo(before.apiEquivalentUsd, 10)

      await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'subscription' })
      await put(h.app, '/api/settings/billing', { agent: 'claude-code', model: 'anthropic/test-model', mode: 'api' })
      const after = (await h.get('/api/agents')).body.cost.perAgent.find(
        (s: { agentId: string }) => s.agentId === 'claude-code',
      )
      // Folding the agent at its default would have kept this $0; the model-level answer pays
      // for the one model the user said is metered.
      expect(after.mixedBilling).toBe(true)
      expect(after.actualUsd).toBeGreaterThan(0)
      expect(after.apiEquivalentUsd).toBeCloseTo(after.actualUsd, 10)
    } finally {
      h.close()
    }
  })

  it('prorates a declared plan fee over the window, and counts it once however many models ride the plan', async () => {
    const { h } = billingHarness()
    try {
      await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'subscription' })
      const unfilled = await h.get('/api/agents')
      const u = unfilled.body.cost.perAgent.find((s: { agentId: string }) => s.agentId === 'claude-code')
      // No fee yet: the marginal $0 stands and nothing is invented.
      expect(u.planCostUsd).toBeNull()
      expect(u.actualUsd).toBe(0)

      expect((await put(h.app, '/api/settings/billing', { agent: 'claude-code', planUsdPerMonth: 30.4375 })).status).toBe(200)
      const month = await h.get('/api/agents?since=30d')
      const m = month.body.cost.perAgent.find((s: { agentId: string }) => s.agentId === 'claude-code')
      // $30.4375/month over a 30-day window is one month of the fee, to the cent.
      expect(m.planCostUsd).toBeCloseTo(30.4375 * (30 / (365.25 / 12)), 4)
      expect(m.actualUsd).toBeGreaterThan(0)
      // The fee is the plan's price, not a per-model one: adding a second model on the same
      // plan must not charge it twice.
      const doubled = await put(h.app, '/api/settings/billing', {
        agent: 'claude-code',
        model: 'anthropic/second-model',
        mode: 'subscription',
      })
      expect(doubled.status).toBe(200)
      const again = (await h.get('/api/agents?since=30d')).body.cost.perAgent.find(
        (s: { agentId: string }) => s.agentId === 'claude-code',
      )
      expect(again.planCostUsd).toBeCloseTo(m.planCostUsd, 10)
    } finally {
      h.close()
    }
  })

  it('refuses a fee that is not money, and keeps the declaration it would have replaced', async () => {
    const { h, dbPath } = billingHarness()
    try {
      await put(h.app, '/api/settings/billing', { agent: 'claude-code', mode: 'local' })
      const bad = await put(h.app, '/api/settings/billing', { agent: 'claude-code', planUsdPerMonth: -1 })
      expect(bad.status).toBe(400)
      expect(bad.body.error.message).toContain('non-negative')
      expect(JSON.parse(readFileSync(billingConfigPath(dbPath), 'utf8')).billing['claude-code']).toBe('local')
      // An unknown agent still cannot be declared into, fee included.
      const ghost = await put(h.app, '/api/settings/billing', { agent: 'nope', planUsdPerMonth: 5 })
      expect(ghost.status).toBe(404)
    } finally {
      h.close()
    }
  })
})
