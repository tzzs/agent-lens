/**
 * Pure shaping for the overview charts — no DOM, so it is unit-tested directly.
 */

export interface Slice {
  label: string
  value: number
  title?: string
}

/**
 * Keep the `n` largest slices and fold the rest into one "Other" slice, so a
 * donut legend stays readable with dozens of projects. Zero/invalid values are
 * dropped first — they would only add empty legend rows.
 */
export function topN(rows: Slice[], n: number, otherLabel = 'Other'): (Slice & { other?: number })[] {
  const valid = rows.filter((r) => Number.isFinite(r.value) && r.value > 0).sort((a, b) => b.value - a.value)
  if (valid.length <= n) return valid
  const head = valid.slice(0, n - 1)
  const tail = valid.slice(n - 1)
  const rest = tail.reduce((a, r) => a + r.value, 0)
  return [...head, { label: `${otherLabel} (${tail.length})`, value: rest, other: tail.length }]
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
