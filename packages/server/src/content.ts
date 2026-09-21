/**
 * Content-layer access (§3.2). Payloads are opt-in (`--content`, off by default),
 * so every reader here answers "is there content?" rather than assuming it:
 * a missing content layer is a degraded mode the UI renders, not an error.
 *
 * These are presence/lookup reads of stored text, never statistics — all
 * numbers still come from the cube (§7).
 */
import { inflateSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import type { DatabaseSync } from 'node:sqlite'
import { rowsOf } from './resolve.ts'

/** Transport cap: a 22 MB file dump does not belong in a JSON timeline response (§6 capacity note). */
const MAX_TEXT_CHARS = 20_000

export interface PayloadView {
  kind: string
  role: string | null
  text: string
  bytes: number | null
  truncated: boolean
}

/** True when the content layer holds anything at all — the global degraded-mode flag. */
export function contentLayerPresent(db: DatabaseSync): boolean {
  return rowsOf(db, 'SELECT 1 AS one FROM payloads LIMIT 1').length > 0
}

export function payloadCount(db: DatabaseSync): number {
  return Number(rowsOf(db, 'SELECT COUNT(*) AS n FROM payloads')[0]?.n ?? 0)
}

function decode(blob: unknown): string {
  try {
    const buf = blob instanceof Uint8Array ? Buffer.from(blob) : Buffer.from(String(blob))
    return inflateSync(buf).toString('utf8')
  } catch {
    return '(unreadable payload)'
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function loadPayloads(db: DatabaseSync, eventIds: string[]): Map<string, PayloadView[]> {
  const out = new Map<string, PayloadView[]>()
  for (const group of chunk(eventIds, 400)) {
    if (group.length === 0) continue
    const placeholders = group.map(() => '?').join(', ')
    for (const r of rowsOf(db, `SELECT event_id, kind, role, text, bytes, truncated FROM payloads WHERE event_id IN (${placeholders})`, ...group)) {
      const text = decode(r.text)
      const over = text.length > MAX_TEXT_CHARS
      const list = out.get(String(r.event_id)) ?? []
      list.push({
        kind: String(r.kind ?? ''),
        role: r.role === null || r.role === undefined ? null : String(r.role),
        text: over ? text.slice(0, MAX_TEXT_CHARS) : text,
        bytes: r.bytes === null || r.bytes === undefined ? null : Number(r.bytes),
        truncated: Number(r.truncated ?? 0) === 1 || over,
      })
      out.set(String(r.event_id), list)
    }
  }
  return out
}

/** How many payload rows back each session's events (per-session degraded-mode marker). */
export function payloadCountBySession(db: DatabaseSync, sessionIds: string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const group of chunk(sessionIds, 400)) {
    if (group.length === 0) continue
    const placeholders = group.map(() => '?').join(', ')
    for (const r of rowsOf(
      db,
      `SELECT e.session_id AS session_id, COUNT(*) AS n
       FROM payloads p JOIN events e ON e.id = p.event_id
       WHERE e.session_id IN (${placeholders})
       GROUP BY e.session_id`,
      ...group,
    )) {
      out.set(String(r.session_id), Number(r.n))
    }
  }
  return out
}
