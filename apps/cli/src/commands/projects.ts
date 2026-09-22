/**
 * §4.1 attribution repair, CLI side — closes the gap §19 records for databases that
 * already exist. Roots are recorded only at ingest, and a source whose stats are
 * unchanged is skipped, so project rows created before naming existed would print as
 * 64-hex digests forever. This module supplies the *evidence* (candidate path strings
 * decoded from the persisted `sources.path`, adapters stay DB-free per §5.2) and the
 * storage-side `backfillProjectRoots` decides: nothing is written unless a candidate
 * hashes to the row's digest exactly, so a root is proven, never invented.
 *
 * The decode direction matters: instead of guessing how a cwd was encoded, each
 * encoded directory name (e.g. claude-code's `-Users-me-work-my-repo`, where every
 * non-alphanumeric became `-`) is *walked* against the real filesystem — at each `-`
 * run we try candidate directory names that actually exist in the current directory.
 * Ambiguity (`-` was once `/`, `.`, `_`, …) collapses to the few paths the disk knows
 * about; deleted leaves simply yield their existing prefixes, which is exactly what
 * worktree folding needs (a worktree's digest is its main repo's root).
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { backfillProjectRoots, projectsWithoutRoots, type RootRepairStats } from '@agentlens/storage'

export interface RepairDeps {
  homedir?: string
  /** Injectable for tests; defaults to a read-only directory listing. */
  listDir?: (dir: string) => string[]
  /** Per-decode work cap so a pathological name cannot dominate the scan. */
  maxResults?: number
}

const EMPTY_STATS: RootRepairStats = { inspected: 0, repaired: [], remaining: 0 }

/**
 * The repair step, run after a scan so existing rows catch up without forcing a full
 * re-ingest of every source. Returns the storage-side stats; callers print or ignore —
 * a second run with the same evidence writes nothing (§4.2 idempotence).
 */
export function repairProjectRoots(db: DatabaseSync, deps: RepairDeps = {}): RootRepairStats {
  if (projectsWithoutRoots(db).length === 0) return EMPTY_STATS
  return backfillProjectRoots(db, {
    extraCandidates: sourcePathCandidates(db, deps),
    homedir: deps.homedir,
  })
}

/** Source paths of the agents that still have unlabelled project rows. */
function sourcePathCandidates(db: DatabaseSync, deps: RepairDeps): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT path FROM sources WHERE agent_id IN (
         SELECT DISTINCT e.agent_id FROM events e JOIN projects p ON p.id = e.project_id
         WHERE p.canonical_root IS NULL)`,
    )
    .all() as { path: unknown }[]
  const candidates = new Set<string>()
  const listDir = deps.listDir ?? defaultListDir
  for (const row of rows) {
    const path = String(row.path ?? '')
    // Every directory segment might itself be an encoded absolute path (the session
    // file name is not, and a plain segment like `projects` decodes to nothing new).
    const segments = path.split('/').slice(0, -1)
    for (const segment of segments) {
      for (const decoded of decodeEncodedDir(segment, listDir, deps.maxResults ?? 1000)) {
        candidates.add(decoded)
      }
    }
  }
  return candidates
}

function defaultListDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The upstream slug rule (claude-code, qoder, workbuddy, pi): every non-alphanumeric character becomes `-`. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Enumerate real paths whose sanitized form is `enc`, bounded by directory listings.
 * Returns every existing prefix reached (not just full consumes) — the encoded cwd may
 * end in a deleted worktree directory, while the digest still names the live main repo
 * several levels up.
 */
export function decodeEncodedDir(enc: string, listDir: (dir: string) => string[], maxResults = 1000): string[] {
  const trimmed = enc.replace(/-+$/, '')
  if (!trimmed.includes('-')) return []
  const tokens = trimmed.split('-')
  const out = new Set<string>()
  let budget = maxResults

  const rec = (pos: number, path: string): void => {
    if (budget <= 0) return
    budget--
    out.add(path)
    if (pos >= tokens.length) return
    let children: Map<string, string[]> | null = null
    let joined = ''
    for (let k = pos; k < tokens.length; k++) {
      const token = tokens[k]
      if (token === undefined) break
      joined = k === pos ? token : `${joined}-${token}`
      if (joined.length > 64) break
      children ??= indexChildren(listDir(path))
      // An empty token group can only be a boundary, never a whole directory name.
      if (joined === '') continue
      for (const child of children.get(joined) ?? []) rec(k + 1, join(path, child))
    }
  }

  // A leading run of dashes is the `/` of an absolute path plus any hidden-directory
  // markers; try every split of it. No leading dash (workbuddy) means start at 0.
  let leadingDashes = 0
  while (leadingDashes < tokens.length && tokens[leadingDashes] === '') leadingDashes++
  const starts = tokens[0] === '' ? Array.from({ length: leadingDashes + 1 }, (_, i) => i) : [0]
  for (const start of starts) rec(start, '/')
  out.delete('/')
  return [...out]
}

function indexChildren(names: string[]): Map<string, string[]> {
  const by = new Map<string, string[]>()
  for (const name of names) {
    const key = sanitize(name)
    const list = by.get(key)
    if (list) list.push(name)
    else by.set(key, [name])
  }
  return by
}
