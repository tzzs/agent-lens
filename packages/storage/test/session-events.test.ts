/**
 * §14 invariant test for the canonical timeline order: one session fed by two
 * sources whose raw_seq ranking and timestamp order disagree must still come
 * back chronological, with raw_seq/id only as tiebreakers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { insertEvents } from '../src/write.ts'
import { loadSessionEvents } from '../src/query-shape.ts'
import { cleanup, makeEvent, tempDir } from './helpers.ts'

const SESSION = 'sess-multi-source'
const T = 1_750_000_000_000

const fixtures = [
  makeEvent({ id: 'b1', sessionId: SESSION, sourceId: 'src-B', rawSeq: 1, timestamp: T + 10 }),
  makeEvent({ id: 'a1', sessionId: SESSION, sourceId: 'src-A', rawSeq: 1, timestamp: T + 30 }),
  makeEvent({ id: 'b2', sessionId: SESSION, sourceId: 'src-B', rawSeq: 2, timestamp: T + 20 }),
  makeEvent({ id: 'a2', sessionId: SESSION, sourceId: 'src-A', rawSeq: 2, timestamp: T + 40 }),
  // a3/b3 share a timestamp across sources: raw_seq must break the tie.
  makeEvent({ id: 'a3', sessionId: SESSION, sourceId: 'src-A', rawSeq: 3, timestamp: T + 50 }),
  makeEvent({ id: 'b3', sessionId: SESSION, sourceId: 'src-B', rawSeq: 9, timestamp: T + 50 }),
  makeEvent({ id: 'noise', sessionId: 'sess-elsewhere', sourceId: 'src-A', rawSeq: 1, timestamp: T + 15 }),
]

describe('loadSessionEvents (canonical order)', () => {
  const dir = tempDir()
  let db: DatabaseSync
  beforeAll(() => {
    db = openDatabase(join(dir, 'test.db'))
    migrate(db)
    insertEvents(db, fixtures)
  })
  afterAll(() => {
    db.close()
    cleanup(dir)
  })

  it('is chronological across sources even when raw_seq disagrees', () => {
    expect(loadSessionEvents(db, SESSION).map((e) => e.id)).toEqual(['b1', 'b2', 'a1', 'a2', 'a3', 'b3'])
  })

  it('keeps timestamps non-decreasing and scopes to the session', () => {
    const events = loadSessionEvents(db, SESSION)
    expect(events.every((e, i) => i === 0 || e.timestamp >= events[i - 1]!.timestamp)).toBe(true)
    expect(loadSessionEvents(db, 'missing-session')).toEqual([])
  })
})
