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
import { billingConfigPath, liveBillingModes } from '@agentlens/pricing'
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
  const h = harness({ dbPath, billingModeFor: (agentId) => modes[agentId] ?? 'api' })
  return { h, dbPath, modes }
}

describe('GET /api/settings/billing', () => {
  it('lists every known agent with its declared mode, and defaults to api', async () => {
    const { h, dbPath } = billingHarness()
    try {
      writeFileSync(billingConfigPath(dbPath), JSON.stringify({ billing: { 'claude-code': 'subscription' } }), 'utf8')
      const res = await h.get('/api/settings/billing')
      expect(res.status).toBe(200)
      expect(res.body.modes).toEqual({ 'claude-code': 'subscription' })
      expect(res.body.agents).toEqual([
        { agentId: 'claude-code', displayName: 'Claude Code', billingMode: 'subscription', declared: true },
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
      expect(res.body).toEqual({ agent: 'claude-code', mode: 'local', modes: { 'claude-code': 'local' } })
      // The file the CLI reads, in the documented shape:
      expect(JSON.parse(readFileSync(billingConfigPath(dbPath), 'utf8'))).toEqual({ billing: { 'claude-code': 'local' } })
      // ...and the same view the cost routes fold through:
      expect(modes['claude-code']).toBe('local')
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
      expect(cleared.body).toEqual({ agent: 'claude-code', mode: 'api', modes: {} })
      expect(modes['claude-code']).toBeUndefined()
      const res = await h.get('/api/settings/billing')
      expect(res.body.agents[0]).toEqual({
        agentId: 'claude-code',
        displayName: 'Claude Code',
        billingMode: 'api',
        declared: false,
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
