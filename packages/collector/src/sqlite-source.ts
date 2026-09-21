/**
 * SQLite incremental reader (docs/plan-v2.md §4.3): byte offsets are useless
 * for SQLite-backed agents, so the high-water mark is the max rowid consumed.
 *
 * The connection is opened strictly read-only (§5.2 rule 3): these databases
 * belong to running apps (Qoder) and a write lock from us would break them.
 */
import { openSync, readSync, closeSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export interface SqliteIncrementalOptions {
  table: string
  rowidColumn: string
  column: string
  fromRowid: number
  /** Safety valve so one scan cannot pin an unbounded amount of memory. */
  maxRows?: number
}

export interface SqliteRow {
  rowid: number
  value: string
}

export interface SqliteChunk {
  rows: SqliteRow[]
  /** New high-water rowid (== fromRowid when no rows were read). */
  nextRowid: number
  /** True when `maxRows` cut the batch short; resume from nextRowid. */
  truncated: boolean
}

/** Thrown instead of ever opening another app's database read-write. */
export class ReadOnlyUnsupportedError extends Error {
  constructor(dbPath: string, cause: unknown) {
    super(
      `node:sqlite cannot open "${dbPath}" read-only; refusing a read-write open of a foreign database. Node ${process.version}: ${String(cause)}`,
      { cause },
    )
    this.name = 'ReadOnlyUnsupportedError'
  }
}

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

// SQLite identifiers are not parameterizable; quoting alone does not make
// arbitrary strings safe, so restrict to plain names.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function readSqliteIncremental(dbPath: string, opts: SqliteIncrementalOptions): SqliteChunk {
  for (const [label, name] of [
    ['table', opts.table],
    ['rowidColumn', opts.rowidColumn],
    ['column', opts.column],
  ] as const) {
    if (!IDENT.test(name)) {
      throw new Error(`readSqliteIncremental: invalid ${label} name ${JSON.stringify(name)}`)
    }
  }
  if (journalModeOf(dbPath) === 'wal') throw new WalModeRefusedError(dbPath)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  } catch (err) {
    // A genuinely unreadable file should surface as-is; only mode-related
    // failures mean this Node build cannot honor read-only.
    if (/read[-_]?only|open mode|not supported|invalid argument/i.test(String(err))) {
      throw new ReadOnlyUnsupportedError(dbPath, err)
    }
    throw err
  }
  try {
    const limit = opts.maxRows !== undefined ? ` LIMIT ${Math.max(0, Math.floor(opts.maxRows))}` : ''
    const sql =
      `SELECT "${opts.rowidColumn}" AS __rowid, "${opts.column}" AS __value` +
      ` FROM "${opts.table}" WHERE "${opts.rowidColumn}" > ? ORDER BY "${opts.rowidColumn}" ASC${limit}`
    const rows: SqliteRow[] = []
    let nextRowid = opts.fromRowid
    for (const raw of db.prepare(sql).iterate(opts.fromRowid)) {
      const rowid = Number(raw.__rowid)
      rows.push({ rowid, value: toText(raw.__value) })
      nextRowid = rowid
    }
    return { rows, nextRowid, truncated: opts.maxRows !== undefined && rows.length >= opts.maxRows }
  } finally {
    db.close()
  }
}

function toText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8')
  return String(v)
}
