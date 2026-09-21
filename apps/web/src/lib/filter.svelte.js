// Shared time-range + agent filter for every stats page. A `.svelte.js` module
// so Svelte 5 runes work outside a component and all pages read one source of
// truth (the §7 filter is the same object handed to /api/*). Kept tiny on
// purpose: the server validates every value, so this only assembles querystring
// params and never computes numbers itself.

export const SINCE_OPTIONS = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '365d', label: '1 year' },
]

// Empty strings mean "not filtered" — buildFilterParams drops them so the API
// receives only keys the user actually chose.
export const range = $state({
  since: '30d',
  agent: '',
  host: '',
})

/** Params for the entity/stats routes (they share the same querystring filter). */
/** @returns {Record<string, string>} */
export function filterParams() {
  /** @type {Record<string, string>} */
  const p = {}
  if (range.since) p.since = range.since
  if (range.agent) p.agent = range.agent
  if (range.host) p.host = range.host
  return p
}
