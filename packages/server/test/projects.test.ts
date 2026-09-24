/**
 * GET /api/projects' own budget guard (§19). The Projects page reads `rows`, `truncated` and
 * `noteCode`; on the maintainer's 398k-event store each read that folds costs 0.2–2.3 s, so a
 * read that feeds nothing is a slower page for no fact at all. The route used to make four —
 * the fourth being a whole `costView` pass whose block no consumer rendered, `api.ts` carried
 * the field and the page never touched it. Three is what remains: the project rows, the
 * per-agent sub-rows and the model mix. (The capability mix asks `events` only, which needs
 * no stage 1 at all, so it is not counted here — as measured, not as assumed.)
 * The count is asserted rather than the timing because a count is what the code controls.
 */
import { describe, expect, it } from 'vitest'
import { foldPasses, resetFoldPasses } from '@agentlens/query'
import { harness } from './helpers.ts'

describe('GET /api/projects spends one read per grain (§19)', () => {
  it('makes three folding reads and ships no cost block the page cannot show', async () => {
    const h = harness({ homedir: '/home/tester' })
    try {
      resetFoldPasses()
      const { body } = await h.get('/api/projects')
      const p = foldPasses()
      expect(p.persisted + p.materialised + p.inline, `fold passes: ${JSON.stringify(p)}`).toBe(3)
      expect(body).not.toHaveProperty('cost')
      expect(body.rows.length).toBeGreaterThan(0)
      // The per-agent cost the expanded row shows still comes from the `sub` read, not a
      // second pass: that is why dropping the fifth read costs nothing.
      expect(body.rows[0].agents[0]).toHaveProperty('costApiEquiv')
      expect(body.totals).toBeTruthy()
    } finally {
      h.close()
    }
  })
})
