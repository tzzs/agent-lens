/**
 * §4.1 identity rules and §4.2 replay determinism for the Pi trace source: the same
 * bytes must produce the same events, byte for byte, however many times they are
 * scanned — that is what makes `INSERT OR IGNORE` idempotent downstream.
 */
import { deepStrictEqual } from 'node:assert'
import { describe, expect, it } from 'vitest'
import { deriveSessionId, deriveSessionIdFromSource } from '@agentlens/event-model'
import { HOST_PI, PI_AGGREGATION, piAdapter } from '../src/index.ts'
import { UNATTRIBUTED_PROJECT_ID } from '../src/normalize.ts'
import {
  FIXED_NOW,
  NO_HEADER_HINT,
  SCENARIOS,
  ctxFor,
  eventsOf,
  readFixture,
  recordsFromJsonl,
  resetStateFor,
} from './helpers.ts'

const HEADER_AA = '9e1c0000-0000-4000-8000-0000000000aa'

describe('identity (§4.1)', () => {
  it('hostId and agentId are the single measured surface', async () => {
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) {
        expect(e.hostId, `${name} invented a host`).toBe(HOST_PI)
        expect(e.agentId).toBe('pi')
      }
    }
  })

  it('the session header names the session for every later record in the file', async () => {
    const events = await eventsOf('session-trace.jsonl')
    const native = deriveSessionId('pi', HEADER_AA)
    expect(events.every((e) => e.sessionId === native)).toBe(true)
  })

  it('a headerless file falls back to the filename hint, flagged as a diagnostic', async () => {
    const events = await eventsOf('no-header-trace.jsonl', NO_HEADER_HINT)
    const hinted = deriveSessionId('pi', NO_HEADER_HINT)
    expect(events.every((e) => e.sessionId === hinted)).toBe(true)
    for (const e of events) expect(e.metadata?.diagnostics).toContain('session-header-absent')
  })

  it('with neither header nor hint the session id derives from the record, per §4.1', async () => {
    const ctx = ctxFor('no-header-trace.jsonl')
    const events = await eventsOf('no-header-trace.jsonl')
    expect(events[0]!.sessionId).toBe(deriveSessionIdFromSource(ctx.source.id, 'nh1'))
    for (const e of events) expect(e.metadata?.diagnostics).toContain('session-id-derived-from-record')
  })

  it('the project comes from the header cwd only; a headerless file reports unattributed', async () => {
    const events = await eventsOf('session-trace.jsonl')
    expect(events.every((e) => e.projectId === 'project:alpha')).toBe(true)
    expect(events.every((e) => e.metadata?.project_source === undefined)).toBe(true)
    const lost = await eventsOf('no-header-trace.jsonl')
    expect(lost.every((e) => e.projectId === UNATTRIBUTED_PROJECT_ID)).toBe(true)
    expect(lost.every((e) => e.metadata?.project_source === 'unattributed')).toBe(true)
  })

  it('requestId rides the native responseId, and only the usage row', async () => {
    const events = await eventsOf('session-trace.jsonl')
    const usage = events.filter((e) => e.usage)
    expect(usage.map((e) => e.requestId)).toEqual(['resp-01', 'resp-02'])
    expect(events.filter((e) => !e.usage).every((e) => e.requestId === null)).toBe(true)
  })

  it('every timestamp form resolves to ms epoch', async () => {
    const events = await eventsOf('timestamp-forms.jsonl')
    expect(events.map((e) => e.timestamp)).toEqual([
      Date.parse('2026-09-20T15:00:01.000Z'),
      1789000000000,
      1789000001000,
      FIXED_NOW, // no timestamp ⇒ the record's occurredAt / the ctx clock
    ])
  })
})

describe('replay determinism (§4.2)', () => {
  it('a full rescan reproduces the identical event set, ids included', async () => {
    for (const name of SCENARIOS) {
      const first = await eventsOf(name)
      const second = await eventsOf(name)
      deepStrictEqual(second, first)
      expect(first.length).toBeGreaterThan(0)
    }
  })

  it('a seq restart rebuilds the state: the replay matches the first pass exactly', async () => {
    const ctx = ctxFor('session-trace.jsonl')
    resetStateFor(ctx)
    const records = recordsFromJsonl(await readFixture('session-trace.jsonl'))
    const pass = async () => {
      const out: string[] = []
      for (const record of records) {
        const r = await piAdapter.normalize(record, ctx)
        if ('events' in r) out.push(...r.events.map((e) => `${e.id}:${e.sessionId}:${e.type}`))
      }
      return out
    }
    const first = await pass()
    const replay = await pass() // same ctx, seq restarts at 1 — the header must re-land
    deepStrictEqual(replay, first)
  })

  it('state cannot leak across sources', async () => {
    const traced = await eventsOf('session-trace.jsonl')
    const errored = await eventsOf('error-result.jsonl')
    // `call-01` is only known inside its own source; the other file's result stays unlinked.
    expect(traced.find((e) => e.type === 'tool.result')?.metadata?.unlinked_result).toBeUndefined()
    expect(errored.find((e) => e.type === 'tool.result')?.metadata?.unlinked_result).toBe(true)
  })
})

describe('adapter surface', () => {
  it('declares an aggregation policy, a capability catalog and no write path (§5.2 rule 2)', () => {
    expect(piAdapter.aggregation).toEqual(PI_AGGREGATION)
    expect(Object.keys(piAdapter).sort()).toEqual([
      'aggregation',
      'capabilities',
      'detect',
      'discover',
      'displayName',
      'id',
      'normalize',
      'parse',
      'parserVersion',
    ])
  })
})
