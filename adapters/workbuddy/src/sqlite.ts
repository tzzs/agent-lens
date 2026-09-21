/**
 * §18 row 7 / docs/research/workbuddy.md §二 — the hard safety rule for this adapter.
 *
 * `workbuddy.db` is a WAL-mode SQLite store. Measured on the live machine: opening it
 * with `new DatabaseSync(path, { open: true, readOnly: true })` — a pure read of
 * `sqlite_master` — CREATED `workbuddy.db-wal` and `workbuddy.db-shm` in the user's
 * data directory. Read-only is not a side-effect-free mode against a WAL database:
 * SQLite has to materialise the shared-memory index, and it does so wherever the
 * directory is writable. That is a write into another application's store, so this
 * adapter never opens the file.
 *
 * The journal mode is therefore read from the 100-byte SQLite header with `node:fs`
 * instead: bytes 18 and 19 are the file-format read/write version numbers and a value
 * of 2 means WAL. A plain `open(path, 'r')` + `read()` cannot create or modify any
 * sibling file, so the guard itself is side-effect free by construction.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostContext } from '@agentlens/event-model'
import { dbPathOf, rootOf } from './paths.ts'

/** SQLite's magic prefix: `SQLite format 3\0`. */
const SQLITE_MAGIC = 'SQLite format 3\0'
/** File format read/write version offsets in the database header (§4.3 of the SQLite file format). */
const READ_VERSION_OFFSET = 18
const WRITE_VERSION_OFFSET = 19
const WAL_VERSION = 2
const HEADER_BYTES = 100

export type JournalMode = 'wal' | 'journal' | 'not-a-database' | 'unreadable'

export const SQLITE_DIAGNOSTIC_SCHEMA = 'agentlens.workbuddy.sqlite-diagnostic/v1' as const

/** Stable reason string for the WAL refusal, so doctor output stays greppable across revisions. */
export const WAL_REASON = 'skipped: WAL sidecar risk'

/** Stable, machine-readable refusal codes so `agentlens doctor` (§11) can group on them. */
export type SqliteRefusalCode =
  /** No `workbuddy.db` under the data root: nothing to collect, nothing refused. */
  | 'sqlite_absent'
  /** WAL header ⇒ any connection, even read-only, would create `-wal`/`-shm`. Never opened. */
  | 'sqlite_wal_sidecar_risk'
  /** Non-WAL header, so opening would be safe — but the token/cache column names were never measured. */
  | 'sqlite_column_mapping_unverified'
  /** The header could not be read (permissions, truncation, race with the app). */
  | 'sqlite_header_unreadable'
  /** A `*.db` sibling we did not expect and will not guess a schema for. */
  | 'sqlite_not_a_database'

export interface SqliteSourceDiagnostic {
  schema: typeof SQLITE_DIAGNOSTIC_SCHEMA
  kind: 'sqlite'
  path: string
  discovered: boolean
  /** Always false: this adapter never opens a database file. */
  opened: false
  journalMode: JournalMode
  sidecars: { wal: boolean; shm: boolean }
  refused: boolean
  code: SqliteRefusalCode
  severity: 'info' | 'warn'
  message: string
  /** Evidence a later parser still needs; surfaced verbatim by doctor. */
  missingEvidence: string[]
}

/** WAL/SHM sibling names for a database path. */
export function sidecarPaths(dbPath: string): { wal: string; shm: string } {
  return { wal: `${dbPath}-wal`, shm: `${dbPath}-shm` }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Reads the journal mode straight from the file header. Zero side effects by design:
 * one read-only `open`, one 100-byte pread, close — no SQLite connection is created,
 * so no `-wal`/`-shm` mapping can appear (contrast §二, where a read-only connection did).
 */
export async function readSqliteJournalMode(dbPath: string): Promise<JournalMode> {
  let handle
  try {
    handle = await open(dbPath, 'r')
  } catch {
    return 'unreadable'
  }
  try {
    const buf = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0)
    if (bytesRead < HEADER_BYTES) return 'unreadable'
    if (buf.subarray(0, SQLITE_MAGIC.length).toString('utf8') !== SQLITE_MAGIC) return 'not-a-database'
    const wal = buf[READ_VERSION_OFFSET] === WAL_VERSION || buf[WRITE_VERSION_OFFSET] === WAL_VERSION
    return wal ? 'wal' : 'journal'
  } catch {
    return 'unreadable'
  } finally {
    await handle.close()
  }
}

function diagnosticBase(dbPath: string): Pick<SqliteSourceDiagnostic, 'path' | 'journalMode' | 'sidecars'> {
  return { path: dbPath, journalMode: 'unreadable', sidecars: { wal: false, shm: false } }
}

/**
 * (a) Discovers the primary store, (b) refuses to open it, and (c) explains itself in a
 * machine-readable shape for doctor. This is the SQLite half of §5.1 `discover` without
 * a `SourceSpec`: yielding `kind: 'sqlite'` would hand the collector's
 * `readSqliteIncremental` a path and open it with `node:sqlite` — the exact side effect
 * §18 row 7 forbids. Until a WAL-aware guard exists at that layer, a WAL store must not
 * be advertised as a source at all (see the report note in index.ts).
 */
export async function assessSqliteSource(
  dbPath: string,
  journalMode: JournalMode,
  sidecars: { wal: boolean; shm: boolean },
): Promise<SqliteSourceDiagnostic> {
  const base = { path: dbPath, journalMode, sidecars }
  if (journalMode === 'unreadable') {
    return {
      schema: SQLITE_DIAGNOSTIC_SCHEMA,
      kind: 'sqlite',
      ...base,
      discovered: await exists(dbPath),
      opened: false,
      refused: true,
      code: 'sqlite_header_unreadable',
      severity: 'warn',
      message: `could not read the SQLite header of ${dbPath}; refusing to open it`,
      missingEvidence: ['database_header'],
    }
  }
  if (journalMode === 'not-a-database') {
    return {
      schema: SQLITE_DIAGNOSTIC_SCHEMA,
      kind: 'sqlite',
      ...base,
      discovered: true,
      opened: false,
      refused: true,
      code: 'sqlite_not_a_database',
      severity: 'info',
      message: `${dbPath} is not a SQLite database file; skipped`,
      missingEvidence: [],
    }
  }
  if (journalMode === 'wal') {
    return {
      schema: SQLITE_DIAGNOSTIC_SCHEMA,
      kind: 'sqlite',
      ...base,
      discovered: true,
      opened: false,
      refused: true,
      code: 'sqlite_wal_sidecar_risk',
      severity: 'warn',
      // §二: measured — a read-only open created both siblings while neither existed before.
      message: `${WAL_REASON} — a read-only connection creates -wal/-shm sidecars in the app data directory (§18 row 7); collecting via the JSONL trace source instead`,
      missingEvidence: [
        'session_usage.token_columns',
        'session_usage.cache_columns',
        'session_usage.cost_columns',
        'sessions.project_id.canonicality',
      ],
    }
  }
  return {
    schema: SQLITE_DIAGNOSTIC_SCHEMA,
    kind: 'sqlite',
    ...base,
    discovered: true,
    opened: false,
    refused: true,
    code: 'sqlite_column_mapping_unverified',
    severity: 'warn',
    message:
      'non-WAL store would be safe to open, but session_usage token/cache column names are unmeasured (docs/research/workbuddy.md §五); refusing to guess a mapping',
    missingEvidence: [
      'session_usage.token_columns',
      'session_usage.cache_columns',
      'session_usage.cost_columns',
      'sessions.project_id.canonicality',
    ],
  }
}

/** Full assessment of the primary store: header read + sibling inventory, no connection. */
export async function diagnoseSqliteSource(dbPath: string): Promise<SqliteSourceDiagnostic> {
  const present = await exists(dbPath)
  if (!present) {
    return {
      schema: SQLITE_DIAGNOSTIC_SCHEMA,
      kind: 'sqlite',
      ...diagnosticBase(dbPath),
      journalMode: 'unreadable',
      discovered: false,
      opened: false,
      refused: false,
      code: 'sqlite_absent',
      severity: 'info',
      message: `no SQLite store at ${dbPath}`,
      missingEvidence: [],
    }
  }
  const { wal, shm } = sidecarPaths(dbPath)
  const [journalMode, walSeen, shmSeen] = await Promise.all([
    readSqliteJournalMode(dbPath),
    exists(wal),
    exists(shm),
  ])
  return assessSqliteSource(dbPath, journalMode, { wal: walSeen, shm: shmSeen })
}

/**
 * The primary store plus any other top-level `*.db` under the data root. Listing is a
 * directory read; nothing is opened. Nested roots are skipped on purpose — the probe
 * counted 6,289 files under `~/.workbuddy`, and a recursive hunt for databases is how a
 * future refactor ends up connected to one.
 */
export async function sqliteDiagnostics(ctx: HostContext): Promise<SqliteSourceDiagnostic[]> {
  const root = rootOf(ctx)
  const primary = dbPathOf(ctx)
  const candidates = new Set<string>([primary])
  try {
    for (const name of await readdir(root)) {
      if (name.endsWith('.db')) candidates.add(join(root, name))
    }
  } catch {
    /* an unreadable root still leaves the conventional primary-store path to assess */
  }
  const out: SqliteSourceDiagnostic[] = []
  for (const path of [...candidates].sort()) {
    let isFile = true
    try {
      isFile = (await stat(path)).isFile()
    } catch {
      isFile = false
    }
    // The absent primary store is still reported, because "no database found" is a fact
    // doctor should show; a stale `*.db` listing entry is not.
    if (!isFile && path !== primary) continue
    out.push(await diagnoseSqliteSource(path))
  }
  return out
}
