/**
 * Entity-name resolution + presence reads.
 *
 * The cube filters `project`/`agent` by opaque id (a hash), while the UI and the
 * CLI both accept human names; the same mapping rule lives here as in
 * apps/cli/src/context.ts so `?project=agentx` means one thing on both sides.
 * Nothing in this file aggregates tokens or cost (§7).
 */
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { projectLabel } from '@agentlens/event-model'

export type Row = Record<string, unknown>

export function rowsOf(db: DatabaseSync, sql: string, ...params: unknown[]): Row[] {
  const stmt = db.prepare(sql)
  const rows = (params.length ? stmt.all(...(params as never[])) : stmt.all()) as Row[]
  return rows.map((r) => ({ ...r }))
}

export function oneOf(db: DatabaseSync, sql: string, ...params: unknown[]): Row | undefined {
  return rowsOf(db, sql, ...params)[0]
}

export function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  return Number(v)
}

/** Rows come back typed `unknown`; presence checks only care about "is it a string". */
function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' && typeof v !== 'number') return null
  return String(v)
}

function match(values: unknown[], want: string): boolean {
  return values.some((v) => asString(v) !== null && String(v).toLowerCase() === want)
}

/** Agent ids and display names both resolve; unknown strings pass through (they may already be ids). */
export function resolveAgentIds(db: DatabaseSync, values: string[]): string[] {
  if (values.length === 0) return []
  const all = rowsOf(db, 'SELECT id, display_name FROM agents')
  return values.map((v) => {
    const hit = all.find((r) => match([r.id, r.display_name], v.toLowerCase()))
    return hit ? String(hit.id) : v
  })
}

/** Accepts project id, display_name, canonical root, or the root's basename (§9 shows names). */
export function resolveProjectIds(db: DatabaseSync, values: string[]): string[] {
  if (values.length === 0) return []
  const all = rowsOf(db, 'SELECT id, display_name, canonical_root FROM projects')
  return values.map((v) => {
    const want = v.toLowerCase()
    const hit = all.find((r) => {
      const root = r.canonical_root ? String(r.canonical_root) : null
      const base = root ? (root.split('/').filter(Boolean).pop() ?? null) : null
      const label = projectLabel({
        id: String(r.id),
        displayName: r.display_name ? String(r.display_name) : null,
        canonicalRoot: root,
      })
      return match([r.id, r.display_name, root, base, label], want)
    })
    return hit ? String(hit.id) : v
  })
}

/** id -> human label, using the cube's own precedence (§7: name, then dir, then word, then id). */
export function projectLabelMap(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rowsOf(db, 'SELECT id, display_name, canonical_root FROM projects')) {
    out.set(String(r.id), projectLabel({
      id: String(r.id),
      displayName: r.display_name ? String(r.display_name) : null,
      canonicalRoot: r.canonical_root ? String(r.canonical_root) : null,
    }))
  }
  return out
}

/** Redact the home dir out of anything the API echoes: this tool reads private logs. */
/**
 * Paint the home directory out of an event's metadata before it crosses the wire.
 *
 * `cwd`, `project_hint` and friends are metric-layer fields — they ship with the content layer
 * OFF, which is the posture §16 promises: "no message bodies, no prompts, no file contents".
 * A raw `/Users/<name>/…` still names the person, so the same helper that paints paths in
 * `coverage` and `dbPath` has to apply here too, or the privacy claim holds for every screen
 * except the one that shows an event's own provenance.
 *
 * Bounded walk, failing closed: adapter metadata is shallow (a handful of scalars per row), so
 * anything deeper than this is not a shape we know how to read, and a value we cannot inspect is
 * dropped rather than served — a depth cap that returns the original object would leak exactly
 * the path the walk exists to paint out.
 */
const METADATA_DEPTH_LIMIT = 3

export function redactMetadata(
  meta: Record<string, unknown> | null,
  home: string,
  depth = 0,
): Record<string, unknown> | null {
  if (meta === null || !home) return meta
  if (depth > METADATA_DEPTH_LIMIT) return null
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === 'string') out[key] = redactHome(value, home)
    else if (Array.isArray(value))
      out[key] = value.map((v) =>
        typeof v === 'string' ? redactHome(v, home) : v && typeof v === 'object' ? redactMetadata(v as Record<string, unknown>, home, depth + 1) : v,
      )
    else if (value && typeof value === 'object')
      out[key] = redactMetadata(value as Record<string, unknown>, home, depth + 1)
    else out[key] = value
  }
  return out
}

export function redactHome(text: string, home: string): string {
  if (!home) return text
  return text.split(home).join('~')
}

export function dirExists(path: string | null | undefined): boolean {
  if (!path) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function fileExists(path: string | null | undefined): boolean {
  if (!path) return false
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

export function parentDir(path: string | null | undefined): string | null {
  if (!path) return null
  return dirname(path)
}

export function readable(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
