/**
 * §4.1 identity rules and §4.2 replay determinism for the WorkBuddy trace source:
 * the same bytes must produce the same events, byte for byte, however many times they
 * are scanned — that is what makes `INSERT OR IGNORE` idempotent downstream.
 */
import { deepStrictEqual } from 'node:assert'
import { describe, expect, it } from 'vitest'
import { deriveSessionId, deriveSessionIdFromSource } from '@agentlens/event-model'
import { HOST_WORKBUDDY, WORKBUDDY_AGGREGATION, workbuddyAdapter } from '../src/index.ts'
import { UNATTRIBUTED_PROJECT_ID } from '../src/normalize.ts'
import {
  SCENARIOS,
  ctxFor,
  eventsOf,
  readFixture,
  recordsFromJsonl,
  resetStateFor,
} from './helpers.ts'

describe('identity (§4.1)', () => {
  it('hostId is the single measured surface and the CodeBuddy marker stays metadata', async () => {
    for (const name of SCENARIOS) {
      for (const e of await eventsOf(name)) {
        expect(e.hostId, `${name} invented a host`).toBe(HOST_WORKBUDDY)
        expect(e.agentId).toBe('workbuddy')
      }
    }
    const marked = await eventsOf('tool-trace.jsonl')
    for (const e of marked) expect(e.metadata?.codebuddy_local).toBe(true)
    const unmarked = (await eventsOf('no-session-trace.jsonl')).filter((e) => e.rawSeq === 1)
    expect(unmarked[0]?.metadata?.codebuddy_local).toBeUndefined()
    expect(unmarked[0]?.metadata?.diagnostics).toContain('codebuddy-local-marker-absent')
  })

  it('a native sessionId wins; a sessionless record inherits the trace session', async () => {
    const events = await eventsOf('no-session-trace.jsonl')
    const native = deriveSessionId('workbuddy', 'wb-sess-n')
    expect(events.find((e) => e.rawSeq === 2)?.sessionId).toBe(native)
    expect(events.find((e) => e.rawSeq === 3)?.sessionId).toBe(native)
    // Record 1 precedes any native id, so it falls to the source-derived key (§4.1 tier 2).
    expect(events.find((e) => e.rawSeq === 1)?.sessionId).toBe(
      deriveSessionIdFromSource(ctxFor('no-session-trace.jsonl').source.id, 'n1'),
    )
  })

  it('the project comes from cwd, is inherited per session, and is never taken from the DB', async () => {
    const events = await eventsOf('no-session-trace.jsonl')
    expect(events.find((e) => e.rawSeq === 1)?.projectId).toBe(UNATTRIBUTED_PROJECT_ID)
    expect(events.find((e) => e.rawSeq === 1)?.metadata?.project_source).toBe('unattributed')
    const deep = events.find((e) => e.rawSeq === 2)
    expect(deep?.projectId).toBe('project:deep')
    const inherited = events.find((e) => e.rawSeq === 3)
    expect(inherited?.projectId).toBe('project:deep')
    expect(inherited?.metadata?.project_source).toBe('session')
    // Unattributed is reported, not guessed: no event borrows another session's project.
    const unattributed = await eventsOf('tool-trace.jsonl')
    expect(unattributed.every((e) => e.projectId === 'project:alpha')).toBe(true)
  })

  it('requestId is the provider id when present, else a per-record key', async () => {
    const shared = await eventsOf('shared-usage.jsonl')
    const usage = shared.filter((e) => e.usage)
    expect(usage).toHaveLength(2)
    for (const e of usage) expect(e.requestId).toBe('req-wb-b1')
    const single = (await eventsOf('tool-trace.jsonl')).find((e) => e.usage)
    expect(single?.requestId).toBe('req-wb-a1')
    expect((await eventsOf('error-result.jsonl')).find((e) => e.usage)).toBeUndefined()
  })

  it('every timestamp form resolves to ms epoch', async () => {
    const events = await eventsOf('timestamp-forms.jsonl')
    expect(events.map((e) => e.timestamp)).toEqual([
      Date.parse('2026-09-20T15:00:01.000Z'),
      1789000000 * 1000,
      1789000001000,
      1_760_000_000_000, // no timestamp ⇒ the record's occurredAt / the ctx clock
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

  it('state rebuilt mid-scan cannot leak across sources', async () => {
    const shared = await eventsOf('shared-usage.jsonl')
    const errored = await eventsOf('error-result.jsonl')
    // `call-x` is only known inside its own source: the other file's results stay unlinked.
    expect(errored.find((e) => e.type === 'tool.result')?.metadata?.unlinked_result).toBeUndefined()
    expect(shared.find((e) => e.type === 'tool.result')?.parentEventId).toBe(
      shared.find((e) => e.type === 'tool.start')?.id,
    )
  })

  it('records are consumed in seq order and offsets survive a resume', async () => {
    const ctx = ctxFor('tool-trace.jsonl')
    resetStateFor(ctx)
    const records = recordsFromJsonl(await readFixture('tool-trace.jsonl'))
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(records[3]!.offset).toBeGreaterThan(records[2]!.offset)
  })
})

describe('adapter surface', () => {
  it('declares an aggregation policy and exposes no write path (§5.2 rule 2)', () => {
    expect(workbuddyAdapter.aggregation).toEqual(WORKBUDDY_AGGREGATION)
    expect(Object.keys(workbuddyAdapter).sort()).toEqual([
      'aggregation',
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
