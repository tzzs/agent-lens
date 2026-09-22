/**
 * History coverage (§4.4 row 4, §11 Coverage block, §18 round 2).
 *
 * The measured machine showed the real gap is NOT parsing — it is upstream
 * retention: the project dir is still there, but its session files were
 * deleted. A first scan therefore looks complete while being partial, so the
 * number has to be surfaced instead of hidden.
 *
 * Everything here is a presence check over `sources` / `projects` / `sessions`
 * plus read-only `stat()` on the source dirs; no statistic is computed here
 * (that is the cube's job, §7). Paths are home-redacted before they leave.
 */
import type { ServerCtx } from './types.ts'
import { dirExists, fileExists, parentDir, projectLabelMap, redactHome, rowsOf } from './resolve.ts'

export interface UnreachableSource {
  id: string
  agentId: string
  path: string | null
  kind: string
  /** For a `sqlite` source, the table its untouched `last_offset` high-water indexes (§4.3); null otherwise. */
  sqliteTable: string | null
  status: string
  lastError: string | null
  filePresent: boolean
  dirPresent: boolean
}

export interface EmptyDir {
  dir: string
  agentIds: string[]
  missingSources: number
  lastEventAt: number | null
}

/**
 * §11's Coverage block answers TWO questions, and both surfaces now say so in the same words.
 *
 * The filesystem survey `agl doctor` runs asks "what does upstream still have?", including dirs
 * this tool never ingested a row from; the `sources` table behind the dashboard banner asks
 * "what did we ingest, and what of it has since gone?". Two counts of two different
 * populations, previously phrased almost identically, are exactly the §14 failure the audit
 * recorded — one number, one source, and where a second source is genuinely needed, a second
 * LABEL. So the clause below is the only place this fact is worded, and every caller names its
 * population through a `RetentionScope`.
 */
export interface RetentionScope {
  readonly id: 'ingested' | 'upstream'
  /** What is being counted, in the same words everywhere. */
  readonly noun: string
  /** Which population the count covers; printed beside it. */
  readonly population: string
}

/** Dirs this tool holds a `sources` row for, whose file is gone while the dir remains. */
export const INGESTED_RETENTION: RetentionScope = {
  id: 'ingested',
  noun: 'source dir',
  population: 'upstream retention, dirs this store already has rows for',
}

/**
 * A project root with no session rows is a DIFFERENT fact from retention — it may simply never
 * have been scanned — so it gets its own sentence here rather than borrowing the retention one.
 */
export function projectRowsPhrase(count: number): string {
  return `${count} attributed project root${count === 1 ? '' : 's'} hold no session rows here — never ingested from them, or retention took it since (§7)`
}

/** First-level dirs of a live agent store — including ones nothing was ever ingested from. */
export const UPSTREAM_RETENTION: RetentionScope = {
  id: 'upstream',
  noun: 'session dir',
  population: 'upstream retention, every dir in the live store whether ingested or not',
}

/** The single wording of the single fact; `total`/`under` only place the count, never rename it. */
export function retentionPhrase(scope: RetentionScope, count: number, total?: number, under?: string | null): string {
  const plural = (n: number) => `${scope.noun}${n === 1 ? '' : 's'}`
  const head = total === undefined ? `${count} ${plural(count)}` : `${count} of ${total} ${plural(total)}`
  const one = count === 1
  return `${head}${under ? ` under ${under}` : ''} still exist${one ? 's' : ''} but hold${one ? 's' : ''} no session files (${scope.population}, §4.4 row 4)`
}

/**
 * The dashboard banner. It used to add two different populations into one number and call the
 * sum "source dirs"; each now says what it counts, so the terminal's broader filesystem sweep
 * and this narrower table read can be told apart on screen.
 */
export function coverageBanner(retainedSourceDirs: number, projectRootsWithoutRows: number): string | null {
  const clauses = [
    retainedSourceDirs > 0 ? retentionPhrase(INGESTED_RETENTION, retainedSourceDirs) : null,
    projectRootsWithoutRows > 0 ? projectRowsPhrase(projectRootsWithoutRows) : null,
  ].filter((c): c is string => c !== null)
  return clauses.length === 0 ? null : `${clauses.join(' · ')} — history is incomplete`
}

export interface CoverageReport {
  generatedAt: number
  incomplete: boolean
  sourcesKnown: number
  unreachable: UnreachableSource[]
  /** Dirs that still exist but whose session files are gone (upstream retention). */
  emptyDirs: EmptyDir[]
  /** Project rows whose canonical root is on disk yet has no session rows left. */
  projectDirsWithoutSessions: { project: string; root: string }[]
  eventlessSessions: number
  banner: string | null
  limits: string
}

export function coverageReport(ctx: ServerCtx): CoverageReport {
  const home = ctx.homedir
  const sources = rowsOf(
    ctx.db,
    'SELECT id, agent_id, path, kind, sqlite_table, status, last_error FROM sources ORDER BY agent_id, path',
  )
  const unreachable: UnreachableSource[] = []
  const byDir = new Map<string, EmptyDir>()
  for (const s of sources) {
    const path = s.path === null || s.path === undefined ? null : String(s.path)
    const dir = parentDir(path)
    const filePresent = fileExists(path)
    const dirPresent = dirExists(dir)
    const flagged = s.status === 'gone' || s.status === 'rotated' || s.status === 'error'
    if (flagged || (!filePresent && path !== null)) {
      unreachable.push({
        id: String(s.id),
        agentId: String(s.agent_id ?? ''),
        path: path === null ? null : redactHome(path, home),
        kind: String(s.kind ?? ''),
        sqliteTable: s.sqlite_table === null || s.sqlite_table === undefined ? null : String(s.sqlite_table),
        status: String(s.status ?? ''),
        lastError: s.last_error === null || s.last_error === undefined ? null : redactHome(String(s.last_error), home),
        filePresent,
        dirPresent,
      })
    }
    // The signature of upstream retention: dir still there, file(s) not.
    if (!filePresent && dirPresent && dir !== null) {
      const key = dir
      const last = rowsOf(ctx.db, 'SELECT MAX(timestamp) AS ts FROM events WHERE source_id = ?', String(s.id))[0]?.ts
      const entry = byDir.get(key) ?? { dir: redactHome(dir, home), agentIds: [], missingSources: 0, lastEventAt: null as number | null }
      if (!entry.agentIds.includes(String(s.agent_id ?? ''))) entry.agentIds.push(String(s.agent_id ?? ''))
      entry.missingSources += 1
      if (last !== null && last !== undefined) entry.lastEventAt = Math.max(entry.lastEventAt ?? 0, Number(last))
      byDir.set(key, entry)
    }
  }

  const labels = projectLabelMap(ctx.db)
  const projectRows = rowsOf(
    ctx.db,
    'SELECT id, canonical_root FROM projects WHERE canonical_root IS NOT NULL ORDER BY id',
  )
  const sessionsPerProject = new Map(
    rowsOf(ctx.db, 'SELECT project_id, COUNT(*) AS n FROM sessions WHERE project_id IS NOT NULL GROUP BY project_id').map((r) => [
      String(r.project_id),
      Number(r.n),
    ]),
  )
  const projectDirsWithoutSessions = projectRows
    .filter((r) => {
      const root = String(r.canonical_root)
      return dirExists(root) && (sessionsPerProject.get(String(r.id)) ?? 0) === 0
    })
    .map((r) => ({ project: labels.get(String(r.id)) ?? String(r.id), root: redactHome(String(r.canonical_root), home) }))

  const eventlessSessions = Number(
    rowsOf(ctx.db, 'SELECT COUNT(*) AS n FROM sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM events WHERE session_id IS NOT NULL)')[0]
      ?.n ?? 0,
  )

  const missingDirs = [...byDir.values()].sort((a, b) => b.missingSources - a.missingSources || a.dir.localeCompare(b.dir))
  const incomplete = missingDirs.length > 0 || projectDirsWithoutSessions.length > 0 || unreachable.length > 0
  return {
    generatedAt: ctx.now(),
    incomplete,
    sourcesKnown: sources.length,
    unreachable: unreachable.slice(0, 200),
    emptyDirs: missingDirs.slice(0, 200),
    projectDirsWithoutSessions: projectDirsWithoutSessions.slice(0, 200),
    eventlessSessions,
    banner: coverageBanner(missingDirs.length, projectDirsWithoutSessions.length),
    limits:
      'only dirs already ingested at least once are visible here; dirs never scanned cannot be distinguished from dirs with nothing in them — `agl doctor` sweeps the live store instead, and says which population it counted',
  }
}
