/**
 * §18 row 7 (hard safety rule, outranks completeness), honored exactly as
 * `adapters/opencode/src/safety.ts` does: opening a *third-party* SQLite file is only
 * safe when a read-only connection provably cannot touch `-wal`/`-shm`.
 *
 * ZCode's store is WAL on this machine (`db.sqlite` 30.0MB, `-wal` 0B, `-shm` 32KB),
 * and both hazards WorkBuddy and OpenCode measured apply: a read-only attach against a
 * WAL store either CREATES the siblings where the app had none or REWRITES the app's own
 * `-shm`. Either is a write into someone else's data directory, so WAL ⇒ refuse.
 *
 * Journal mode comes from the file header (bytes 18/19) rather than `PRAGMA journal_mode`,
 * because the header needs no SQLite connection at all: the check itself is side-effect
 * free by construction. The live store is reached anyway — as a rollback-mode copy the
 * collector made of it — through `ParseCtx.storePath` (§18 row 7, zcode.md §一).
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
  /**
   * Sibling inventory at decision time, size and mtime included. `verifyNoSidecars`
   * compares against this rather than mere existence: an attach that leaves a WAL
   * store's `-shm` in place but rewrites it is exactly the write this rule forbids.
   */
  sidecars: SidecarStat[]
}

export interface SidecarStat {
  path: string
  existed: boolean
  size: number
  mtimeMs: number
}

/** WAL/SHM sibling names for a database path. */
export function sidecarPaths(dbPath: string): { wal: string; shm: string } {
  return { wal: `${dbPath}-wal`, shm: `${dbPath}-shm` }
}

async function statSidecar(path: string): Promise<SidecarStat> {
  try {
    const s = await stat(path)
    return { path, existed: true, size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return { path, existed: false, size: 0, mtimeMs: 0 }
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
  const sidecars = await Promise.all([statSidecar(wal), statSidecar(shm)])
  const [walStat, shmStat] = sidecars
  const journalMode = await readJournalMode(dbPath)
  if (journalMode !== 'wal') {
    return { safe: true, journalMode, walSidecar: walStat.existed, shmSidecar: shmStat.existed, sidecars, reason: null }
  }
  // WHY unconditionally: with both siblings already on disk the WAL index belongs to the
  // app and attaching is what rewrites it; with either missing, attaching is what creates
  // it. Both are writes into someone else's data directory, so neither is licensed by the
  // other, and the collector applies the same rule in `journalModeOf`.
  return { safe: false, journalMode, walSidecar: walStat.existed, shmSidecar: shmStat.existed, sidecars, reason: WAL_REASON }
}

/** Raised when a read-only open turned out to touch a sidecar anyway (never ignored). */
export class SidecarCreatedError extends Error {
  override readonly name = 'SidecarCreatedError'
  constructor(dbPath: string, created: string[]) {
    super(`read-only open of ${dbPath} touched ${created.join(', ')}; refusing further access`)
  }
}

export interface ReadOnlyHandle {
  db: DatabaseSync
  /** Must run after `db.close()`: turns a violated read-only assumption into an error. */
  verifyNoSidecars(): Promise<void>
}

/** Opens strictly read-only, refusing every WAL store whose `-shm` an attach would create or rewrite. */
export async function openReadOnly(dbPath: string): Promise<ReadOnlyHandle> {
  const assessment = await assessReadOnly(dbPath)
  if (!assessment.safe) throw new Error(`${WAL_REASON} (${dbPath})`)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  } catch (err) {
    if (/read[-_]?only|open mode|not supported|invalid argument/i.test(String(err))) {
      throw new Error(`zcode: node:sqlite cannot open ${dbPath} read-only (${String(err)})`)
    }
    throw err
  }
  return {
    db,
    async verifyNoSidecars() {
      const touched: string[] = []
      for (const before of assessment.sidecars) {
        const now = await statSidecar(before.path)
        if (!before.existed && now.existed) touched.push(`${now.path} (created)`)
        else if (before.existed && (now.size !== before.size || now.mtimeMs !== before.mtimeMs)) {
          touched.push(`${now.path} (rewritten)`)
        }
      }
      if (touched.length > 0) throw new SidecarCreatedError(dbPath, touched)
    },
  }
}

/**
 * Runs a synchronous `fn` against a strictly read-only connection and re-checks the
 * sibling inventory afterwards, so a violated assumption surfaces as an error instead of
 * a silent write into the ZCode data directory.
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
