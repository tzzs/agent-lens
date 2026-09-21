/**
 * The capability-name dims (`tool`, `skill`, `mcp`, …) are CASE expressions in the
 * cube: `CASE WHEN e.capability_type = 'skill' THEN COALESCE(e.capability_name,'')
 * ELSE '' END` (packages/query engine). An event of any other kind therefore
 * contributes `''`, and a query that asks for `dims=skill` without also filtering
 * `capabilityType=skill` counts the entire event store as one unnamed skill — the
 * bug `agl skills` shipped with on a 329k-event DB.
 *
 * This is the web half of that contract, driven end to end: the params the Usage
 * explorer builds, the URL those params produce, the spec the server parses out of
 * it, and the rows the page then renders. The synthetic fixture below deliberately
 * holds two capability kinds plus one capability-free event, so a collapse into the
 * `''` bucket is visible as a wrong number rather than a plausible one.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from '@agentlens/server'
import { insertEvents, migrate, openDatabase } from '@agentlens/storage'
import { query } from '@agentlens/query'
import type { AgentEvent } from '@agentlens/event-model'
import {
  CAPABILITY_TYPES,
  UNNAMED_CAPABILITY,
  buildURL,
  capabilityDimCell,
  isCapabilityNameDim,
  withCapabilityType,
} from '../src/lib/api.ts'

/** Inside every default window (the overview route applies a 30d default). */
const TS = Date.now() - 3_600_000

function ev(id: string, over: Partial<AgentEvent>): AgentEvent {
  return {
    id,
    schemaVersion: 1,
    agentId: 'agent-a',
    hostId: 'host-a',
    sourceId: 'src-a',
    sessionId: 'sess-a',
    projectId: 'proj-a',
    timestamp: TS,
    type: 'generation.end',
    usageSource: 'missing',
    status: 'ok',
    rawSeq: 1,
    rawOffset: 0,
    ...over,
  } as AgentEvent
}

/** 3 skill invocations + 2 tool events + 1 event with no capability at all = 6. */
function fixture(): AgentEvent[] {
  return [
    ev('s1', { rawSeq: 1, type: 'skill.invoke', capability: { type: 'skill', name: 'pdf-tools' } }),
    ev('s2', { rawSeq: 2, type: 'skill.invoke', capability: { type: 'skill', name: 'pdf-tools' } }),
    ev('s3', { rawSeq: 3, type: 'skill.invoke', capability: { type: 'skill', name: 'pdf-tools' }, status: 'error' }),
    ev('t1', { rawSeq: 4, type: 'tool.start', capability: { type: 'tool', name: 'Bash' } }),
    ev('t2', { rawSeq: 5, type: 'tool.end', capability: { type: 'tool', name: 'Bash' }, durationMs: 500 }),
    ev('g1', { rawSeq: 6, type: 'generation.end' }),
  ]
}

interface Seeded {
  db: DatabaseSync
  get(path: string): Promise<{ status: number; body: any }>
}

function seeded(): Seeded {
  const db = openDatabase(':memory:')
  migrate(db)
  insertEvents(db, fixture(), { contentEnabled: false })
  const app = createApp({ db, now: () => TS, homedir: '/nonexistent-test-home' })
  return {
    db,
    async get(path) {
      const res = await app.request(path)
      return { status: res.status, body: await res.json() }
    },
  }
}

describe('withCapabilityType — the params every web capability query needs', () => {
  it('restricts each capability-name dim to its own type', () => {
    for (const dim of CAPABILITY_TYPES) {
      expect(withCapabilityType([dim], { dims: dim, metrics: 'events' })).toMatchObject({
        dims: dim,
        capabilityType: [dim],
      })
    }
  })

  it('unions several selected kinds and leaves every other dim alone', () => {
    expect(withCapabilityType(['tool', 'skill', 'agent'], { dims: 'tool,skill,agent' }).capabilityType).toEqual(['tool', 'skill'])
    const plain = { dims: 'agent,day', metrics: 'events' }
    expect(withCapabilityType(['agent', 'day'], plain)).toBe(plain)
    // `capability_type` is a type dim, not a name dim: it never collapses kinds.
    expect(isCapabilityNameDim('capability_type')).toBe(false)
    expect(isCapabilityNameDim('capability_name')).toBe(false)
    expect(withCapabilityType(['capability_type', 'model'], { dims: 'capability_type' }).capabilityType).toBeUndefined()
  })

  it('intersects a caller-set type filter and never widens it', () => {
    expect(withCapabilityType(['skill'], { capabilityType: ['skill', 'tool'] }).capabilityType).toEqual(['skill'])
    // Contradiction: no event is both a tool row and a skill-named row. Empty here
    // means "nothing can match" — the explorer says so instead of dropping the
    // filter, because buildURL omits empty lists and an omitted filter is the bug.
    const contradicted = withCapabilityType(['skill'], { capabilityType: ['tool'] })
    expect(contradicted.capabilityType).toEqual([])
    expect(buildURL('/api/query', contradicted)).toBe('/api/query')
  })

  it('labels an unnamed capability cell instead of leaving it blank', () => {
    expect(capabilityDimCell('skill', '', ['skill'])).toBe(UNNAMED_CAPABILITY)
    expect(capabilityDimCell('skill', '', ['tool', 'skill'])).toBe('(unnamed or other kind)')
    expect(capabilityDimCell('skill', 'pdf-tools', ['skill'])).toBe('pdf-tools')
    expect(capabilityDimCell('agent', '', ['agent'])).toBe('')
  })
})

describe('GET /api/query for one capability kind counts only that kind', () => {
  it('the skills URL the Usage explorer builds returns the 3 skill events, not all 6', async () => {
    const h = seeded()
    const params = withCapabilityType(['skill'], {
      metrics: 'events,duration',
      dims: 'skill',
      since: '30d',
      order: 'metric:events:desc',
      limit: 50,
    })
    const res = await h.get(buildURL('/api/query', params))
    expect(res.status).toBe(200)
    expect(res.body.spec.filter.capabilityType).toEqual(['skill'])
    expect(res.body.rows).toEqual([{ skill: 'pdf-tools', events: 3, duration: 0 }])
    expect(res.body.totals.events).toBe(3)
    // Same figure straight from the cube, and the same as `agl skills` must print.
    const direct = query(h.db, { metrics: ['events'], dims: ['skill'], filter: { capabilityType: ['skill'] } })
    expect(res.body.rows.map((r: any) => Number(r.events))).toEqual(direct.rows.map((r) => Number(r.events)))
  })

  it('a dim without the type restriction is the collapse this guards against', async () => {
    const h = seeded()
    const buckets = async (dim: string): Promise<[string, number][]> => {
      const res = await h.get(`/api/query?metrics=events&dims=${dim}&since=30d`)
      expect(res.body.totals.events).toBe(6) // the query sees the whole store
      return res.body.rows.map((r: any) => [String(r[dim]), Number(r.events)]).sort()
    }
    // No `capabilityType`: the tool events and the capability-free event all land in
    // one unnamed skill row. On a real store that bucket is ~the whole DB (the
    // 329k-event version of this read "329,131 skill invocations").
    await expect(buckets('skill')).resolves.toEqual([
      ['', 3],
      ['pdf-tools', 3],
    ])
    await expect(buckets('tool')).resolves.toEqual([
      ['', 4],
      ['Bash', 2],
    ])
  })

  it('the tools view stays out of the skills numbers and vice versa', async () => {
    const h = seeded()
    const tools = await h.get(buildURL('/api/query', withCapabilityType(['tool'], { metrics: 'events', dims: 'tool', since: '30d' })))
    expect(tools.body.rows).toEqual([{ tool: 'Bash', events: 2 }])
    const skills = await h.get(buildURL('/api/query', withCapabilityType(['skill'], { metrics: 'events', dims: 'skill', since: '30d' })))
    expect(skills.body.rows).toEqual([{ skill: 'pdf-tools', events: 3 }])
    // Both kinds selected at once: the union filter still excludes the event with no
    // capability, so the pair of buckets sums to 5, never to 6.
    const both = await h.get(
      buildURL('/api/query', withCapabilityType(['tool', 'skill'], { metrics: 'events', dims: 'tool,skill', since: '30d' })),
    )
    expect(both.body.totals.events).toBe(5)
    expect(both.body.rows.map((r: any) => [String(r.tool), String(r.skill)]).sort()).toEqual([
      ['', 'pdf-tools'],
      ['Bash', ''],
    ])
    expect(both.body.rows.map((r: any) => capabilityDimCell('skill', r.skill, ['tool', 'skill']))).toContain('(unnamed or other kind)')
  })
})

describe('the fixed server routes the dashboard reads', () => {
  it('/api/overview activity counts each capability type, never the unnamed bucket', async () => {
    const h = seeded()
    const res = await h.get('/api/overview')
    expect(res.status).toBe(200)
    expect(res.body.activity.skill).toBe(3)
    expect(res.body.activity.tool).toBe(2)
    for (const t of CAPABILITY_TYPES.filter((x) => x !== 'skill' && x !== 'tool')) {
      expect(res.body.activity[t]).toBe(0)
    }
    // No capability row may carry the '' type: that row is "everything else".
    expect(res.body.capabilities.map((r: any) => String(r.capability_type))).not.toContain('')
    expect(res.body.capabilities.reduce((a: number, r: any) => a + Number(r.events), 0)).toBe(5)
  })

  it('/api/capabilities lists skill names inside the skill type only', async () => {
    const h = seeded()
    const res = await h.get('/api/capabilities?since=30d&names=15')
    expect(res.status).toBe(200)
    const byType = new Map(res.body.types.map((t: any) => [t.type, t]))
    expect([...byType.keys()]).toEqual(expect.arrayContaining(['skill', 'tool']))
    expect([...byType.keys()].length).toBe(2)
    expect(byType.get('skill').events).toBe(3)
    expect(byType.get('skill').errors).toBe(1)
    expect(byType.get('skill').names).toEqual([
      { name: 'pdf-tools', events: 3, durationMs: 0, tokensTotal: 0, costApiEquiv: null, errors: 1 },
    ])
    expect(byType.get('tool').events).toBe(2)
    for (const t of byType.values()) {
      for (const n of t.names) expect(String(n.name)).not.toBe('')
    }
  })
})
