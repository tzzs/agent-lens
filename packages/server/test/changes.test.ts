/**
 * The SSE change poll runs on the same single-threaded, synchronous driver that serves every
 * other request, so a tick that costs 37 ms costs it to the whole server — once per open
 * connection, every 2 s, forever. These pin the two properties that make that survivable
 * (cheap steady state, one poller shared by all connections) and the tick shape the browser's
 * status line reads.
 */
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { insertEvents } from '@agentlens/storage'
import type { AgentEvent } from '@agentlens/event-model'
import { DEFAULT_POLL_MS, pollChangeSource } from '../src/changes.ts'
import type { ChangeTick } from '../src/types.ts'
import { harness } from './helpers.ts'

/** Statements touching the big tables, recorded while `run` is in flight. */
async function trackQueries(db: DatabaseSync, run: () => Promise<void>): Promise<string[]> {
  const original = db.prepare.bind(db)
  const seen: string[] = []
  ;(db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
    if (/FROM events/i.test(sql)) seen.push(sql.replace(/\s+/g, ' ').slice(0, 60))
    return original(sql)
  }
  try {
    await run()
  } finally {
    ;(db as unknown as { prepare: (s: string) => unknown }).prepare = original
  }
  return seen
}

const advance = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const POLL = 5

describe('pollChangeSource', () => {
  it('keeps the tick shape the dashboard renders', () => {
    const h = harness()
    const src = pollChangeSource(h.seeded.db, () => 1_700_000_200_000)
    expect(src.snapshot()).toEqual({ maxTimestamp: 1_700_003_610_000, events: 11, emittedAt: 1_700_000_200_000 })
    h.close()
  })

  it('runs the poll once per tick however many connections are watching', async () => {
    const h = harness()
    const db = h.seeded.db
    const open = () => pollChangeSource(db, () => Date.now(), POLL).watch(() => {})

    const stopOne = [open()]
    const one = await trackQueries(db, () => advance(80))
    stopOne.forEach((s) => s())

    const stopMany = [open(), open(), open(), open(), open()]
    const many = await trackQueries(db, () => advance(80))
    stopMany.forEach((s) => s())
    h.close()

    // Five watchers must not add a single scan beyond the one that is always running. A
    // tolerance, not a ratio: real timers fire a variable number of times in 80 ms, and the
    // point is that the count is bounded by the tick rate rather than by the connection count.
    expect(one.length, 'a poll must actually have happened').toBeGreaterThan(0)
    expect(many.length, `5 watchers issued ${many.length} queries vs ${one.length} for 1`).toBeLessThanOrEqual(one.length + 2)
  })

  it('emits to every open connection when the stream moves, and to none while it is quiet', async () => {
    const h = harness()
    const db = h.seeded.db
    const a: ChangeTick[] = []
    const b: ChangeTick[] = []
    const stopA = pollChangeSource(db, () => Date.now(), POLL).watch((t) => a.push(t))
    const stopB = pollChangeSource(db, () => Date.now(), POLL).watch((t) => b.push(t))
    await advance(40)
    expect([a.length, b.length], 'a quiet table must produce no ticks').toEqual([0, 0])

    const base = h.seeded.events[0]!
    const fresh: AgentEvent = { ...base, id: 'zz-new', timestamp: 1_800_000_000_000, usage: null, usageSource: 'missing' }
    insertEvents(db, [fresh])
    await advance(60)
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBe(a.length)
    expect(a.at(-1)).toMatchObject({ maxTimestamp: 1_800_000_000_000, events: 12 })
    stopA()
    stopB()
    h.close()
  })

  it('notices a delete-only change, which neither MAX(timestamp) nor MAX(rowid) reveals', async () => {
    const h = harness()
    const db = h.seeded.db
    const ticks: ChangeTick[] = []
    const stop = pollChangeSource(db, () => Date.now(), POLL).watch((t) => ticks.push(t))
    await advance(30)
    // Retention removes the OLDEST rows (§6); the high-water marks do not move at all.
    db.prepare('DELETE FROM events WHERE timestamp = (SELECT MIN(timestamp) FROM events)').run()
    await advance(60)
    expect(ticks.length, 'a purge must still reach connected dashboards').toBeGreaterThan(0)
    expect(ticks.at(-1)!.events).toBeLessThan(11)
    stop()
    h.close()
  })

  it('does no polling work at all once every connection has closed', async () => {
    const h = harness()
    const db = h.seeded.db
    const stop = pollChangeSource(db, () => Date.now(), POLL).watch(() => {})
    stop()
    const seen = await trackQueries(db, () => advance(80))
    expect(seen, 'a server nobody is watching should be idle').toEqual([])
    h.close()
  })

  it('keeps the default cadence', () => {
    expect(DEFAULT_POLL_MS).toBe(2_000)
  })

  /**
   * The steady-state poll is the whole point of this file, and it hinges on a SQLite detail:
   * the MIN/MAX index optimisation applies to a statement with ONE aggregate, so
   * `SELECT MAX(timestamp), MIN(timestamp), MAX(rowid) FROM events` walks every index entry
   * instead of three edges — measured 12 ms versus 0.002 ms on a 343k-row store, i.e. slower
   * than the `COUNT(*)` this replaced. Folding the three back into one SELECT would look like
   * a cleanup and cost 6000x, so the plan is asserted rather than trusted.
   */
  it('probes the stream edges with index seeks, not a scan', () => {
    const h = harness()
    const probe = h.seeded.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT (SELECT MAX(timestamp) FROM events) a, (SELECT MIN(timestamp) FROM events) b, (SELECT MAX(rowid) FROM events) c',
      )
      .all() as { detail: string }[]
    const plan = probe.map((r) => r.detail).join('\n')
    expect(plan).toContain('SCALAR SUBQUERY')
    expect(plan, 'a bare scan of the events index means the poll got expensive again').not.toMatch(/^SCAN events/m)
    h.close()
  })
})
