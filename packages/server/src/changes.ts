/**
 * SSE transport for GET /api/events (§13: SSE over WebSocket — one-way is enough).
 *
 * `pollChangeSource` below IS the live source the SSE wires by default: app.ts's
 * `changeSource` falls back to it whenever no transport is injected. It re-polls the events
 * table every couple of seconds because there is no file watcher in the server yet (M6 adds
 * one); when it arrives, only this default swaps — the frame format, keep-alive and
 * `?since=` handling of the chain above stay as they are.
 *
 * Two things make the poll safe to run against a 340k-event store on a single-threaded,
 * fully synchronous driver, where one expensive tick delays every other request:
 *
 *   1. the steady state reads three B-tree edges and no rows — see `EDGES_SQL` for why those
 *      must be separate scalar subqueries, and why the row count left the hot path;
 *   2. ONE poller serves every open connection, so N dashboards on the same server cost the
 *      same as one, instead of N timers each re-scanning the same table.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChangeSource, ChangeTick } from './types.ts'
import { rowsOf } from './resolve.ts'

export const SSE_KEEPALIVE_MS = 15_000
export const DEFAULT_POLL_MS = 2_000

/**
 * Cheap "has the stream moved" probe: the highest and lowest event timestamp plus the last
 * rowid. Each lives in its OWN scalar subquery, which is the difference between 0.002 ms and
 * 12 ms — SQLite's MIN/MAX optimisation (walk to one index edge and stop) only applies to a
 * statement holding a single aggregate, so `SELECT MAX(timestamp), MIN(timestamp), MAX(rowid)`
 * degrades to a full covering-index scan of all 343k rows. Measured, not assumed.
 *
 * Row count is deliberately absent — that is the one number that always costs a full scan —
 * so it is filled in only when something actually moved.
 *
 * MIN(timestamp) is not decoration: retention deletes the OLDEST events (§6 purge), which
 * moves neither MAX(timestamp) nor MAX(rowid). Watching the low edge too is what makes
 * a delete-only change visible without counting rows.
 */
const EDGES_SQL =
  'SELECT (SELECT MAX(timestamp) FROM events) AS max_ts, ' +
  '(SELECT MIN(timestamp) FROM events) AS min_ts, ' +
  '(SELECT MAX(rowid) FROM events) AS max_rowid'

interface Edge {
  maxTs: number | null
  minTs: number | null
  maxRowid: number
}

function edgesOf(db: DatabaseSync): Edge {
  const r = rowsOf(db, EDGES_SQL)[0] ?? {}
  return {
    maxTs: r.max_ts === null || r.max_ts === undefined ? null : Number(r.max_ts),
    minTs: r.min_ts === null || r.min_ts === undefined ? null : Number(r.min_ts),
    maxRowid: Number(r.max_rowid ?? 0),
  }
}

const sameEdges = (a: Edge, b: Edge): boolean =>
  a.maxTs === b.maxTs && a.minTs === b.minTs && a.maxRowid === b.maxRowid

function tickOf(db: DatabaseSync, now: () => number, edge: Edge = edgesOf(db)): ChangeTick {
  const n = rowsOf(db, 'SELECT COUNT(*) AS n FROM events')[0]?.n ?? 0
  return { maxTimestamp: edge.maxTs, events: Number(n), emittedAt: now() }
}

/**
 * A poller shared by every `watch()` on the same (database, cadence). Reference-counted:
 * the timer exists only while at least one connection is watching, so a server nobody is
 * looking at does no background work at all.
 */
interface Poller {
  refs: number
  timer: ReturnType<typeof setInterval> | null
  last: Edge
  subs: Set<(tick: ChangeTick) => void>
  stop: () => void
}

const pollers = new WeakMap<DatabaseSync, Map<number, Poller>>()

function sharedPoller(db: DatabaseSync, now: () => number, intervalMs: number): Poller {
  let byCadence = pollers.get(db)
  if (!byCadence) {
    byCadence = new Map()
    pollers.set(db, byCadence)
  }
  const existing = byCadence.get(intervalMs)
  if (existing) return existing
  const poller: Poller = {
    refs: 0,
    timer: null,
    last: edgesOf(db),
    subs: new Set(),
    stop: () => {
      if (poller.timer) clearInterval(poller.timer)
      poller.timer = null
      byCadence?.delete(intervalMs)
    },
  }
  byCadence.set(intervalMs, poller)
  return poller
}

/** Poll-based change source; the timer is unref'd so a server can still exit. */
export function pollChangeSource(db: DatabaseSync, now: () => number, intervalMs = DEFAULT_POLL_MS): ChangeSource {
  return {
    snapshot: () => tickOf(db, now),
    watch(emit) {
      const poller = sharedPoller(db, now, intervalMs)
      poller.refs += 1
      poller.subs.add(emit)
      if (!poller.timer) {
        const timer = setInterval(() => {
          const edge = edgesOf(db)
          if (sameEdges(edge, poller.last)) return
          poller.last = edge
          // The expensive count rides along only now: a tick means a page is about to
          // refetch anyway, and N connections then share the one answer.
          const tick = tickOf(db, now, edge)
          for (const sub of poller.subs) sub(tick)
        }, intervalMs)
        timer.unref?.()
        poller.timer = timer
      }
      return () => {
        poller.subs.delete(emit)
        poller.refs -= 1
        if (poller.refs <= 0) poller.stop()
      }
    },
  }
}
