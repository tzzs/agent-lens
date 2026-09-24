/**
 * The dashboard's read budget, as a number rather than a feeling (§19).
 *
 * Every route below is measured twice over: how many stage-2 reads it asks the cube for, and
 * how many of those carry a priced bucket pass (the extra grouping §8 needs to price each
 * model's tokens at its own day). Those two counts are what a page's latency is made of on a
 * store this size — one priced pass measured 0.5–1.2 s where a plain read costs 50 ms — so a
 * route that grows one has to say why here.
 *
 * The counts are asserted, not printed, because a number nobody has to defend drifts. They
 * were re-measured after the totals stopped re-pricing the buckets the rows already had
 * (`projects` 3 → 2, `agents` 7 → 6, `models` 6 → 5, `sessions` 2 → 1): a call that asks for
 * rows AND totals now prices once, while a call that asks only rows always did.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { foldPasses, resetFoldPasses } from '@agentlens/query'
import { harness } from './helpers.ts'

const CASES: [string, number, number][] = [
  // route, stage-2 reads, priced bucket passes
  ['/api/overview?since=30d', 9, 8],
  ['/api/projects?since=30d', 3, 2],
  ['/api/agents?since=30d', 4, 6],
  ['/api/models?since=30d', 3, 5],
  ['/api/sessions?since=30d', 1, 1],
  ['/api/capabilities?since=30d', 2, 2],
]

let h: ReturnType<typeof harness> | null = null

describe('each route pays for the reads it actually needs (§19 budget)', () => {
  afterEach(() => {
    h?.close()
    h = null
  })

  for (const [route, reads, buckets] of CASES) {
    it(`${route}: ${reads} reads, ${buckets} priced passes`, async () => {
      h = harness({ homedir: '/home/tester' })
      resetFoldPasses()
      const { status } = await h.get(route)
      expect(status).toBe(200)
      const p = foldPasses()
      expect(p.persisted + p.materialised + p.inline, `reads for ${route}`).toBe(reads)
      expect(p.costBuckets, `priced passes for ${route}`).toBe(buckets)
    })
  }
})
