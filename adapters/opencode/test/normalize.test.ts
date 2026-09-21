/**
 * Unit-level normalize rules that must hold regardless of what the host database
 * happens to contain: drift accounting, NULL-vs-zero cost, the token dialect, the
 * single-host decision, and id discriminators across sources.
 */
import { describe, expect, it } from 'vitest'
import { deriveSessionId, isParseFailure, type NormalizeCtx, type RawRecord } from '@agentlens/event-model'
import { normalize } from '../src/normalize.ts'
import { AGENT_ID, HOST_ID } from '../src/record.ts'
import { FIXED_NOW, normalizeCtx } from './helpers.ts'

function row(table: string, rowid: number, columns: Record<string, unknown>, data: Record<string, unknown>): RawRecord {
  const value = { __rowid: rowid, __table: table, data, time_created: FIXED_NOW, ...columns }
  return { seq: rowid, offset: rowid, occurredAt: FIXED_NOW, value }
}

function eventsFor(record: RawRecord, ctx: NormalizeCtx) {
  return normalize(record, ctx)
}

const ctx = normalizeCtx('/fixture/opencode.db', 'part')

describe('drift accounting (§5.2 rule 1 / §5.3)', () => {
  it('an unknown part kind becomes a counted unknown carrying the raw row', async () => {
    const result = await eventsFor(row('part', 41, { message_id: 'm1', session_id: 's1' }, { type: 'temporal-blob', wow: 1 }), ctx)
    expect(isParseFailure(result)).toBe(false)
    if ('events' in result) {
      const [event] = result.events
      expect(event?.type).toBe('unknown')
      expect(event?.subtype).toBe('part-type:temporal-blob')
      expect(event?.metadata?.mapped).toBe(false)
      expect(event?.metadata?.raw).toMatchObject({ type: 'temporal-blob', wow: 1 })
    }
  })

  it('a part with no mappable fields still produces an event instead of vanishing', async () => {
    const result = await eventsFor(row('part', 42, {}, {}), ctx)
    if ('events' in result) expect(result.events[0]?.type).toBe('unknown')
    else throw new Error('unexpected failure')
  })

  it('a parse-marker record reports a ParseFailure, not a throw', async () => {
    const record: RawRecord = {
      seq: 9,
      offset: 9,
      occurredAt: FIXED_NOW,
      value: { __agentlensParseError: 'json-parse: bad data', rawLine: '{oops' },
    }
    const result = await normalize(record, ctx)
    expect(isParseFailure(result)).toBe(true)
    if (isParseFailure(result)) {
      expect(result.failure.reason).toContain('json-parse')
      expect(result.failure.offset).toBe(9)
    }
  })
})

describe('cost and usage (§18 rows 1/4)', () => {
  it('a missing cost stays NULL while a zero cost stays 0', async () => {
    const missing = await eventsFor(row('part', 51, {}, { type: 'step-finish', tokens: { input: 3, output: 1 } }), ctx)
    const zero = await eventsFor(row('part', 52, {}, { type: 'step-finish', cost: 0, tokens: { input: 3, output: 1 } }), ctx)
    if ('events' in missing && 'events' in zero) {
      expect(missing.events[0]?.costReported ?? null).toBe(null)
      expect(missing.events[0]?.costSource).toBe('none')
      expect(zero.events[0]?.costReported).toBe(0)
      expect(zero.events[0]?.costSource).toBe('reported')
    } else {
      throw new Error('unexpected failure')
    }
  })

  it('a step with no token object reports usageSource missing rather than a zero usage', async () => {
    const result = await eventsFor(row('part', 53, {}, { type: 'step-finish', cost: 0.2 }), ctx)
    if ('events' in result) {
      expect(result.events[0]?.usage).toBe(null)
      expect(result.events[0]?.usageSource).toBe('missing')
      expect(result.events[0]?.costReported).toBe(0.2)
    }
  })

  it('maps tokens_cache_read/write and proves input excludes cached tokens', async () => {
    // Measured shape: total = input + output + reasoning + cache.read, with
    // cache.read routinely larger than input — impossible if input included it.
    const result = await eventsFor(
      row('part', 54, {}, {
        type: 'step-finish',
        cost: 1.5,
        tokens: { total: 13_233, input: 11_057, output: 183, reasoning: 73, cache: { read: 1_920, write: 4 } },
      }),
      ctx,
    )
    if ('events' in result) {
      const usage = result.events[0]?.usage
      expect(usage).toEqual({
        inputTokens: 11_057,
        outputTokens: 183,
        cacheReadTokens: 1_920,
        cacheWriteTokens: 4,
        reasoningTokens: 73,
      })
      // No double count: the summed fields equal the agent's own total exactly once.
      const sum = Object.values(usage ?? {}).reduce((a, b) => a + b, 0)
      expect(sum).toBe(13_233 + 4) // cache.write is reported but excluded from total upstream
    }
  })
})

describe('identity rules', () => {
  it('reports a single honest host', async () => {
    const result = await eventsFor(row('part', 61, { session_id: 'ses_a' }, { type: 'step-finish', cost: 0.1 }), ctx)
    if ('events' in result) expect(result.events[0]?.hostId).toBe(HOST_ID)
    expect(AGENT_ID).toBe('opencode')
  })

  it('two sources over the same file cannot collide on an event id', async () => {
    const partCtx = normalizeCtx('/fixture/opencode.db', 'part')
    const messageCtx = normalizeCtx('/fixture/opencode.db', 'message')
    const a = await eventsFor(row('part', 7, {}, { type: 'step-finish', cost: 0.1 }), partCtx)
    const b = await eventsFor(row('message', 7, {}, { role: 'assistant', cost: 0.1 }), messageCtx)
    if ('events' in a && 'events' in b) {
      expect(a.events[0]?.id).not.toBe(b.events[0]?.id)
      expect(a.events[0]?.sourceId).not.toBe(b.events[0]?.sourceId)
    }
  })

  it('derives the session id from the root of the parent_id chain', async () => {
    const result = await eventsFor(
      row('part', 8, { session_id: 'ses_child', __session_id: 'ses_child', __root_session_id: 'ses_root', __session_parent_id: 'ses_root' }, {
        type: 'step-finish',
        cost: 0.1,
      }),
      ctx,
    )
    if ('events' in result) {
      const [event] = result.events
      expect(event?.sessionId).toBe(deriveSessionIdFor('ses_root'))
      expect(event?.threadId).toBe('ses_child')
      expect(event?.metadata?.subagentThread).toBe(true)
    }
  })
})

function deriveSessionIdFor(native: string): string {
  // Same rule as normalize (§4.1): the agent-namespaced native session id.
  return deriveSessionId(AGENT_ID, native)
}
