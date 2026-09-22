/**
 * Invariant for `sessions.first_timestamp` / `last_timestamp`: they are the true
 * MIN/MAX over the session's own events — not a monotone widening of whatever any
 * past batch happened to carry. §5.2 (timestamp provenance) makes out-of-order
 * arrival normal for backfilled history, and §5.3 (parser-version rescan) can
 * re-derive both `events.timestamp` and `events.session_id` for rows already
 * stored, so the columns must converge back to min/max after every such ingest.
 * A §4.2 byte-identical replay must still leave the row untouched.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { insertEvents } from '../src/write.ts'
import { cleanup, makeEvent, SESSION_ID, snapshot as snap, tempDir } from './helpers.ts'

function sessionRow(db: DatabaseSync, id = SESSION_ID): { first_timestamp: number | null; last_timestamp: number | null; event_count: number } {
  return db
    .prepare('SELECT first_timestamp, last_timestamp, event_count FROM sessions WHERE id = ?')
    .get(id) as { first_timestamp: number | null; last_timestamp: number | null; event_count: number }
}

function trueSpan(db: DatabaseSync, id: string): { mn: number | null; mx: number | null } {
  const r = db
    .prepare('SELECT MIN(timestamp) mn, MAX(timestamp) mx FROM events WHERE session_id = ?')
    .get(id) as { mn: number | null; mx: number | null }
  return { mn: r.mn === null ? null : Number(r.mn), mx: r.mx === null ? null : Number(r.mx) }
}

describe('sessions.first_timestamp/last_timestamp are the true min/max (§4.3, §5.2, §5.3)', () => {
  let db: DatabaseSync
  let dir: string
  const open = () => {
    dir = tempDir()
    db = openDatabase(`${dir}/agentlens.db`)
    migrate(db)
  }
  const close = () => {
    db.close()
    cleanup(dir)
  }

  it('out-of-order arrivals across batches (old record after new) keep first<=last = min/max', () => {
    open()
    // A long-running agent: the session stays open, so a backfilled old record —
    // its timestamp guessed from file mtime per §5.2 — arrives *after* newer ones.
    insertEvents(db, [makeEvent({ rawSeq: 1, timestamp: 1_900 })])
    insertEvents(db, [makeEvent({ rawSeq: 2, timestamp: 1_000 })])
    const row = sessionRow(db)
    expect(Number(row.first_timestamp)).toBeLessThanOrEqual(Number(row.last_timestamp))
    expect([row.first_timestamp, row.last_timestamp]).toEqual([1_000, 1_900])
    close()
  })

  it('a §5.3 repair that re-derives an event timestamp pulls the session span back to truth', () => {
    open()
    // First scan guessed today's ingest clock for a historical record (§19).
    const stale = makeEvent({ rawSeq: 1, timestamp: 5_000 })
    insertEvents(db, [stale])
    expect(sessionRow(db)).toMatchObject({ first_timestamp: 5_000, last_timestamp: 5_000 })
    // Version-drift rescan: same event id (the conflict key), timestamp now sourced
    // from the record itself. The stored row must reflect the *new* span, not the
    // union of old and new — widening-only leaves last_timestamp at a value no
    // event of this session still carries.
    insertEvents(db, [makeEvent({ id: stale.id, rawSeq: 1, timestamp: 3_000 })])
    const row = sessionRow(db)
    expect([row.first_timestamp, row.last_timestamp]).toEqual([3_000, 3_000])
    const t = trueSpan(db, SESSION_ID)
    expect([row.first_timestamp, row.last_timestamp]).toEqual([t.mn, t.mx])
    close()
  })

  it('a §5.3 repair that moves events out leaves honest spans on both the old and the new session', () => {
    open()
    const early = makeEvent({ rawSeq: 1, timestamp: 1_000 })
    const moved = makeEvent({ rawSeq: 2, timestamp: 9_000 })
    insertEvents(db, [early, moved])
    expect(sessionRow(db)).toMatchObject({ first_timestamp: 1_000, last_timestamp: 9_000 })
    // Rescan re-derives `moved` into another session: SESSION_ID keeps only the
    // 1_000 event, so both its columns and the new session's must equal the truth.
    insertEvents(db, [makeEvent({ id: moved.id, rawSeq: 2, timestamp: 9_000, sessionId: 'sess-moved-to' })])
    expect(sessionRow(db)).toMatchObject({ first_timestamp: 1_000, last_timestamp: 1_000, event_count: 1 })
    expect(sessionRow(db, 'sess-moved-to')).toMatchObject({ first_timestamp: 9_000, last_timestamp: 9_000, event_count: 1 })
    for (const id of [SESSION_ID, 'sess-moved-to']) {
      const row = sessionRow(db, id)
      const t = trueSpan(db, id)
      expect([row.first_timestamp, row.last_timestamp]).toEqual([t.mn, t.mx])
    }
    close()
  })

  it('a repair rescan converges: replaying the repaired bytes is a no-op (§4.2)', () => {
    open()
    const stale = makeEvent({ rawSeq: 1, timestamp: 5_000 })
    insertEvents(db, [stale])
    const repaired = [makeEvent({ id: stale.id, rawSeq: 1, timestamp: 3_000 })]
    insertEvents(db, repaired)
    const afterFirst = snap(db)
    insertEvents(db, repaired)
    expect(snap(db)).toBe(afterFirst)
    close()
  })
})
