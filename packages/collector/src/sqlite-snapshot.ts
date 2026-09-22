/**
 * WAL-store snapshots (docs/plan-v2.md §18 row 7): copying is not opening.
 *
 * A read-only attach to a foreign WAL database still creates or rewrites the app's
 * own `-shm` — a write into someone else's data directory — so the collector must
 * never connect to such a store. It may, however, copy it: `fs.copyFile` and `stat`
 * are all this module touches on the foreign side. The copy lands in OUR directory,
 * gets its WAL folded into a plain rollback-mode single file (a read-write open is
 * allowed on a file we own), and every later reader — adapter `parse` included, via
 * `ParseCtx.storePath` — sees an ordinary database.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { journalModeOf } from './sqlite-source.ts'

/** Thrown when the store moved while we copied it; the scan makes no claims and retries later. */
export class SnapshotError extends Error {
  constructor(dbPath: string) {
    super(`snapshot of "${dbPath}" kept catching the store mid-write; nothing was ingested from it, this scan will retry`,)
    this.name = 'SnapshotError'
  }
}

export interface WalSnapshotOptions {
  /** Our directory for copies — never next to the foreign store. */
  dir: string
}

/** Injectable for tests; defaults touch the real fs. Only `copyFile` + `stat` ever touch `dbPath`. */
export interface SnapshotDeps {
  copyFileSync(from: string, to: string): void
  statSync(path: string): { size: number; mtimeMs: number }
}

/**
 * Where a store's copy lives. The stem is a digest of the path, so it is a single safe
 * filename component (no `..`, no separators) and one database yields one copy.
 */
export function snapshotPathFor(dbPath: string, dir: string): string {
  return join(dir, `${createHash('sha256').update(dbPath).digest('hex')}.snapshot.db`)
}

/** db size+mtime plus optional -wal size+mtime: cheap, and any committed write moves one of them. */
function signatureOf(dbPath: string, deps: SnapshotDeps): string {
  const parts: string[] = []
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      const s = deps.statSync(p)
      parts.push(`${s.size}:${s.mtimeMs}`)
    } catch {
      parts.push('-')
    }
  }
  return parts.join('|')
}

/**
 * Copy a WAL store (and its `-wal`, never its `-shm` — SQLite rebuilds that one) into
 * `dir`, fold it to a sidecar-free rollback-mode file, and return the copy's path.
 * The store's signature is cached in `{copy}.sig`: the store is append-only from our
 * point of view, so an unchanged signature cannot hide new rows (watch re-scans every
 * few seconds against a database that can be tens of MB).
 *
 * The copy is named after the store, not the source: several `sources` rows can point
 * at one database (OpenCode has three), and each source reads a different table from
 * the same folded file rather than paying for another multi-megabyte copy.
 */
export function snapshotWalStore(
  dbPath: string,
  opts: WalSnapshotOptions,
  deps: SnapshotDeps = { copyFileSync, statSync },
): string {
  mkdirSync(opts.dir, { recursive: true })
  // A digest keeps the filename inside `dir` whatever the path contains, and is stable
  // across renames of our own directory.
  const copyPath = join(opts.dir, `${createHash('sha256').update(dbPath).digest('hex')}.snapshot.db`)
  const sigPath = `${copyPath}.sig`
  const live = signatureOf(dbPath, deps)
  if (existsSync(copyPath) && existsSync(sigPath) && readFileSync(sigPath, 'utf8') === live) {
    return copyPath // cache hit: nothing new can be in a store that did not move
  }
  // Two attempts: a torn copy is retried once (the second signature pair is usually
  // stable now), and a second tear means the store is too busy to read this scan.
  for (let attempt = 0; attempt < 2; attempt++) {
    rmSync(copyPath, { force: true })
    rmSync(`${copyPath}-wal`, { force: true })
    rmSync(`${copyPath}-shm`, { force: true })
    const before = signatureOf(dbPath, deps)
    deps.copyFileSync(dbPath, copyPath)
    if (existsSync(`${dbPath}-wal`)) deps.copyFileSync(`${dbPath}-wal`, `${copyPath}-wal`)
    const after = signatureOf(dbPath, deps)
    if (before !== after) continue
    foldToRollback(copyPath)
    writeFileSync(sigPath, after)
    return copyPath
  }
  throw new SnapshotError(dbPath)
}

/** Replay the copied WAL into the file and drop the sidecars: later readers see a plain db. */
function foldToRollback(copyPath: string): void {
  // Read-write is allowed here because this file is ours, in our directory — the exact
  // opposite of the foreign store it was copied from (§18 row 7).
  const db = new DatabaseSync(copyPath)
  try {
    db.exec('PRAGMA journal_mode = DELETE')
  } finally {
    db.close()
  }
  rmSync(`${copyPath}-wal`, { force: true })
  rmSync(`${copyPath}-shm`, { force: true })
  if (journalModeOf(copyPath) === 'wal') {
    throw new Error(`snapshotWalStore: fold to rollback mode failed for ${copyPath}`)
  }
}
