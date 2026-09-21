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
    'SELECT id, agent_id, path, status, last_error FROM sources ORDER BY agent_id, path',
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
  const bannerCount = missingDirs.length + projectDirsWithoutSessions.length
  return {
    generatedAt: ctx.now(),
    incomplete,
    sourcesKnown: sources.length,
    unreachable: unreachable.slice(0, 200),
    emptyDirs: missingDirs.slice(0, 200),
    projectDirsWithoutSessions: projectDirsWithoutSessions.slice(0, 200),
    eventlessSessions,
    banner:
      bannerCount > 0
        ? `${bannerCount} source dir${bannerCount === 1 ? '' : 's'} still exist${bannerCount === 1 ? 's' : ''} but hold no session files left (upstream retention) — history is incomplete`
        : null,
    limits:
      'only dirs already ingested at least once are visible here; dirs never scanned cannot be distinguished from dirs with nothing in them — run `agl doctor` for the adapter-level sweep',
  }
}
