/**
 * ASCII output rendering (§9's aligned tables, §11's glyph prefixes).
 * Plain strings only — chalk is deliberately absent.
 */
import { formatUsd as pricingFormatUsd } from '@agentlens/pricing'

/** formatUsd with a friendlier input type for cube rows (undefined == null == n/a). */
export function formatUsd(v: number | null | undefined): string {
  return pricingFormatUsd(v ?? null)
}

export const GLYPH = {
  ok: '✓',
  warn: '!',
  none: '−',
  err: '✗',
} as const

/** 8,200,000 -> "8.2M"; keeps one decimal, trims trailing .0. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a'
  const abs = Math.abs(n)
  const fmt = (v: number, suffix: string): string => {
    const s = v.toFixed(1)
    return (s.endsWith('.0') ? s.slice(0, -2) : s) + suffix
  }
  if (abs >= 1e12) return fmt(n / 1e12, 'T')
  if (abs >= 1e9) return fmt(n / 1e9, 'B')
  if (abs >= 1e6) return fmt(n / 1e6, 'M')
  if (abs >= 1e3) return fmt(n / 1e3, 'k')
  return String(n)
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'n/a'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? 'n/a' : n.toLocaleString('en-US')
}

/** Visible width: treats everything above as width 1 (no CJK handling needed for our data). */
function width(s: string): number {
  return [...s].reduce((w, ch) => w + (ch === '\u001b' ? 0 : 1), 0)
}

function pad(s: string, w: number, align: 'left' | 'right'): string {
  const gap = Math.max(0, w - width(s))
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap)
}

export type Align = 'left' | 'right'

/** The aligned ASCII tables of §9: header row, ── rule, body rows. */
export function table(
  headers: readonly string[],
  rows: readonly (string | number | null | undefined)[][],
  aligns?: readonly Align[],
): string {
  const cell = (v: string | number | null | undefined): string =>
    v === null || v === undefined ? 'n/a' : typeof v === 'number' ? formatCount(v) : v
  const body = rows.map((r) => r.map(cell))
  const widths = headers.map((h, c) =>
    Math.max(width(h), ...body.map((r) => width(r[c] ?? '')), 0),
  )
  const align = (c: number): Align => aligns?.[c] ?? 'left'
  const lines: string[] = []
  lines.push(headers.map((h, c) => pad(h, widths[c]!, align(c))).join('  ').trimEnd())
  lines.push(widths.map((w) => '─'.repeat(w)).join('──'))
  for (const r of body) lines.push(r.map((v, c) => pad(v ?? '', widths[c]!, align(c))).join('  ').trimEnd())
  return lines.join('\n')
}

/** ms epoch -> `YYYY-MM-DD HH:MM:SS` in UTC (report times must not depend on the machine TZ). */
export function formatTs(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return 'n/a'
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ')
}

export function formatTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19)
}
