// A tiny async-loader built on Svelte 5 runes so every page shares one honest
// loading / error / ready state machine. Components call it during init and drive
// `run()` from an $effect that reads the reactive inputs (range, live tick) it
// depends on.
//
// Single-flight: at most one request per loader is ever in flight. A `run()` that
// arrives mid-request only marks the loader dirty, and one trailing request fires
// when the current one settles — reading the inputs *then*, so the last filter
// always wins. Without this, SSE ticks that arrive faster than a slow query (the
// server's node:sqlite calls are synchronous) queue requests without bound.
//
// Stale-while-revalidate: once a page has data, a re-run keeps `status: 'ready'`
// and only raises `refreshing`, so a live tick never flashes the page back to a
// spinner. `since` is when the current request started, for elapsed-time UI.
//
// `run()` is called from $effects, so its body runs untracked: reading `state`
// here must not subscribe the caller's effect to this loader, or every response
// would re-trigger the effect and refetch forever. Callers declare their real
// inputs explicitly (`void range.since`, `void live.lastTick`, …).

import { untrack } from 'svelte'

/**
 * @template T
 * @typedef {{ status: "loading" | "ready" | "error", data: T | null, error: string | null, kind: string | null, details: any, refreshing: boolean, since: number }} LoaderState
 */

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {{ state: LoaderState<T>, run: () => Promise<void> }}
 */
export function loader(fn) {
  /** @type {LoaderState<T>} */
  const state = $state({
    status: 'loading',
    data: null,
    error: null,
    kind: null,
    details: null,
    refreshing: false,
    since: Date.now(),
  })
  let inFlight = false
  let dirty = false

  function run() {
    return untrack(go)
  }

  async function go() {
    if (inFlight) {
      dirty = true
      return
    }
    inFlight = true
    dirty = false
    state.since = Date.now()
    if (state.data !== null && state.status !== 'error') state.refreshing = true
    else state.status = 'loading'
    try {
      const data = await fn()
      state.data = data
      state.status = 'ready'
      state.error = null
      state.kind = null
      state.details = null
    } catch (e) {
      const err = /** @type {any} */ (e)
      state.error = err?.message ?? String(e)
      state.kind = err?.kind ?? null
      state.details = err?.details ?? null
      state.status = 'error'
    } finally {
      inFlight = false
      // Still dirty means newer inputs are queued: keep the "refreshing" cue on so
      // numbers from the superseded request never read as settled.
      state.refreshing = dirty
    }
    if (dirty) await go()
  }

  return { state, run }
}
