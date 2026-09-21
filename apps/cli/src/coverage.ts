/**
 * Read-only filesystem probes behind `doctor`'s Coverage and Permissions sections
 * (§11 · §4.4 row 4 · §18 row 7).
 *
 * Nothing here writes, moves, chmods or deletes, and a foreign SQLite file is never
 * OPENED: §18 row 7 records a probe that created `-wal`/`-shm` sidecars inside the
 * owner's data directory just by opening it "read-only". Journal mode therefore comes
 * from the file HEADER — `open(path, 'r')` cannot create or modify anything, and bytes
 * 18/19 are the write/read format versions where 2 means WAL.
 *
 * Every entry point takes an explicit directory so the whole section is testable
 * against a temp tree instead of this machine's `~/.claude`.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { readable } from './context.ts'

/** Existence and readability are different facts, and both differ from "not there". */
export type Access = 'readable' | 'unreadable' | 'missing'

export function accessOf(path: string): Access {
  if (!existsSync(path)) return 'missing'
  return readable(path) ? 'readable' : 'unreadable'
}

export function describeAccess(access: Access): string {
  return access === 'readable' ? 'readable' : access === 'unreadable' ? 'EXISTS but not readable' : 'does not exist'
}

/** `255.8 MB` style sizes for the Agents/Coverage lines (§11 prints files / bytes). */
export function formatBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}GB`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}MB`
  if (n >= 1_000) return `${Math.round(n / 1_000)}kB`
  return `${n}B`
}

/**
 * Longest common directory of a file list — without hardcoding any one agent's layout.
 * This is a prefix, not necessarily the store root: see `sessionStoreRoot`.
 */
export function commonStoreDir(paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  let dir = dirname(paths[0]!)
  for (const p of paths.slice(1)) {
    while (dir && !p.startsWith(dir + '/')) dir = dirname(dir)
    if (!dir) return null
  }
  return dir
}

/**
 * The root of the SESSION STORE, which is not the same thing as the common directory of
 * the live files. Upstream groups sessions one level below that root (`projects/<project>/`
 * for Claude, `sessions/<date>/…` for Codex), so the common dir of a store holding exactly
 * one project's files is the PROJECT dir, and a glob built from it claims a scope narrower
 * than what was scanned — while the dirs retention emptied stay invisible (§4.4 row 4 asks
 * about THOSE dirs).
 *
 * The lift is to the first path segment under the agent's data root, i.e. the level where
 * upstream groups sessions; it is a pure path operation, so a store outside the data root
 * (an external worktree, §4.4 row 7) keeps its own common dir.
 */
export function sessionStoreRoot(paths: readonly string[], dataRoot: string | null): string | null {
  const common = commonStoreDir(paths)
  if (!common) return null
  if (!dataRoot) return common
  const root = dataRoot.endsWith(sep) ? dataRoot.slice(0, -1) : dataRoot
  const rel = relative(root, common)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return common
  const [group] = rel.split(sep)
  return group ? join(root, group) : common
}

export interface StoreSurvey {
  storeDir: string
  access: Access
  /** First-level directories of the store: one per project (claude) / date (codex). */
  dirs: number
  /** Of those, the ones that exist but hold no session file (§4.4 row 4). */
  emptyDirs: string[]
  files: number
  bytes: number
  unreadableDirs: string[]
}

const MAX_WALK_DEPTH = 3

async function countSessionFiles(dir: string, ext: string, depth: number, acc: { files: number; bytes: number }): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // vanished or unreadable mid-survey: counted by unreadableDirs below
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (depth > 0) await countSessionFiles(full, ext, depth - 1, acc)
    } else if (ent.isFile() && ent.name.endsWith(ext)) {
      acc.files += 1
      acc.bytes += (await stat(full).catch(() => null))?.size ?? 0
    }
  }
}

/**
 * Survey a session store for the coverage question §4.4 row 4 asks: upstream retention
 * deletes history silently, so "we scanned everything" is false until this says otherwise.
 * A directory counts as a project/thread dir only at the first level, because that is the
 * level at which the upstream tools group sessions.
 */
export async function surveySessionStore(storeDir: string, ext: string): Promise<StoreSurvey> {
  const access = accessOf(storeDir)
  const emptyDirs: string[] = []
  const unreadableDirs: string[] = []
  let files = 0
  let bytes = 0
  if (access !== 'readable') return { storeDir, access, dirs: 0, emptyDirs, files, bytes, unreadableDirs }

  let dirs: string[] = []
  try {
    const entries = await readdir(storeDir, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      const full = join(storeDir, ent.name)
      if (!ent.isDirectory()) continue
      dirs.push(full)
      if (accessOf(full) === 'unreadable') unreadableDirs.push(full)
    }
    dirs = dirs.sort()
  } catch (err) {
    return { storeDir, access: 'unreadable', dirs: 0, emptyDirs, files, bytes, unreadableDirs: [`${storeDir}: ${(err as Error).message}`] }
  }

  const top = { files: 0, bytes: 0 }
  await countSessionFiles(storeDir, ext, 0, top) // a store whose sessions are not grouped in dirs at all
  files += top.files
  bytes += top.bytes
  for (const dir of dirs) {
    const acc = { files: 0, bytes: 0 }
    await countSessionFiles(dir, ext, MAX_WALK_DEPTH, acc)
    if (acc.files === 0) emptyDirs.push(dir)
    files += acc.files
    bytes += acc.bytes
  }
  return { storeDir, access, dirs: dirs.length, emptyDirs, files, bytes, unreadableDirs }
}

/** One line of an agent's history index (§4.4 row 4's session-existence rescue source). */
export interface HistoryEntry {
  sessionId: string
  timestamp: number | null
}

export interface HistoryIndex {
  path: string
  access: Access
  entries: HistoryEntry[]
  /** Lines that are not JSON or carry no sessionId: the index itself is drifting (§5.3). */
  malformed: number
  error: string | null
}

/**
 * Read a `history.jsonl`-shaped index (`{display, timestamp, project, sessionId}` per line).
 * Only the session ids and timestamps are kept: `display`/`project` are user content and
 * user paths, and this section reports counts, not transcripts.
 */
export async function readHistoryIndex(path: string): Promise<HistoryIndex> {
  const access = accessOf(path)
  if (access !== 'readable') {
    return { path, access, entries: [], malformed: 0, error: access === 'missing' ? 'no history index' : 'not readable' }
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    return { path, access: 'unreadable', entries: [], malformed: 0, error: (err as Error).message }
  }
  const entries: HistoryEntry[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      malformed += 1
      continue
    }
    const rec = (parsed ?? {}) as Record<string, unknown>
    const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : null
    if (!sessionId) {
      malformed += 1
      continue
    }
    entries.push({ sessionId, timestamp: typeof rec.timestamp === 'number' ? rec.timestamp : null })
  }
  return { path, access, entries, malformed, error: null }
}

export interface SqliteProbe {
  path: string
  access: Access
  isSqlite: boolean
  /** WAL per the header: a third-party store in this mode is REFUSED, never opened (§18 row 7). */
  wal: boolean
  /** `-wal`/`-shm` present ⇒ a live writer owns the store. */
  sidecars: string[]
  error: string | null
}

const HEADER_BYTES = 100

/** Header-only sniff of a foreign SQLite file. Side-effect free by construction: `O_RDONLY`, no create. */
export function probeSqlite(path: string): SqliteProbe {
  const sidecars = [`${path}-wal`, `${path}-shm`].filter((p) => existsSync(p))
  const access = accessOf(path)
  if (access !== 'readable') {
    return { path, access, isSqlite: false, wal: false, sidecars, error: describeAccess(access) }
  }
  let fd = -1
  try {
    const buf = Buffer.alloc(HEADER_BYTES)
    fd = openSync(path, 'r')
    const read = readSync(fd, buf, 0, HEADER_BYTES, 0)
    const isSqlite = read >= 20 && buf.subarray(0, 15).toString('utf8') === 'SQLite format 3'
    const wal = isSqlite && buf[18] === 2 && buf[19] === 2
    return { path, access, isSqlite, wal, sidecars, error: isSqlite ? null : 'header is not a SQLite database' }
  } catch (err) {
    return { path, access, isSqlite: false, wal: false, sidecars, error: (err as Error).message }
  } finally {
    if (fd !== -1) closeSync(fd)
  }
}

/** Why a SQLite source will not be read, in the §11 wording; null when it is fine. */
export function sqliteRefusal(probe: SqliteProbe): string | null {
  if (probe.access === 'missing') return 'source file no longer exists'
  if (probe.access === 'unreadable') return 'file not readable'
  if (!probe.isSqlite) return probe.error
  if (probe.wal) return 'WAL mode: refused to open, a read-only open still writes -wal/-shm (§18 row 7)'
  return null
}
