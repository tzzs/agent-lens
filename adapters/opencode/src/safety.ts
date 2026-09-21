/**
 * §18 row 7 (hard safety rule, outranks completeness): opening a *third-party*
 * SQLite file is only safe when a read-only connection provably cannot create
 * `-wal`/`-shm` siblings. WorkBuddy's WAL store did exactly that; OpenCode's does
 * not, because its WAL machinery is already materialised by the running app.
 *
 * Journal mode is read from the file header (bytes 18/19) instead of
 * `PRAGMA journal_mode`: the header needs no SQLite connection at all, so the
 * check itself is guaranteed side-effect free.
 */
import { open, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

export const WAL_REASON = 'skipped: WAL sidecar risk'

export interface ReadOnlyAssessment {
  /** False ⇒ the caller must not open this file at all. */
  safe: boolean
  journalMode: 'wal' | 'journal' | 'unknown'
  walSidecar: boolean
  shmSidecar: boolean
  reason: string | null
}

/** WAL/SHM sibling names for a database path. */
export function sidecarPaths(dbPath: string): { wal: string; shm: string } {
  return { wal: `${dbPath}-wal`, shm: `${dbPath}-shm` }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)) !== null
  } catch {
    return false
  }
}

/** Header read only: bytes 18 (read) / 19 (write) format versions are 2 for WAL. */
export async function readJournalMode(dbPath: string): Promise<'wal' | 'journal' | 'unknown'> {
  let fh
  try {
    fh = await open(dbPath, 'r')
    const buf = Buffer.alloc(100)
    const { bytesRead } = await fh.read(buf, 0, 100, 0)
    if (bytesRead < 20) return 'unknown'
    return buf[18] === 2 || buf[19] === 2 ? 'wal' : 'journal'
  } catch {
    return 'unknown'
  } finally {
    await fh?.close()
  }
}

export async function assessReadOnly(dbPath: string): Promise<ReadOnlyAssessment> {
  const { wal, shm } = sidecarPaths(dbPath)
  const [walSidecar, shmSidecar] = await Promise.all([exists(wal), exists(shm)])
  const journalMode = await readJournalMode(dbPath)
  if (journalMode !== 'wal') {
    return { safe: true, journalMode, walSidecar, shmSidecar, reason: null }
  }
  // WHY: with both siblings already on disk the WAL index exists and is owned by
  // the app, so our read can only attach to it. If either is missing, opening is
  // what creates it — that is the WorkBuddy side-effect, so we refuse instead.
  if (walSidecar && shmSidecar) {
    return { safe: true, journalMode, walSidecar, shmSidecar, reason: null }
  }
  return { safe: false, journalMode, walSidecar, shmSidecar, reason: WAL_REASON }
}

/** Raised when a read-only open turned out to create a sidecar anyway (never ignored). */
export class SidecarCreatedError extends Error {
  override readonly name = 'SidecarCreatedError'
  constructor(dbPath: string, created: string[]) {
    super(`read-only open of ${dbPath} created ${created.join(', ')}; refusing further access`)
  }
}

export interface ReadOnlyHandle {
  db: DatabaseSync
  /** Must run after `db.close()`: turns a violated read-only assumption into an error. */
  verifyNoSidecars(): Promise<void>
}

/** Opens strictly read-only, refusing WAL stores whose sidecars we would create. */
export async function openReadOnly(dbPath: string): Promise<ReadOnlyHandle> {
  const assessment = await assessReadOnly(dbPath)
  if (!assessment.safe) throw new Error(`${WAL_REASON} (${dbPath})`)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  } catch (err) {
    if (/read[-_]?only|open mode|not supported|invalid argument/i.test(String(err))) {
      throw new Error(`opencode: node:sqlite cannot open ${dbPath} read-only (${String(err)})`)
    }
    throw err
  }
  return {
    db,
    async verifyNoSidecars() {
      const { wal, shm } = sidecarPaths(dbPath)
      const created: string[] = []
      for (const [path, existedBefore] of [
        [wal, assessment.walSidecar],
        [shm, assessment.shmSidecar],
      ] as const) {
        if (!existedBefore && (await exists(path))) created.push(path)
      }
      if (created.length > 0) throw new SidecarCreatedError(dbPath, created)
    },
  }
}

/**
 * Runs a synchronous `fn` against a strictly read-only connection and re-checks
 * the sibling inventory afterwards, so a violated assumption surfaces as an error
 * instead of a silent write into someone else's data directory.
 */
export async function withReadOnlyDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): Promise<T> {
  const handle = await openReadOnly(dbPath)
  try {
    return fn(handle.db)
  } finally {
    handle.db.close()
    await handle.verifyNoSidecars()
  }
}
