// Hash router. Hand-rolled so the SPA needs no routing dependency (and no
// network). Hash routing was chosen deliberately: packages/server/static.ts only
// rewrites non-/api paths to index.html as a fallback, and a hash never hits the
// server, so deep links and refreshes resolve client-side regardless of how the
// static fallback is configured. `window` access is guarded for SSR-safety of the
// module import (there is no SSR here, but the guard keeps it side-effect free).
//
// The hash carries a query too (`#/sessions?agents=codex`): `route.path` is the part
// before '?', `route.query` the decoded params. Pages read their own keys from it and
// write them back with setQuery, which replaces the history entry instead of pushing
// one, so typing in a search box does not fill the Back button. Every entry it writes
// is marked in history.state, which is how a later Back/Forward to it can tell "this
// URL is complete, an absent key means the default" from a fresh link that only
// names what it cares about.
import { parseHash, buildHash, patchQuery } from './hashquery.ts'

function readHash() {
  if (typeof window === 'undefined') return parseHash('')
  return parseHash(window.location.hash)
}

/** The history.state key that marks an entry setQuery wrote. */
const MARK = 'aglQuery'

const first = readHash()
/** @type {{ path: string, query: Record<string, string> }} */
export const route = $state({ path: first.path, query: first.query })

export function navigate(path) {
  if (typeof window === 'undefined') return
  const target = path.startsWith('#') ? path.slice(1) : path
  if (window.location.hash.replace(/^#/, '') !== target) window.location.hash = target
  else Object.assign(route, parseHash(target))
}

/**
 * Merge `patch` into the current query (empty values remove a key) without a new
 * history entry. A no-op when nothing changes, so effects that write back what they
 * just read cannot loop.
 * @param {Record<string, string | null | undefined>} patch
 */
export function setQuery(patch) {
  // A hash change that has not been dispatched yet (a link click, `location.hash = …`)
  // would be overwritten by replaceState; skip, the effect re-runs once it lands.
  if (typeof window !== 'undefined' && parseHash(window.location.hash).path !== route.path) return
  const next = patchQuery(route.query, patch)
  const hash = buildHash(route.path, next)
  const marked = typeof window !== 'undefined' && window.history.state?.[MARK] === true
  if (hash === buildHash(route.path, route.query) && marked) return
  route.query = next
  if (typeof window !== 'undefined') window.history.replaceState({ ...window.history.state, [MARK]: true }, '', hash)
}

/**
 * A link target for `path` with `query`.
 * @param {string} path
 * @param {Record<string, string | null | undefined>} [query]
 */
export function href(path, query = {}) {
  return buildHash(path, query)
}

/**
 * Start listening. `onNavigate` sees each new query before `route` changes, so a
 * caller can adopt params from it (the global filter does) before any effect that
 * writes the query back runs. `complete` is true for an entry this router wrote
 * (Back/Forward), false for a fresh link.
 * @param {(query: Record<string, string>, complete: boolean) => void} [onNavigate]
 */
export function initRouter(onNavigate) {
  if (typeof window === 'undefined') return () => {}
  const onHash = () => {
    const next = readHash()
    onNavigate?.(next.query, window.history.state?.[MARK] === true)
    route.path = next.path
    route.query = next.query
  }
  window.addEventListener('hashchange', onHash)
  onHash()
  return () => window.removeEventListener('hashchange', onHash)
}

/** Split the current hash path into [name, ...segments], dropping empty parts. */
export function segments() {
  return route.path.split('/').filter((s) => s !== '')
}
