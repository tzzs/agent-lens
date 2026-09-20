/**
 * SQLite incremental reader (docs/plan-v2.md §4.3): byte offsets are useless
 * for SQLite-backed agents, so the high-water mark is the max rowid consumed.
 *
 * The connection is opened strictly read-only (§5.2 rule 3): these databases
 * belong to running apps (Qoder) and a write lock from us would break them.
 */
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
