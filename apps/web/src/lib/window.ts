// The time window the header picks, turned into what the API reads. Pure so it can be
// tested without a browser: the rune store in filter.svelte.js only holds the choice.
//
// Three shapes of choice:
//   - a relative preset ('24h', '7d', … '365d'), sent as-is;
//   - 'all', sent as `since=0` — the server parses a bare number as a ms epoch, so the
//     window reaches back to the first event without a new API token;
//   - 'custom' with `from`/`to` as YYYY-MM-DD in the viewer's own calendar, sent as ms
//     epochs of local midnight and local end-of-day, so the `to` day is included whole
//     (the server's `until` is inclusive) and "1 Sep" means the viewer's 1 Sep, not UTC's.

export const PRESETS = ['24h', '7d', '30d', '90d', '365d'] as const
export const ALL = 'all'
export const CUSTOM = 'custom'
export type Granularity = 'day' | 'week' | 'month'

const DAY = 86_400_000

export const isIsoDate = (s: string | undefined | null): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(localMidnight(s))

/** Local midnight of a YYYY-MM-DD, as ms epoch. */
export function localMidnight(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const t = new Date(y, m - 1, d)
  // `new Date` rolls 2026-02-31 into March; a date that does not round-trip is invalid.
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? t.getTime() : Number.NaN
}

/** YYYY-MM-DD of a ms epoch in the viewer's calendar. */
export function isoDay(ts: number): string {
  const t = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/** A custom range is usable when both ends are real dates in order. */
export function validCustom(from: string, to: string): boolean {
  return isIsoDate(from) && isIsoDate(to) && localMidnight(from) <= localMidnight(to)
}

/** The `since`/`until` params for a choice; an unusable custom range falls back to 30d. */
export function windowParams(since: string, from: string, to: string): { since: string; until?: string } {
  if (since === ALL) return { since: '0' }
  if (since === CUSTOM) {
    if (!validCustom(from, to)) return { since: '30d' }
    // End of the `to` day: the next local midnight minus one ms (DST-safe, unlike +24h).
    const end = new Date(localMidnight(to))
    end.setDate(end.getDate() + 1)
    return { since: String(localMidnight(from)), until: String(end.getTime() - 1) }
  }
  return { since }
}

/** How many days a choice spans; 'all' is open-ended. */
export function spanDays(since: string, from: string, to: string): number {
  if (since === ALL) return Number.POSITIVE_INFINITY
  if (since === CUSTOM) return validCustom(from, to) ? Math.round((localMidnight(to) - localMidnight(from)) / DAY) + 1 : 30
  const m = /^(\d+)([dhm])$/.exec(since)
  if (!m) return 30
  const n = Number(m[1])
  return m[2] === 'd' ? n : m[2] === 'h' ? n / 24 : n / 1440
}

/**
 * Trend bucket for a window: days up to a quarter, weeks up to a year, months beyond.
 * Daily buckets over a year, split by host, overran the trend query's row cap and were
 * silently cut; coarser buckets also keep a long chart readable.
 */
export function granularityFor(since: string, from: string, to: string): Granularity {
  const days = spanDays(since, from, to)
  return days <= 92 ? 'day' : days <= 366 ? 'week' : 'month'
}
