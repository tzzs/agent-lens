/**
 * GET /api/models, the price-gap surface (§8, §11): `rows[].priced` and the
 * `unpriced` list are two views of the same gap set, so they must never
 * contradict each other — the response would otherwise tell the UI that a model
 * both has and has no price.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './helpers.ts'

/** The fixture's own gap set: one priced model, one unpriced one. */
const PRICED = { provider: 'anthropic', model: 'test-model' }
const UNPRICED = { provider: 'anthropic', model: 'unpriced-model' }

const rowFor = (rows: any[], provider: string, model: string) =>
  rows.find((r) => r.provider === provider && r.model === model)

describe('GET /api/models prices each row exactly like the unpriced list', () => {
  let h: ReturnType<typeof harness>
  beforeAll(() => {
    h = harness()
  })
  afterAll(() => {
    h.close()
  })

  it('flags the unpriced model false and the priced one true', async () => {
    const res = await h.get('/api/models')
    expect(res.status).toBe(200)
    expect(res.body.pricingConfigured).toBe(true)

    expect(rowFor(res.body.rows, PRICED.provider, PRICED.model).priced).toBe(true)
    expect(rowFor(res.body.rows, UNPRICED.provider, UNPRICED.model).priced).toBe(false)
    expect(res.body.unpriced).toEqual([expect.objectContaining(UNPRICED)])
  })

  it('never lists a row as priced that `unpriced` names, or the other way round', async () => {
    const res = await h.get('/api/models')
    const isGap = (r: any) => res.body.unpriced.some((u: any) => u.provider === r.provider && u.model === r.model)
    const modelled = res.body.rows.filter((r: any) => r.model)
    expect(modelled.length).toBeGreaterThan(1)
    for (const r of modelled) {
      expect(r.priced, `row ${r.provider}/${r.model} disagrees with the unpriced list`).toBe(!isGap(r))
    }
  })

  it('reports priced as null, not false, when no price table is configured', async () => {
    const unconfigured = harness({ priceResolver: undefined })
    try {
      const res = await unconfigured.get('/api/models')
      expect(res.body.pricingConfigured).toBe(false)
      expect(res.body.unpriced).toEqual([])
      for (const r of res.body.rows) expect(r.priced).toBeNull()
    } finally {
      unconfigured.close()
    }
  })
})
