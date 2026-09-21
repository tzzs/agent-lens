/**
 * §19 ("8 Cost Engine 的一处数据修正"): the generated price snapshot sets
 * `effective_from` to epoch so any historical window has a price — the price of that
 * is that TODAY's rate is applied retroactively, and the plan requires BOTH surfaces
 * that explain a number to say so out loud: `doctor` (§11) and `--explain` (§9).
 *
 * `doctor` already prints it (`apps/cli/src/commands/doctor.ts:renderPricing`); these
 * tests pin the phrase shared by the two, so an explanation can never again present a
 * $ total as if it were the price actually paid.
 */
import { describe, expect, it } from 'vitest'
import { describeQuery, type QuerySpec } from '@agentlens/query'

/** The exact clause doctor.ts prints — `--explain` must carry the same words. */
const RETROACTIVE = "today's price would have cost, not what was paid (§8)"

const SPECS: [string, QuerySpec][] = [
  ['bare usage (no filter, no limit)', { metrics: ['events', 'cost_total'], dims: ['model'] }],
  ['server usage route shape', { metrics: ['tokens_total'], dims: ['day'], filter: { since: '30d' }, order: 'metric:tokens_total:desc', limit: 30 }],
  ['the aggregate the sessions list asks for', { metrics: ['events', 'cost_api_equiv'], dims: ['session'] }],
]

describe('describeQuery (§7 basis, §19 retroactive prices)', () => {
  it('states that undated prices are applied retroactively to history', () => {
    const text = describeQuery({ metrics: ['cost_api_equiv'], dims: ['model'] })
    expect(text).toContain('effective_from 0')
    expect(text).toContain('the current rate is applied')
    expect(text).toContain(RETROACTIVE)
  })

  it('names the way out, the same way doctor does', () => {
    const text = describeQuery({ metrics: ['cost_api_equiv'], dims: ['model'] })
    expect(text).toContain('`agl pricing update`')
    expect(text).toContain('`agl pricing override`')
  })

  it('says it for every spec, whichever metrics or dims the caller resolved', () => {
    for (const [label, spec] of SPECS) {
      const text = describeQuery(spec)
      expect(text, label).toContain(RETROACTIVE)
      // The existing §18 basis statement must survive: one explanation, not two.
      expect(text, label).toContain('aggregation policy')
    }
  })
})
