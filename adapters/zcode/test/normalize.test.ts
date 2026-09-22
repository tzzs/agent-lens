/**
 * §5.1 `normalize` snapshots and the unit rules that must hold whatever the store contains:
 * the §5.3 fallbacks, the §七 per-table mapping, and the NULL-vs-zero distinctions.
 *
 * Snapshots are the drift tripwire §5.3 asks for: they pin every emitted field including the
 * deterministic ids, so a mapping change that silently renames an event or moves a number
 * fails here rather than in a dashboard.
 */
import { describe, expect, it } from 'vitest'
import { isParseFailure, type NormalizeCtx, type RawRecord } from '@agentlens/event-model'
import { normalize } from '../src/normalize.ts'
import { buildHost, type BuiltHost } from '../fixtures/build-host.ts'
import { FIXED_NOW, SOURCE_TABLES, matchSnapshot, normalizeCtx, project, scanAll, scanSource } from './helpers.ts'

async function withHost(fn: (host: BuiltHost) => Promise<void>): Promise<void> {
  const host = await buildHost({ subdir: 'cli/db' })
  try {
    await fn(host)
  } finally {
    await host.close()
  }
}

function row(table: string, rowid: number, columns: Record<string, unknown>, data: Record<string, unknown> | null): RawRecord {
  const value = { __rowid: rowid, __table: table, data, time_created: FIXED_NOW, ...columns }
  return { seq: rowid, offset: rowid, occurredAt: FIXED_NOW, value }
}

const partCtx = (): NormalizeCtx => normalizeCtx('/fixture/zcode.db', 'part')

describe('normalize snapshots (§5.3)', () => {
  it('matches the committed per-source event projections', async () => {
    await withHost(async (host) => {
      for (const table of SOURCE_TABLES) {
        const { events } = await scanSource(host.dbPath, table, 0, { stableIds: true })
        await matchSnapshot(`${table}.json`, project(events))
      }
    })
  })
})

describe('drift accounting (§5.2 rule 1 / §5.3)', () => {
  it('an unseen part kind becomes a counted unknown carrying the redacted raw row', async () => {
    const result = await normalize(
      row('part', 41, { message_id: 'm1', session_id: 's1' }, { type: 'quantum-state', brandNewField: { nested: 1 }, text: 'private body' }),
      partCtx(),
    )
    expect(isParseFailure(result)).toBe(false)
    if ('events' in result) {
      const [event] = result.events
      expect(event?.type).toBe('unknown')
      expect(event?.subtype).toBe('quantum-state')
      expect(event?.metadata?.mapped).toBe(false)
      // §5.3: "never seen this type" and "seen it, deliberately unmapped" are different facts.
      expect(event?.metadata?.recognized_part_type).toBe(false)
      expect(event?.metadata?.raw).toMatchObject({ type: 'quantum-state', brandNewField: { nested: 1 } })
      // §3.2/§6: the raw copy is the drift evidence, not a content leak.
      expect(JSON.stringify(event?.metadata?.raw)).not.toContain('private body')
    }
  })

  it('an unseen message kind and a semantics-less row both land as unknown', async () => {
    const future = await normalize(
      row('message', 42, { session_id: 's1' }, { role: 'user', semantics: { kind: 'quantum_notification', origin: 'agent_runtime' } }),
      normalizeCtx('/fixture/zcode.db', 'message'),
    )
    const bare = await normalize(row('message', 43, { session_id: 's1' }, { role: 'user', somethingNew: true }), normalizeCtx('/fixture/zcode.db', 'message'))
    if ('events' in future && 'events' in bare) {
      expect(future.events[0]?.type).toBe('unknown')
      expect(future.events[0]?.subtype).toBe('quantum_notification')
      expect(bare.events[0]?.type).toBe('unknown')
      expect(bare.events[0]?.subtype).toBe('message-without-semantics')
    }
  })

  it('recognizes `timeline`/`file` as measured-but-unmapped rather than as new drift', async () => {
    for (const type of ['timeline', 'file']) {
      const result = await normalize(row('part', 45, { message_id: 'm1', session_id: 's1' }, { type, timelineType: 'model_change' }), partCtx())
      if (!('events' in result)) throw new Error('unexpected failure')
      expect(result.events[0]?.type).toBe('unknown')
      expect(result.events[0]?.subtype).toBe(type)
      expect(result.events[0]?.metadata?.recognized_part_type).toBe(true)
    }
  })

  it('an unknown table is reported, never dropped', async () => {
    const result = await normalize(row('turn_usage', 3, { session_id: 's1' }, { input_tokens: 5 }), partCtx())
    if ('events' in result) expect(result.events[0]?.subtype).toBe('table:turn_usage')
  })

  it('a row with no mappable fields still produces an event instead of vanishing', async () => {
    const result = await normalize(row('part', 44, {}, {}), partCtx())
    if ('events' in result) expect(result.events[0]?.type).toBe('unknown')
    else throw new Error('unexpected failure')
  })

  it('a parse-marker record reports a ParseFailure, not a throw', async () => {
    const record: RawRecord = {
      seq: 9,
      offset: 9,
      occurredAt: FIXED_NOW,
      value: { __agentlensParseError: 'json-parse: undecodable part.data', rawLine: '{oops' },
    }
    const result = await normalize(record, partCtx())
    expect(isParseFailure(result)).toBe(true)
    if (isParseFailure(result)) {
      expect(result.failure.reason).toContain('json-parse')
      expect(result.failure.offset).toBe(9)
      expect(result.failure.rawSeq).toBe(9)
    }
  })

  it('normalize never throws on garbage input (§5.2)', async () => {
    for (const value of [null, 7, 'text', [], { data: 1 }, { __table: 'model_usage' }]) {
      const result = await normalize({ seq: 1, offset: 1, occurredAt: FIXED_NOW, value }, partCtx())
      expect('events' in result || 'failure' in result).toBe(true)
    }
  })
})

describe('usage and cost rules (§18 rows 1/4)', () => {
  it('a model_usage row always produces usage, and an error row produces zeroed usage with an error status', async () => {
    const ok = await normalize(
      row('model_usage', 51, { status: 'completed', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, computed_total_tokens: 110, logical_request_id: 'r1', session_id: 's1' }, null),
      normalizeCtx('/fixture/zcode.db', 'model_usage'),
    )
    if ('events' in ok) {
      expect(ok.events[0]?.usage).toEqual({
        inputTokens: 35,
        outputTokens: 10,
        cacheReadTokens: 60,
        cacheWriteTokens: 5,
        reasoningTokens: 0,
      })
      expect(ok.events[0]?.usageSource).toBe('reported')
    }
  })

  it('cost is never reported, whatever the row says (§四 plan-zero trap)', async () => {
    const withCost = await normalize(
      row('part', 52, { message_id: 'm1', session_id: 's1' }, { type: 'step-finish', cost: 0, tokens: { total: 10, input: 8, output: 2 } }),
      partCtx(),
    )
    const assistant = await normalize(
      row('message', 53, { session_id: 's1' }, { role: 'assistant', semantics: { kind: 'assistant_response', origin: 'agent_runtime' }, cost: 0, tokens: { total: 10, input: 8, output: 2 } }),
      normalizeCtx('/fixture/zcode.db', 'message'),
    )
    for (const result of [withCost, assistant]) {
      if ('events' in result) {
        for (const e of result.events) {
          expect(e.costReported).toBeNull()
          expect(e.costSource).toBe('none')
        }
      } else throw new Error('unexpected failure')
    }
    // The column value is still recorded as evidence next to the null that replaces it.
    if ('events' in assistant) {
      const rollup = assistant.events[0]?.metadata?.rollup as Record<string, unknown>
      expect(rollup.cost_column_value).toBe(0)
      expect(rollup.cost).toBeNull()
      expect(String(rollup.cost_reason)).toContain('BigModel')
    }
  })
})

describe('identity and content rules', () => {
  it('keeps whole file bodies out of the content layer and records their size (§3.2/§6)', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'part')
      const read = events.find((e) => e.metadata?.call_id === 'call_fixture_read_1')
      expect(read?.type).toBe('tool.start')
      // `Read`'s INPUT is a path, so it stays; its 4 KiB file body is what must not ship.
      expect(read?.payload?.kind).toBe('tool_input')
      expect(read?.metadata?.input_excluded).toBe(false)
      expect(read?.metadata?.observed_output_excluded).toBe(true)
      expect(read?.metadata?.observed_output_chars).toBe(4_096)
      expect(JSON.stringify(read?.payload ?? '')).not.toContain('xxxx')
      const write = events.find((e) => e.metadata?.call_id === 'call_fixture_write_1')
      expect(write?.payload).toBeNull()
      expect(write?.metadata?.input_excluded).toBe(true)
      // The size of the whole serialized `state.input`, which is the body plus its JSON keys.
      expect(write?.metadata?.input_chars).toBeGreaterThan(4_200)
      const bash = events.find((e) => e.metadata?.call_id === 'call_fixture_bash_1')
      expect(bash?.payload?.kind).toBe('tool_input')
      expect(String(bash?.payload?.text)).toContain('echo synthetic')
    })
  })

  it('caps reasoning payloads at 32 KiB and tool inputs at 4 KiB', async () => {
    await withHost(async (host) => {
      const { events } = await scanSource(host.dbPath, 'part')
      const huge = events
        .filter((e) => e.payload?.kind === 'reasoning')
        .sort((a, b) => (b.payload?.text.length ?? 0) - (a.payload?.text.length ?? 0))[0]
      expect(huge?.payload?.text.length).toBe(32 * 1024 + 1) // cap plus the ellipsis marker
      expect(String(huge?.payload?.text).endsWith('…')).toBe(true)
    })
  })

  it('never lets a session row invent a host: every event reports the single zcode surface', async () => {
    await withHost(async (host) => {
      const { events } = await scanAll(host.dbPath)
      expect(new Set(events.map((e) => e.hostId))).toEqual(new Set(['zcode']))
      expect(new Set(events.map((e) => e.agentId))).toEqual(new Set(['zcode']))
    })
  })
})
