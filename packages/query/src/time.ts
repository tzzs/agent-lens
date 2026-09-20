/**
 * Time-bucket helpers shared by the cube's SQL and its callers: bucketTs must
 * agree with the strftime expressions in DIM_SQL, so both anchor on the same
 * UTC rules (day floor, Monday-start weeks, month floor).
 */
import type { TimeUnit } from './spec.ts'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
/** epoch day 0 is a Thursday; Monday of week 0 is +4 days. */
const WEEK_START_OFFSET_MS = 4 * DAY_MS

export function bucketTs(timestamp: number, unit: TimeUnit): number {
  if (unit === 'month') {
    const d = new Date(timestamp)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  }
  if (unit === 'week') {
    const rem = (((timestamp - WEEK_START_OFFSET_MS) % WEEK_MS) + WEEK_MS) % WEEK_MS
    return timestamp - rem
  }
  return Math.floor(timestamp / DAY_MS) * DAY_MS
}

/** ms per unit for relative durations (`7d`, `24h`, `30m`). */
const RELATIVE: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY_MS }

/**
 * Accepts `7d` / `24h` / `30m` (relative to `now`), `2026-09-01` and `YYYYMMDD`
 * (UTC midnight), or a raw ms epoch. Returns a `since` timestamp in ms.
 */
export function resolveSince(input: string | number, now: number = Date.now()): number {
  if (typeof input === 'number') return input
  const s = String(input).trim()
  const rel = /^(\d+)([dhm])$/.exec(s)
  if (rel) return now - Number(rel[1]) * RELATIVE[rel[2]!]!
  if (/^\d{8}$/.test(s)) {
    const y = Number(s.slice(0, 4))
    const mo = Number(s.slice(4, 6))
    const d = Number(s.slice(6, 8))
    const ts = Date.UTC(y, mo - 1, d)
    if (Number.isNaN(ts) || mo < 1 || mo > 12 || d < 1 || d > 31) {
      throw new Error(`invalid date ${JSON.stringify(input)}`)
    }
    return ts
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ts = Date.parse(`${s}T00:00:00Z`)
    if (Number.isNaN(ts)) throw new Error(`invalid date ${JSON.stringify(input)}`)
    return ts
  }
  if (/^\d+$/.test(s)) return Number(s)
  throw new Error(
    `cannot parse time ${JSON.stringify(input)}; use 7d, 24h, 30m, 2026-09-01, 20260901, or ms epoch`,
  )
}
