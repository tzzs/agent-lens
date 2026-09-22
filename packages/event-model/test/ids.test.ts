/**
 * §4.1's three session-id tiers. Tiers 1 and 2 are pinned by digest on purpose: their
 * values already exist as `sessions.id` / `events.session_id` rows, so re-keying them in
 * a refactor would split stored history rather than rename it.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveSessionId,
  deriveSessionIdFromSource,
  deriveSessionIdFromTimeBucket,
  resolveSessionId,
  SESSION_TIME_BUCKET_MS,
} from '../src/ids.ts'

/** A whole bucket boundary: 30 minutes divides it exactly, so offsets land predictably. */
const T0 = Date.UTC(2026, 8, 20, 12, 0)
const MIN = 60 * 1000

describe('§4.1 tiers 1 and 2 are untouched', () => {
  it('the native session id digest is byte-identical', () => {
    expect(deriveSessionId('claude-code', 'sess-1')).toBe(
      'b0c0b087e7be7dd5502371f1baee712e8c5d375caa36519e5459de8bf30b6639',
    )
  })

  it('the first-record-uuid digest is byte-identical', () => {
    expect(deriveSessionIdFromSource('src-abc', 'u-1')).toBe(
      '73a1d7544341ae6241a33eb12f496f9635f45134708404c8c5b4a4f08384e55a',
    )
  })

  it('resolveSessionId stops at tier 1 when a native id exists, and at tier 2 for a uuid', () => {
    expect(
      resolveSessionId({
        agentId: 'claude-code',
        nativeSessionId: 'sess-1',
        sourceId: 'src-abc',
        recordUuid: 'u-1',
        timestampMs: T0,
      }),
    ).toBe(deriveSessionId('claude-code', 'sess-1'))
    expect(
      resolveSessionId({ agentId: 'claude-code', sourceId: 'src-abc', recordUuid: 'u-1', timestampMs: T0 }),
    ).toBe(deriveSessionIdFromSource('src-abc', 'u-1'))
  })
})

describe('§4.1 tier 3 — source_id + 30-minute time bucket', () => {
  it('the bucket width is the §4.1 gap', () => {
    expect(SESSION_TIME_BUCKET_MS).toBe(30 * MIN)
  })

  it('groups records of one source that are less than 30 minutes apart into one session', () => {
    const ids = [T0 + 1, T0 + 10 * MIN, T0 + 29 * MIN].map((ts) => deriveSessionIdFromTimeBucket('src-abc', ts))
    expect(new Set(ids).size).toBe(1)
  })

  it('opens a new session across a gap of more than 30 minutes', () => {
    expect(deriveSessionIdFromTimeBucket('src-abc', T0)).not.toBe(
      deriveSessionIdFromTimeBucket('src-abc', T0 + 31 * MIN),
    )
  })

  it('keys the bucket by source, so two id-less sources never merge', () => {
    expect(deriveSessionIdFromTimeBucket('src-a', T0)).not.toBe(deriveSessionIdFromTimeBucket('src-b', T0))
  })

  it('is stable for the same record, so a rescan from offset 0 re-derives the same session (§4.2)', () => {
    expect(deriveSessionIdFromTimeBucket('src-abc', T0 + 7 * MIN)).toBe(
      deriveSessionIdFromTimeBucket('src-abc', T0 + 7 * MIN),
    )
  })

  it('buckets on fixed epochs rather than the previous record, and says so in behavior', () => {
    // A running "gap since last record" counter cannot survive §4.2: a resumed scan that
    // starts mid-file has no last record, so the same bytes would yield two different
    // session ids. The cost is that one record either side of a boundary splits a session
    // even 1ms apart — pinned here so the trade-off stays visible.
    expect(deriveSessionIdFromTimeBucket('src-abc', T0 + 29 * MIN + 59_000)).not.toBe(
      deriveSessionIdFromTimeBucket('src-abc', T0 + 30 * MIN + 59_000),
    )
  })

  it('resolveSessionId falls through to the bucket only when tiers 1 and 2 are empty', () => {
    const base = { agentId: 'pi', sourceId: 'src-abc', timestampMs: T0 + 3 * MIN }
    for (const empty of [null, undefined, '']) {
      expect(resolveSessionId({ ...base, nativeSessionId: empty, recordUuid: empty })).toBe(
        deriveSessionIdFromTimeBucket('src-abc', T0 + 3 * MIN),
      )
    }
  })
})
