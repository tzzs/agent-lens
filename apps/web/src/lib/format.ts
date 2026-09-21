/**
 * Pure display formatting. No DOM, no fetching — just number/date shaping so
 * every page renders the same way. The one product rule encoded here: a `null`
 * cost is "n/a", never "$0" (§8: an unknown price must not read as free).
 */

const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 })
const intFmt = new Intl.NumberFormat('en')

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return intFmt.format(Math.round(n))
}

/** 1,234,567 -> "1.23M"; used for the big card numbers. */
export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return compactFmt.format(n)
}

/** USD. null/undefined => "n/a" (NOT $0). Values under a cent keep more decimals. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a'
  const abs = Math.abs(n)
  const digits = abs > 0 && abs < 1 ? 4 : abs < 100 ? 2 : 2
  return `$${n.toFixed(digits)}`
}

/** Duration in ms -> human "1h 2m", "3.4s", "240ms". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—'
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

export function formatDate(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—'
  return new Date(ts).toISOString().slice(0, 10)
}

export function formatClock(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—'
  return new Date(ts).toISOString().slice(11, 23)
}

/** "3m ago" style, relative to `now`. Falls back to the absolute date past a week. */
export function relativeTime(ts: number | null | undefined, now: number): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—'
  const diff = now - ts
  if (diff < 0) return formatDate(ts)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return formatDate(ts)
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

/**
 * A cost figure with its basis, honestly labelled. Returns the display string
 * plus the qualitative flags the copy needs (estimate vs reported vs partial).
 */
export function costDisplay(n: number | null | undefined, partial = false): { text: string; title: string } {
  const text = formatUsd(n)
  if (text === 'n/a') return { text, title: 'no price available — shown as n/a, never $0 (§8)' }
  if (partial) return { text, title: 'at least this much: some agents have no price and are excluded (§8)' }
  return { text, title: 'computed from tokens × price (estimate)' }
}

/**
 * Hash-like ids (session ids, sha256 project ids) are unreadable at full length
 * and blow out table columns. Show a fixed-width prefix; callers put the full
 * value in a `title` so it stays inspectable and copyable.
 */
export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return '—'
  return id.length > n + 1 ? id.slice(0, n) : id
}

/** True when a label is an opaque hex digest rather than a human name. */
export function looksLikeHash(s: string | null | undefined): boolean {
  return !!s && /^[0-9a-f]{24,}$/i.test(s)
}

/** A display name for a project: its name, or a short id when only a digest is known. */
export function projectLabel(name: string | null | undefined): string {
  if (!name) return '(no project)'
  return looksLikeHash(name) ? shortId(name) : name
}
