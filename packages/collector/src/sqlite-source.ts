/**
 * SQLite store guard (docs/plan-v2.md §4.3/§18 row 7). The collector never opens a
 * foreign database: framing is the adapter's `parse` (§5.1), and this module only
 * answers "may anybody read this store directly" — a WAL store is snapshotted first
 * (`sqlite-snapshot.ts`) or refused.
 */
import { openSync, readSync, closeSync } from 'node:fs'

const SQLITE_MAGIC = 'SQLite format 3\0'

/**
 * Journal mode straight from the header, without a connection. Bytes 18/19 are the
 * write/read format versions, and `2` means WAL.
 */
export function journalModeOf(dbPath: string): 'wal' | 'rollback' | 'not-a-database' {
  // Anything this cannot read is reported as "not a database" rather than an error: opening
  // the file is the caller's job, and only it can produce a meaningful cantopen message.
  let fd: number
  try {
    fd = openSync(dbPath, 'r')
  } catch {
    return 'not-a-database'
  }
  try {
    const head = Buffer.alloc(24)
    const read = readSync(fd, head, 0, 24, 0)
    if (read < 24 || head.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) return 'not-a-database'
    return head[18] === 2 || head[19] === 2 ? 'wal' : 'rollback'
  } catch {
    return 'not-a-database'
  } finally {
    closeSync(fd)
  }
}

/** Thrown instead of opening a WAL store, whose sidecars a read-only open can still create. */
export class WalModeRefusedError extends Error {
  constructor(dbPath: string) {
    super(
      `refusing to open "${dbPath}": it is in WAL mode, and even a read-only connection can create or replay its -wal/-shm sidecars (§18 row 7). Read that agent through its own export or JSONL channel instead.`,
    )
    this.name = 'WalModeRefusedError'
  }
}
