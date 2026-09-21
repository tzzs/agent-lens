/**
 * SSE transport for GET /api/events (§13: SSE over WebSocket — one-way is enough).
 *
 * `pollChangeSource` below IS the live source the SSE wires by default: app.ts's
 * `changeSource` falls back to it whenever no transport is injected. It re-polls
 * MAX(events.timestamp) every couple of seconds because there is no file watcher in
 * the server yet (M6 adds one); when it arrives, only this default swaps — the
 * frame format, keep-alive and `?since=` handling of the chain above stay as they are.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChangeSource, ChangeTick } from './types.ts'
import { rowsOf } from './resolve.ts'

export const SSE_KEEPALIVE_MS = 15_000
export const DEFAULT_POLL_MS = 2_000

function tickOf(db: DatabaseSync, now: () => number): ChangeTick {
  const r = rowsOf(db, 'SELECT MAX(timestamp) AS max_ts, COUNT(*) AS n FROM events')[0] ?? {}
  return {
    maxTimestamp: r.max_ts === null || r.max_ts === undefined ? null : Number(r.max_ts),
    events: Number(r.n ?? 0),
    emittedAt: now(),
  }
}

/** Poll-based change source; the timer is unref'd so a server can still exit. */
export function pollChangeSource(db: DatabaseSync, now: () => number, intervalMs = DEFAULT_POLL_MS): ChangeSource {
  return {
    snapshot: () => tickOf(db, now),
    watch(emit) {
      let last = tickOf(db, now)
      const timer = setInterval(() => {
        const next = tickOf(db, now)
        if (next.maxTimestamp !== last.maxTimestamp || next.events !== last.events) {
          last = next
          emit(next)
        }
      }, intervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
}
