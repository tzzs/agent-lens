// Pure helpers for the `#/path?k=v` hash shape. Kept out of router.svelte.js so they
// can be tested without a window: the router only wires them to `location`.

export type Query = Record<string, string>

/** Split a hash (with or without the leading '#') into its path and query. */
export function parseHash(hash: string): { path: string; query: Query } {
  const h = hash.replace(/^#/, '')
  const i = h.indexOf('?')
  const path = (i < 0 ? h : h.slice(0, i)) || '/'
  const query: Query = {}
  if (i >= 0) {
    for (const [k, v] of new URLSearchParams(h.slice(i + 1))) if (v !== '') query[k] = v
  }
  return { path, query }
}

/** The hash for a path plus query; empty values are dropped so defaults stay out of the URL. */
export function buildHash(path: string, query: Record<string, string | null | undefined> = {}): string {
  const sp = new URLSearchParams()
  for (const k of Object.keys(query).sort()) {
    const v = query[k]
    if (v !== undefined && v !== null && v !== '') sp.set(k, v)
  }
  // Commas stay literal: they are the list separator (`agents=a,b`) and read better
  // unescaped. URLSearchParams decodes either spelling back to the same value.
  const qs = sp.toString().replace(/%2C/gi, ',')
  return '#' + path + (qs ? '?' + qs : '')
}

/** Apply a patch to a query: `undefined`/`null`/'' removes the key, anything else sets it. */
export function patchQuery(query: Query, patch: Record<string, string | null | undefined>): Query {
  const next: Query = { ...query }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') delete next[k]
    else next[k] = v
  }
  return next
}

/** A comma list param as an array (`agents=a,b`); absent or empty is `[]`. */
export function listOf(v: string | undefined): string[] {
  return v ? v.split(',').filter((s) => s !== '') : []
}
