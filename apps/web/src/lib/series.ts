/**
 * Pure shaping for the overview charts — no DOM, so it is unit-tested directly.
 * The "Other" fold is the one word here, and it comes from the message catalog.
 */
import { msg } from '@agentlens/i18n'

export interface Slice {
  label: string
  value: number
  title?: string
  /** Where clicking the slice drills in; the folded "Other" slice never has one. */
  href?: string
  /** A colour that follows the entity (an agent keeps its hue on every page); else slot order. */
  color?: string
}

/**
 * Keep the `n` largest slices and fold the rest into one "Other" slice, so a
 * donut legend stays readable with dozens of projects. Zero/invalid values are
 * dropped first — they would only add empty legend rows.
 */
export function topN(rows: Slice[], n: number): (Slice & { other?: number })[] {
  const valid = rows.filter((r) => Number.isFinite(r.value) && r.value > 0).sort((a, b) => b.value - a.value)
  if (valid.length <= n) return valid
  const head = valid.slice(0, n - 1)
  const tail = valid.slice(n - 1)
  const rest = tail.reduce((a, r) => a + r.value, 0)
  return [...head, { label: msg('fmt.otherFold', { n: String(tail.length) }), value: rest, other: tail.length }]
}

/**
 * Change of the second half of a series against its first half, as a fraction
 * (0.12 = +12%). This is what the overview's KPI badges show — the API returns a
 * single window, so the honest comparison available is within it. Returns null
 * when either half is empty or the baseline is zero (no meaningful ratio).
 */
export function halfOverHalf(values: number[]): number | null {
  if (values.length < 4) return null
  const mid = Math.floor(values.length / 2)
  const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  const first = sum(values.slice(0, mid))
  const second = sum(values.slice(values.length - mid))
  if (first <= 0) return null
  return (second - first) / first
}

export interface PivotSeries {
  key: string
  /** One value per bucket, aligned with `buckets`; a bucket with no row is 0. */
  values: number[]
  total: number
  /** True for the folded remainder, which charts draw in the muted colour. */
  other?: boolean
}

/**
 * Cube rows (`{day, model, tokens_total}`…) as time buckets × series, for a stacked trend.
 * Keeps the `top` series with the largest totals and folds the rest into one "Other"
 * series, so a chart never needs a ninth hue (and a series' colour can follow its key).
 * Buckets come back sorted; rows with an empty series key are dropped, since in the cube
 * that is "events of another kind", not a series of its own.
 */
export function pivotSeries(
  rows: readonly Record<string, unknown>[],
  timeKey: string,
  seriesKey: string,
  metric: string,
  top = 6,
): { buckets: string[]; series: PivotSeries[] } {
  const buckets = [...new Set(rows.map((r) => String(r[timeKey] ?? '')))].filter((b) => b !== '').sort()
  const at = new Map(buckets.map((b, i) => [b, i]))
  const byKey = new Map<string, number[]>()
  for (const r of rows) {
    const key = String(r[seriesKey] ?? '')
    const i = at.get(String(r[timeKey] ?? ''))
    if (key === '' || i === undefined) continue
    const v = Number(r[metric] ?? 0)
    if (!Number.isFinite(v)) continue
    const arr = byKey.get(key) ?? new Array<number>(buckets.length).fill(0)
    arr[i]! += v
    byKey.set(key, arr)
  }
  const all = [...byKey].map(([key, values]) => ({ key, values, total: values.reduce((a, b) => a + b, 0) }))
  all.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1))
  const kept = all.filter((s) => s.total > 0)
  if (kept.length <= top) return { buckets, series: kept }
  const head = kept.slice(0, top - 1)
  const rest = kept.slice(top - 1)
  const values = buckets.map((_, i) => rest.reduce((a, s) => a + s.values[i]!, 0))
  return { buckets, series: [...head, { key: '', values, total: values.reduce((a, b) => a + b, 0), other: true }] }
}
