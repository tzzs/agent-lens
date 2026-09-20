import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { insertEvents, prune, recordParseFailure, updateSourceProgress, type SourceProgress } from '../src/write.ts'
import { makeEvent, SOURCE_ID } from './helpers.ts'

function progress(overrides: Partial<SourceProgress> = {}): SourceProgress {
  return {
    id: SOURCE_ID,
    agentId: 'fake-agent',
    path: '/tmp/fake/logs/a.jsonl',
    kind: 'jsonl',
    inode: 42,
    size: 4096,
    mtimeMs: 1_750_000_000_000,
    lastOffset: 100,
    parserVersion: 1,
    sessionIdHint: null,
    status: 'active',
    rowsIngested: 5,
    scanStartedAt: 1_750_000_050_000,
    scanFinishedAt: 1_750_000_060_000,
    lastError: null,
    ...overrides,
  }
}

function readOffset(db: ReturnType<typeof openDatabase>): number {
  return Number(
    (db.prepare('SELECT last_offset FROM sources WHERE id = ?').get(SOURCE_ID) as { last_offset: number })
      .last_offset,
  )
}

describe('source progress (§4.2)', () => {
  it('advances last_offset only when the batch commits', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    updateSourceProgress(db, progress({ lastOffset: 100 }))
    expect(readOffset(db)).toBe(100)

    const events = [makeEvent({ type: 'message.user', rawSeq: 800 })]
    insertEvents(db, events, { progress: progress({ lastOffset: 250, size: 8192 }) })
    expect(readOffset(db)).toBe(250)
    db.close()
  })

  it('a throwing mapping mid-batch rolls back BOTH events and the offset', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    updateSourceProgress(db, progress({ lastOffset: 100 }))

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic // makes JSON.stringify throw during event mapping
    const events = [
      makeEvent({ id: 'ok-1', type: 'message.user', rawSeq: 810 }),
      makeEvent({ id: 'boom', type: 'tool.end', rawSeq: 811, metadata: cyclic }),
      makeEvent({ id: 'ok-2', type: 'message.assistant', rawSeq: 812 }),
    ]
    expect(() => insertEvents(db, events, { progress: progress({ lastOffset: 999 }) })).toThrow()

    expect(readOffset(db)).toBe(100) // OLD offset survives
    const n = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }
    expect(n.c).toBe(0) // not even the events before the throw landed
    db.close()
  })

  it('replay of the same progress is stable and rows_ingested/status are upserted', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    updateSourceProgress(db, progress({ lastOffset: 100 }))
    updateSourceProgress(db, progress({ lastOffset: 100, status: 'rotated', rowsIngested: 0 }))
    const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(SOURCE_ID) as Record<string, unknown>
    expect(s.status).toBe('rotated')
    expect(s.rows_ingested).toBe(0)
    expect(s.last_offset).toBe(100)
    db.close()
  })
})

describe('prune (§6 retention)', () => {
  it('deletes stale payloads by default TTL and events only when asked', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const now = Date.now()
    const old = now - 60 * 24 * 60 * 60 * 1000
    insertEvents(
      db,
      [
        makeEvent({ id: 'p-old', type: 'message.user', rawSeq: 820, timestamp: old, ingestedAt: old, payload: { kind: 'user_message', role: 'user', text: 'old' } }),
        makeEvent({ id: 'p-new', type: 'message.user', rawSeq: 821, timestamp: now, ingestedAt: now, payload: { kind: 'user_message', role: 'user', text: 'new' } }),
      ],
      { contentEnabled: true },
    )
    // Default: only payloads past the 30-day TTL go; events are permanent.
    expect(prune(db)).toEqual({ payloadsDeleted: 1, eventsDeleted: 0 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM events').get()).toEqual({ c: 2 })
    // Explicit window also prunes events and leaves no orphan payloads.
    expect(prune(db, { olderThanDays: 30 })).toEqual({ payloadsDeleted: 0, eventsDeleted: 1 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM payloads').get()).toEqual({ c: 1 })
    db.close()
  })
})

describe('parse_errors (§5.2 rule 1)', () => {
  it('records failures without failing the batch', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    recordParseFailure(db, {
      reason: 'unknown record type',
      rawLine: '{"type":"weird"}',
      offset: 512,
      rawSeq: 4,
      upstreamType: 'weird',
      sourceId: SOURCE_ID,
      agentId: 'fake-agent',
      path: '/tmp/fake/logs/a.jsonl',
    })
    const rows = db.prepare('SELECT * FROM parse_errors').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reason: 'unknown record type', upstream_type: 'weird', raw_offset: 512 })
    db.close()
  })
})
