// Shared time-range + agent filter for every stats page. A `.svelte.js` module
// so Svelte 5 runes work outside a component and all pages read one source of
// truth (the §7 filter is the same object handed to /api/*). Kept tiny on
// purpose: the server validates every value, so this only assembles querystring
// params and never computes numbers itself.

import { ALL, CUSTOM, granularityFor, isIsoDate, validCustom, windowParams } from './window.ts'

export const SINCE_OPTIONS = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '1 year' },
  { value: ALL, label: 'All time' },
  { value: CUSTOM, label: 'Custom' },
]

// Empty strings mean "not filtered" — buildFilterParams drops them so the API
// receives only keys the user actually chose.
// `from`/`to` (YYYY-MM-DD, the viewer's calendar) only mean something while `since` is
// 'custom'; they are kept otherwise so switching back restores the last custom range.
export const range = $state({
  since: '30d',
  agent: '',
  host: '',
  from: '',
  to: '',
})

/** Params for the entity/stats routes (they share the same querystring filter). */
/** @returns {Record<string, string>} */
export function filterParams() {
  /** @type {Record<string, string>} */
  const p = {}
  const w = windowParams(range.since, range.from, range.to)
  p.since = w.since
  if (w.until) p.until = w.until
  if (range.agent) p.agent = range.agent
  if (range.host) p.host = range.host
  return p
}

// The global filter lives in the URL as `since`/`agent`/`host` so a refresh or a
// shared link keeps it. Sticky, not authoritative: a hash that names a key wins, a
// hash that leaves it out keeps the current value (and App writes it back). That is
// what lets every plain `#/sessions/<id>` link in the app stay filter-agnostic.
// Back/Forward to an entry the app wrote itself is different: that URL is complete,
// so an absent key there means the default and the filter returns to what it was.
const DEFAULT_SINCE = '30d'
const SINCE_VALUES = new Set(SINCE_OPTIONS.map((o) => o.value))

/** One string that changes whenever the window or the filter does — for keyed state. */
export function rangeKey() {
  return `${range.since}|${range.from}|${range.to}|${range.agent}|${range.host}`
}

/** The trend bucket the current window reads best at (see window.ts). */
export function granularity() {
  return granularityFor(range.since, range.from, range.to)
}

/**
 * Adopt the filter keys `query` carries; an unknown `since` is ignored. With
 * `complete`, absent keys reset to their defaults instead of being kept.
 * @param {Record<string, string>} query
 * @param {boolean} [complete]
 */
export function adoptFilterQuery(query, complete = false) {
  if (query.since === CUSTOM) {
    // A custom window without a usable range in the link is not adopted at all.
    if (validCustom(query.from ?? '', query.to ?? '')) {
      range.since = CUSTOM
      range.from = query.from
      range.to = query.to
    } else if (complete) range.since = DEFAULT_SINCE
  } else if (query.since !== undefined && SINCE_VALUES.has(query.since)) range.since = query.since
  else if (complete) range.since = DEFAULT_SINCE
  if (query.agent !== undefined) range.agent = query.agent
  else if (complete) range.agent = ''
  if (query.host !== undefined) range.host = query.host
  else if (complete) range.host = ''
}

/** The query patch that mirrors the filter; the default window stays out of the URL. */
/** @returns {Record<string, string | undefined>} */
export function filterQuery() {
  return {
    since: range.since === DEFAULT_SINCE ? undefined : range.since,
    from: range.since === CUSTOM && isIsoDate(range.from) ? range.from : undefined,
    to: range.since === CUSTOM && isIsoDate(range.to) ? range.to : undefined,
    agent: range.agent || undefined,
    host: range.host || undefined,
  }
}
