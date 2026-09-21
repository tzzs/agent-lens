// A tiny async-loader built on Svelte 5 runes so every page shares one honest
// loading / error / ready state machine. Components call it during init and drive
// `run()` from an $effect that reads the reactive inputs (range, live tick) it
// depends on; the internal `seq` guard drops responses that arrive after the
// request was superseded, so fast filter changes cannot show stale numbers.

export function loader(fn) {
  const state = $state({ status: 'loading', data: null, error: null, kind: null, details: null })
  let seq = 0

  async function run() {
    const my = ++seq
    state.status = 'loading'
    try {
      const data = await fn()
      if (my !== seq) return
      state.data = data
      state.status = 'ready'
      state.error = null
      state.kind = null
      state.details = null
    } catch (e) {
      if (my !== seq) return
      const err = /** @type {any} */ (e)
      state.error = err?.message ?? String(e)
      state.kind = err?.kind ?? null
      state.details = err?.details ?? null
      state.status = 'error'
    }
  }

  return { state, run }
}
