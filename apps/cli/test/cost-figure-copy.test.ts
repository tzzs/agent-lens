/**
 * §14: the CLI and the web must not disagree about what a cost number MEANS. The web's
 * `reported` basis tooltip used to enumerate which agents report a cost themselves —
 * "only OpenCode and WorkBuddy report it" — and the list went stale against the live
 * store (measured 2026-09-22, 372,447 events): the producers were OpenCode 487 rows
 * ($0.9584) and pi 160 rows ($0.1234), while WorkBuddy reported nothing at all.
 *
 * A producer list in copy is a fact about the data, and the data moves, so the sentence
 * has to state the RULE instead. This file's harness note: the root vitest config has no
 * svelte plugin (components are only compiled by `vite build`), so the copy is asserted
 * at its source — which is also the only way to keep it next to the cube's behaviour.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentlens/event-model'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { query } from '@agentlens/query'

const COMPONENT = fileURLToPath(new URL('../../web/src/components/CostFigure.svelte', import.meta.url))

/** The `reported:` arm of the component's `titles` map. */
function reportedCopy(): string {
  const line = readFileSync(COMPONENT, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('reported:'))
  expect(line, 'CostFigure.svelte must keep a single-line `reported:` title').toBeDefined()
  return line!
}

const tmp = mkdtempSync(join(tmpdir(), 'agentlens-cost-copy-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function ev(id: string, agentId: string, costReported: number | null): AgentEvent {
  return {
    schemaVersion: 1, id, agentId, hostId: agentId, sourceId: `src-${agentId}`,
    sessionId: `sess-${agentId}`, projectId: 'proj-synthetic',
    timestamp: Date.UTC(2026, 8, 20, 9), type: 'generation.end',
    usageSource: costReported === null ? 'missing' : 'reported',
    costReported, costSource: costReported === null ? 'none' : 'reported',
    status: 'ok', rawSeq: 1, rawOffset: 0, usage: null,
  } as unknown as AgentEvent
}

/** Which agents the store says reported their own cost — the cube answers, not the copy. */
function reporters(events: AgentEvent[]): Map<string, number> {
  const path = join(tmp, `r-${Math.random().toString(36).slice(2)}.db`)
  const db: DatabaseSync = openDatabase(path)
  migrate(db)
  insertEvents(db, events)
  const res = query(db, { metrics: ['cost_reported'], dims: ['agent'] })
  const out = new Map<string, number>()
  for (const r of res.rows) {
    const v = r.cost_reported
    if (v !== null && v !== undefined) out.set(String(r.agent), Number(v))
  }
  db.close()
  return out
}

describe('CostFigure "reported" basis copy (§18 row 1, §14)', () => {
  it('names no producer, because which agents report cost is a fact about the data', () => {
    const copy = reportedCopy()
    expect(copy).not.toMatch(/OpenCode|WorkBuddy|\bpi\b/i)
  })

  it('states the rule: an agent appears here only when its own log carries the figure', () => {
    const copy = reportedCopy()
    expect(copy.toLowerCase()).toContain('only')
    expect(copy).toMatch(/own (log|records)/i)
  })

  it('stays honest that everything else falls back to the computed price', () => {
    const copy = reportedCopy()
    expect(copy).toMatch(/computed|price table/i)
    // The §18 row-1 fusion reference belongs in the sentence, not in a stale list.
    expect(copy).toContain('§18 row 1')
  })

  it('tracks the producers when they change, which is exactly what the old list could not do', () => {
    // The store's real shape on the audited machine: opencode + pi report, workbuddy does not.
    const measured = reporters([
      ev('r1', 'opencode', 0.5), ev('r2', 'opencode', 0.4584),
      ev('r3', 'pi', 0.1234),
      ev('r4', 'workbuddy', null),
    ])
    expect([...measured.keys()].sort()).toEqual(['opencode', 'pi'])
    expect(measured.has('workbuddy')).toBe(false)

    // Next month a different adapter starts logging cost: the set moves, the copy stays true.
    const shifted = reporters([ev('s1', 'workbuddy', 1.25), ev('s2', 'claude-code', null)])
    expect([...shifted.keys()]).toEqual(['workbuddy'])

    const copy = reportedCopy()
    for (const agent of ['opencode', 'pi', 'workbuddy', 'claude-code']) {
      expect(new RegExp(`\\b${agent}\\b`, 'i').test(copy), `the copy must not hard-code ${agent} as a producer`).toBe(false)
    }
  })
})

/**
 * §8's other half: an unpriced bucket in the Overview cost trend was coerced to 0 to
 * satisfy the chart's `number[]`, which plots "we could not price this day" at exactly
 * the height of "this day cost nothing". Same component-level reasoning as above: no
 * svelte plugin in the root vitest config, so the rule is pinned where it is written.
 */
describe('the cost trend keeps unknown unknown (§8)', () => {
  const OVERVIEW = fileURLToPath(new URL('../../web/src/pages/Overview.svelte', import.meta.url))
  const SPARKLINE = fileURLToPath(new URL('../../web/src/components/charts/Sparkline.svelte', import.meta.url))

  it('maps a null cost to null, not to 0', () => {
    const line = readFileSync(OVERVIEW, 'utf8')
      .split('\n')
      .find((l) => l.includes('const costSeries'))
    expect(line, 'Overview.svelte must keep a single-line costSeries').toBeDefined()
    expect(line).toContain('null : Number(r.cost_api_equiv)')
    expect(line).not.toContain('? 0 :')
  })

  it('takes nulls in its series type so a gap is expressible', () => {
    const src = readFileSync(SPARKLINE, 'utf8')
    expect(src).toContain('values?: (number | null)[]')
    // The peak must be computed over known buckets only, or one big priced day is fine
    // while an all-unknown window reads as a flat zero line.
    expect(src).toContain('const priced = $derived(values.filter((v): v is number => v !== null))')
    expect(src).toContain('Math.max(0, ...priced)')
  })
})
