/**
 * Pure display formatting. No DOM, no fetching — just number/date shaping so
 * every page renders the same way. The one product rule encoded here: a `null`
 * cost is "n/a", never "$0" (§8: an unknown price must not read as free).
 *
 * Locale-dependent, through `@agentlens/i18n`'s active locale rather than a
 * parameter: these run inside plain functions that no store can reach, and the
 * language switcher keeps that holder in step with the screen. Grouping and
 * compact scales follow the locale (a Chinese reader gets 万/亿, which is the
 * point of asking in Chinese); currency stays `$` because that is the unit the
 * data is in, not a word this UI translates. Absolute timestamps stay ISO-UTC in
 * every locale so a screenshot and a log line still agree.
 */
import { activeLocale, msg } from '@agentlens/i18n'

const forms = new Map<string, { int: Intl.NumberFormat; compact: Intl.NumberFormat }>()

function localeForms() {
  const locale = activeLocale()
  let f = forms.get(locale)
  if (!f) {
    f = {
      int: new Intl.NumberFormat(locale),
      compact: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 }),
    }
    forms.set(locale, f)
  }
  return f
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return msg('common.dash')
  return localeForms().int.format(Math.round(n))
}

/** 1,234,567 -> "1.23M"; used for the big card numbers. */
export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return msg('common.dash')
  return localeForms().compact.format(n)
}

/**
 * USD. null/undefined => "n/a" (NOT $0). Values under a dollar keep four decimals,
 * and a real but sub-$0.0001 cost reads "<$0.0001" — "$0.0000" would look free.
 */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return msg('common.na')
  const abs = Math.abs(n)
  if (abs > 0 && abs < 0.00005) return n < 0 ? '>-$0.0001' : '<$0.0001'
  return `$${n.toFixed(abs > 0 && abs < 1 ? 4 : 2)}`
}

/** True when a cost figure has no price behind it — the "n/a" state, by input, not by glyph. */
export function isUnpriced(n: number | null | undefined): boolean {
  return n === null || n === undefined || !Number.isFinite(n)
}

/** Duration in ms -> human "1h 2m", "3.4s", "240ms". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return msg('common.dash')
  if (ms < 1000) return msg('fmt.unitMs', { n: String(Math.round(ms)) })
  const s = ms / 1000
  if (s < 60) return msg('fmt.unitS', { n: s.toFixed(s < 10 ? 1 : 0) })
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return msg('fmt.durMS', { m: String(m), s: String(rs) })
  const h = Math.floor(m / 60)
  return msg('fmt.durHM', { h: String(h), m: String(m % 60) })
}

/**
 * What the session-level `duration` metric actually is, in the words every surface
 * that shows it uses — so it is one catalog message, not a sentence three pages
 * each re-type. It sums the durations agents reported for their own calls, so it is
 * machine time: a session left open overnight reads as seconds, and one whose calls
 * never reported a duration reads as nothing. Labelling that "Duration" invites the
 * other reading, which is why the session surfaces call it "Active" and put the wall
 * clock beside it.
 */
export function activeMetricInfo(): string {
  return msg('fmt.activeMetric')
}

/**
 * A session's wall clock: first event to last. `null` when either end is unknown or they are the
 * same instant, because a span of zero says nothing the event count does not already.
 */
export function spanMs(first: number | null | undefined, last: number | null | undefined): number | null {
  if (first === null || first === undefined || last === null || last === undefined) return null
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null
  return last - first
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return msg('common.dash')
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

export function formatDate(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return msg('common.dash')
  return new Date(ts).toISOString().slice(0, 10)
}

export function formatClock(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return msg('common.dash')
  return new Date(ts).toISOString().slice(11, 23)
}

/** "3m ago" style, relative to `now`. Falls back to the absolute date past a week. */
export function relativeTime(ts: number | null | undefined, now: number): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return msg('common.dash')
  const diff = now - ts
  if (diff < 0) return formatDate(ts)
  const s = Math.floor(diff / 1000)
  if (s < 60) return msg('fmt.agoS', { n: String(s) })
  const m = Math.floor(s / 60)
  if (m < 60) return msg('fmt.agoM', { n: String(m) })
  const h = Math.floor(m / 60)
  if (h < 24) return msg('fmt.agoH', { n: String(h) })
  const d = Math.floor(h / 24)
  if (d < 7) return msg('fmt.agoD', { n: String(d) })
  return formatDate(ts)
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return msg('common.dash')
  return `${(n * 100).toFixed(digits)}%`
}

/**
 * A cost figure with its basis, honestly labelled. Returns the display string
 * plus the qualitative flags the copy needs (estimate vs reported vs partial).
 */
export function costDisplay(n: number | null | undefined, partial = false): { text: string; title: string } {
  if (isUnpriced(n)) return { text: msg('common.na'), title: msg('fmt.costNoPrice') }
  const text = formatUsd(n)
  if (partial) return { text, title: msg('fmt.costPartial') }
  return { text, title: msg('fmt.costEstimate') }
}

/**
 * Hash-like ids (session ids, sha256 project ids) are unreadable at full length
 * and blow out table columns. Show a fixed-width prefix; callers put the full
 * value in a `title` so it stays inspectable and copyable.
 */
export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return msg('common.dash')
  return id.length > n + 1 ? id.slice(0, n) : id
}

/** True when a label is an opaque hex digest rather than a human name. */
export function looksLikeHash(s: string | null | undefined): boolean {
  return !!s && /^[0-9a-f]{24,}$/i.test(s)
}

/** A display name for a project: its name, or a short id when only a digest is known. */
export function projectLabel(name: string | null | undefined): string {
  if (!name) return msg('fmt.noProject')
  return looksLikeHash(name) ? shortId(name) : name
}
