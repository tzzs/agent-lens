/**
 * §4.1 attribution repair for project rows that already exist.
 *
 * `projects.canonical_root` rides in on ingest traffic (`recordProjectRoots` in the
 * CLI), and a source whose stats are unchanged is skipped — so rows minted before
 * project naming existed keep printing as 64-hex digests in `agl projects` forever.
 * This module is the storage-side half of the fix: it never *invents* a root from a
 * digest. It takes candidate path strings (cwd evidence persisted in event metadata,
 * plus evidence the CLI decodes from `sources.path`), runs each through the same
 * §4.1 normalization the collector used at ingest, and accepts a candidate only when
 * `deriveProjectId(root)` reproduces the row's id exactly. The digest is the oracle;
 * a row with no matching evidence is left alone so the UI keeps showing it honestly.
 *
 * Writes go through `upsertProject`, whose COALESCE update arm means a repair can
 * never erase a known root or a user-set display name. With no matching rows the
 * function writes nothing, so a second run is a no-op (idempotent, §4.2-convergent).
 */
import type { DatabaseSync } from 'node:sqlite'
import { deriveProjectId, projectRootForCwd, UNATTRIBUTED_PROJECT_ID } from '@agentlens/event-model'
import { upsertProject } from './write.ts'

export interface RootRepairOptions {
  /**
   * Candidate cwd/root strings gathered outside the database — today the CLI's decode
   * of encoded directories in `sources.path` (§5.2 rule 1 keeps adapters DB-free, so
   * that evidence enters here rather than inside storage).
   */
  extraCandidates?: Iterable<string>
  /** Forwarded to `projectRootForCwd` so `~`-evidence resolves like at ingest. */
  homedir?: string
}

export interface RootRepairStats {
  /** Rows that read as an unlabelled digest when the repair started. */
  inspected: number
  /** Ids that gained a canonical root in this run. */
  repaired: string[]
  /** Rows with no evidence-backed candidate — still digests, still honest. */
  remaining: number
}

/**
 * Metadata keys that carry an original cwd string, grouped by the project they were
 * ingested under. `$.cwd` (pi session headers) and `$.project_hint` (claude-code
 * history index, §4.4 row 4) are adapter facts, not guesses — but the digest check in
 * `backfillProjectRoots` still has to agree before anything is written.
 */
const CWD_EVIDENCE_KEYS = ['$.cwd', '$.project_hint'] as const

export function projectsWithoutRoots(db: DatabaseSync): string[] {
  const rows = db
    .prepare('SELECT id FROM projects WHERE canonical_root IS NULL')
    .all() as { id: string }[]
  // The unattributed bucket is a digest *by design* (§5.2) — labelling it a path would
  // be inventing one. Its human-readable name comes from `projectLabel` instead.
  return rows.map((r) => r.id).filter((id) => id !== UNATTRIBUTED_PROJECT_ID)
}

/**
 * Give every project row whose id some candidate path hashes to its root. Returns what
 * changed; writes nothing when nothing is provable.
 */
export function backfillProjectRoots(db: DatabaseSync, opts: RootRepairOptions = {}): RootRepairStats {
  const targets = new Set(projectsWithoutRoots(db))
  const stats: RootRepairStats = { inspected: targets.size, repaired: [], remaining: targets.size }
  if (targets.size === 0) return stats

  // `idx_projects_canonical_root` is UNIQUE, and two ids can never share one root by
  // construction — but a root already shown to belong to another row is skipped so a
  // stale duplicate can only ever be ignored, never fought over.
  const takenRoots = new Set(
    (db.prepare('SELECT canonical_root AS r FROM projects WHERE canonical_root IS NOT NULL').all() as { r: string }[])
      .map((row) => row.r),
  )

  for (const candidate of evidencePool(db, opts)) {
    if (targets.size === 0) break
    for (const root of candidateRoots(candidate, opts.homedir)) {
      const id = deriveProjectId(root)
      if (!targets.has(id) || takenRoots.has(root)) continue
      upsertProject(db, { id, canonicalRoot: root })
      targets.delete(id)
      takenRoots.add(root)
      stats.repaired.push(id)
      break
    }
  }
  stats.remaining = targets.size
  return stats
}

function evidencePool(db: DatabaseSync, opts: RootRepairOptions): Set<string> {
  const pool = new Set<string>()
  for (const key of CWD_EVIDENCE_KEYS) {
    const rows = db
      .prepare(`SELECT DISTINCT json_extract(metadata, ?) AS c FROM events WHERE c IS NOT NULL AND c != ''`)
      .all(key) as { c: string }[]
    for (const row of rows) pool.add(String(row.c))
  }
  for (const extra of opts.extraCandidates ?? []) if (extra) pool.add(extra)
  return pool
}

/**
 * Both the raw candidate and its §4.1-folded root: an encoded directory names a cwd,
 * while the id digests the *canonical* root (worktree folding, merge table). Whichever
 * of the two reproduces the digest is the row's root — the fold is a filesystem read,
 * so a moved repo simply matches nothing instead of writing a stale guess.
 */
function candidateRoots(candidate: string, homedir?: string): string[] {
  const folded = (() => {
    try {
      return projectRootForCwd(candidate, homedir ? { homedir } : {})
    } catch {
      return null
    }
  })()
  return folded === null || folded === candidate ? [candidate] : [folded, candidate]
}
