/**
 * §18 row 7 / research §二: the SQLite half of this adapter may look at the database and
 * must not touch it. The fixtures are synthetic files with a hand-written SQLite header,
 * so these assertions cover the real store's shape without a live one being nearby.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SQLITE_DIAGNOSTIC_SCHEMA,
  WAL_REASON,
  diagnoseSqliteSource,
  readSqliteJournalMode,
  sidecarPaths,
  sqliteDiagnostics,
} from '../src/sqlite.ts'
import { FIXTURES_DIR, HOST_DIR, hostCtx } from './helpers.ts'

const FIX = FIXTURES_DIR
const HOST = HOST_DIR

describe('readSqliteJournalMode (§二)', () => {
  it('reads WAL out of the file header, not a connection', async () => {
    const path = join(HOST, 'workbuddy.db')
    expect(await readSqliteJournalMode(path)).toBe('wal')
    // Header bytes 18/19 are the format read/write versions; a 2 there is the WAL flag.
    expect(await readSqliteJournalMode(join(FIX, 'host-journal', 'workbuddy.db'))).toBe('journal')
  })

  it('a file without the SQLite magic is not a database and a short file is not a header', async () => {
    expect(await readSqliteJournalMode(join(HOST, 'edge-map.db'))).toBe('not-a-database')
    expect(await readSqliteJournalMode(join(HOST, 'projects', 'trace-a.jsonl'))).toBe('not-a-database')
    expect(await readSqliteJournalMode(join(FIX, 'nope.db'))).toBe('unreadable')
  })
})

describe('sqlite source refusal (§5.2 rule 3)', () => {
  it('a WAL store is discovered, diagnosed and never opened', async () => {
    const d = await diagnoseSqliteSource(join(HOST, 'workbuddy.db'))
    expect(d).toMatchObject({
      schema: SQLITE_DIAGNOSTIC_SCHEMA,
      kind: 'sqlite',
      discovered: true,
      opened: false,
      refused: true,
      journalMode: 'wal',
      code: 'sqlite_wal_sidecar_risk',
      severity: 'warn',
    })
    expect(d.message).toContain(WAL_REASON)
    // §五: this is a "cannot read", not a "does not exist" — the gap is named, not filled.
    expect(d.missingEvidence).toContain('session_usage.token_columns')
    expect(d.missingEvidence).toContain('session_usage.cache_columns')
    expect(d.missingEvidence).toContain('session_usage.cost_columns')
    expect(d.sidecars).toEqual({ wal: false, shm: false })
  })

  it('an already-materialised WAL sidecar does not license opening', async () => {
    // Stricter than "safe if the app already made the sidecars": their presence is not
    // proof of who owns them, and this adapter has no reason to read the store at all.
    const d = await diagnoseSqliteSource(join(FIX, 'host-wal-sidecar', 'workbuddy.db'))
    expect(d.journalMode).toBe('wal')
    expect(d.sidecars).toEqual({ wal: true, shm: true })
    expect(d.refused).toBe(true)
    expect(d.code).toBe('sqlite_wal_sidecar_risk')
  })

  it('a non-WAL store is still refused for the unverified column names', async () => {
    const d = await diagnoseSqliteSource(join(FIX, 'host-journal', 'workbuddy.db'))
    expect(d.journalMode).toBe('journal')
    expect(d.refused).toBe(true)
    expect(d.opened).toBe(false)
    expect(d.code).toBe('sqlite_column_mapping_unverified')
    expect(d.missingEvidence).toContain('session_usage.token_columns')
  })

  it('no store at all is reported as absent, not as an error', async () => {
    const d = await diagnoseSqliteSource(join(FIX, 'host-empty', 'workbuddy.db'))
    expect(d.discovered).toBe(false)
    expect(d.refused).toBe(false)
    expect(d.code).toBe('sqlite_absent')
    expect(d.opened).toBe(false)
  })

  it('the data root is listed, never opened: every top-level *.db gets its own verdict', async () => {
    const ds = await sqliteDiagnostics(hostCtx({ dataRoot: HOST, homedir: HOST }))
    expect(ds.map((d) => d.path)).toEqual([join(HOST, 'edge-map.db'), join(HOST, 'workbuddy.db')])
    expect(ds.map((d) => d.code)).toEqual(['sqlite_not_a_database', 'sqlite_wal_sidecar_risk'])
    for (const d of ds) expect(d.opened).toBe(false)
  })

  it('the check leaves no sidecar behind — the incident this rule exists to prevent', async () => {
    const before = await sqliteDiagnostics(hostCtx({ dataRoot: HOST, homedir: HOST }))
    for (const d of before) {
      const { wal, shm } = sidecarPaths(d.path)
      expect(await readSqliteJournalMode(wal)).toBe('unreadable')
      expect(await readSqliteJournalMode(shm)).toBe('unreadable')
    }
  })
})
