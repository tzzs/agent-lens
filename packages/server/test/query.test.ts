/**
 * The §7 contract, tested from the HTTP side: every number the Web sees must be
 * the number `query()` returns for the same spec, because that is the only thing
 * keeping `agl usage` and the dashboard from drifting apart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '@agentlens/query'
import { harness } from './helpers.ts'

describe('GET /api/query is a thin wrapper over query()', () => {
  let h: ReturnType<typeof harness>
  beforeAll(() => {
    h = harness()
  })
  afterAll(() => {
    h.close()
  })
  {
    const cases: [string, Parameters<typeof query>[1]][] = [
      ['agent', { dims: ['agent'], metrics: ['events', 'sessions', 'tokens_total', 'cost_api_equiv'] }],
      ['project+model', { dims: ['project', 'model'], metrics: ['tokens_input', 'tokens_output', 'events'] }],
      ['day trend', { dims: ['day'], metrics: ['events', 'tokens_total'], order: 'dim:day:asc', limit: 400 }],
      ['filtered', { dims: ['host'], metrics: ['events'], filter: { agent: ['claude-code'], since: '30d' } }],
      ['no dims', { metrics: ['tokens_total', 'duration'] }],
    ]

    for (const [label, spec] of cases) {
      it(`returns byte-identical rows/totals for the ${label} shape`, async () => {
        const params = new URLSearchParams()
        if (spec.metrics) params.set('metrics', spec.metrics.join(','))
        if (spec.dims) params.set('dims', spec.dims.join(','))
        if (spec.order) params.set('order', spec.order)
        if (spec.limit !== undefined) params.set('limit', String(spec.limit))
        if (spec.filter?.since) params.set('since', String(spec.filter.since))
        if (spec.filter?.agent) params.set('agent', spec.filter.agent.join(','))

        const res = await h.get(`/api/query?${params.toString()}`)
        expect(res.status).toBe(200)
        const direct = query(h.seeded.db, spec, h.ctx.cubeDeps)
        expect(res.body.rows).toEqual(direct.rows)
        expect(res.body.totals).toEqual(direct.totals)
        expect(res.body.columns).toEqual(direct.columns)
        expect(res.body.truncated).toBe(direct.truncated)
        // The explain line rides along so the UI can show its own basis (§14).
        expect(String(res.body.explain)).toContain('aggregation policy')
      })
    }

    it('folds duplicated usage to the per-request MAX, exactly like the cube', async () => {
      const res = await h.get('/api/query?metrics=tokens_total,tokens_input,tokens_output')
      // e2/e3 share request id req-1 (1000+200 each) and f1 is req-2 (500+50).
      // A naive per-event sum would report 2500 input / 450 output.
      expect(res.body.totals.tokens_input).toBe(1500)
      expect(res.body.totals.tokens_output).toBe(250)
      expect(res.body.totals.tokens_total).toBe(1750)
      const direct = query(h.seeded.db, { metrics: ['tokens_total'] }, h.ctx.cubeDeps)
      expect(res.body.totals.tokens_total).toBe(direct.totals.tokens_total)
    })

    it('exposes cost_total as the §18 row 1 fused metric, identical to the cube', async () => {
      const res = await h.get('/api/query?metrics=cost_total')
      expect(res.status).toBe(200)
      const direct = query(h.seeded.db, { metrics: ['cost_total'] }, h.ctx.cubeDeps)
      // The fixture reports no cost, so the fusion degrades to the priced figure —
      // and the unpriced f1 row still drags it to NULL, never to a floor.
      expect(res.body.totals.cost_total).toBeNull()
      expect(res.body.totals.cost_total).toEqual(direct.totals.cost_total)
    })

    it('subagents=exclude/false reaches the cube filter; the wire default stays include', async () => {
      const ex = await h.get('/api/query?metrics=events&subagents=exclude')
      expect(ex.status).toBe(200)
      expect(ex.body.spec.filter.includeSubagentThreads).toBe(false)
      const off = await h.get('/api/query?metrics=events&subagents=include')
      expect(off.body.spec.filter.includeSubagentThreads).toBe(true)
      // The fixture carries no flagged rows, so every reading sees the same number.
      expect(ex.body.totals).toEqual(off.body.totals)
      expect(off.body.totals).toEqual((await h.get('/api/query?metrics=events')).body.totals)
    })

    it('resolves a human agent name to the opaque id the cube filters on', async () => {
      const res = await h.get('/api/query?dims=agent&metrics=events&agent=Claude%20Code')
      expect(res.status).toBe(200)
      expect(res.body.rows).toHaveLength(1)
      expect(String(res.body.rows[0].agent)).toBe('claude-code')
    })
  }
})

describe('request validation', () => {
  let h: ReturnType<typeof harness>
  beforeAll(() => {
    h = harness()
  })
  afterAll(() => {
    h.close()
  })
  {
    const bad: [string, string][] = [
      ['unknown metric', '/api/query?metrics=tokens_made_up'],
      ['unknown dim', '/api/query?dims=galaxy'],
      ['bad since', '/api/query?since=yesterday-ish'],
      ['bad order', '/api/query?order=something'],
      ['bad limit', '/api/query?limit=-3'],
      ['empty metrics', '/api/query?metrics='],
      ['duplicate dims', '/api/query?dims=agent,agent'],
      ['bad subagents', '/api/query?subagents=sometimes'],
    ]
    for (const [label, path] of bad) {
      it(`answers a structured 400 for ${label}`, async () => {
        const res = await h.get(path)
        expect(res.status).toBe(400)
        expect(res.body.error.kind).toBe('bad_request')
        expect(typeof res.body.error.message).toBe('string')
      })
    }

    it('names the allowed vocabulary in the error details', async () => {
      const res = await h.get('/api/query?metrics=nope')
      expect(res.body.error.details.requested).toBe('nope')
      expect(res.body.error.details.allowed).toContain('tokens_total')
    })

    it('404s an unknown API route as JSON, not as the SPA shell', async () => {
      const res = await h.get('/api/does-not-exist')
      expect(res.status).toBe(404)
      expect(res.body.error.kind).toBe('not_found')
    })

    it('404s an unknown session and 409s an ambiguous prefix', async () => {
      const missing = await h.get('/api/sessions/zzz-nope')
      expect(missing.status).toBe(404)
      expect(missing.body.error.kind).toBe('not_found')
      const ambiguous = await h.get('/api/sessions/sess-')
      expect(ambiguous.status).toBe(409)
      expect(ambiguous.body.error.kind).toBe('conflict')
      expect(ambiguous.body.error.details.matches).toHaveLength(2)
    })

    it('501s POST /api/scan when no scanner was injected', async () => {
      const res = await h.post('/api/scan')
      expect(res.status).toBe(501)
      expect(res.body.error.kind).toBe('not_implemented')
    })
  }
})

describe('dependency injection points', () => {
  it('answers POST /api/scan through the injected closure only', async () => {
    let calls = 0
    const h = harness({
      scan: async () => {
        calls += 1
        return { adaptersFound: 2, sourcesScanned: 3, events: 11, failures: 0, notDetected: ['codex'] }
      },
    })
    try {
      const res = await h.post('/api/scan')
      expect(res.status).toBe(200)
      expect(res.body.summary.events).toBe(11)
      expect(calls).toBe(1)
    } finally {
      h.close()
    }
  })

  it('reports health without touching the network', async () => {
    const h = harness()
    try {
      const res = await h.get('/api/health')
      expect(res.status).toBe(200)
      expect(res.body.events).toBe(11)
      expect(res.body.sessions).toBe(2)
      expect(res.body.loopbackOnly).toBe(true)
      expect(res.body.contentAvailable).toBe(false)
    } finally {
      h.close()
    }
  })
})
