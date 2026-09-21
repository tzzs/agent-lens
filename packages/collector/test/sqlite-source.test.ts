import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ReadOnlyUnsupportedError, WalModeRefusedError, journalModeOf, readSqliteIncremental } from '../src/sqlite-source.ts'

let currentTmp: string | null = null
let dir: string = ''

function makeDb(name: string): { path: string; db: DatabaseSync } {
  const dbPath = join(dir, name)
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE messages (payload TEXT)')
  return { path: dbPath, db }
}

async function tmpDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'collector-sql-'))
  currentTmp = dir
  return dir
}

afterEach(async () => {
  if (currentTmp) await rm(currentTmp, { recursive: true, force: true })
  currentTmp = null
})

describe('readSqliteIncremental (§4.3)', () => {
  it('returns rows with rowid > fromRowid and the new high-water rowid', async () => {
    await tmpDir()
    const { path, db } = makeDb('a.db')
    const ins = db.prepare('INSERT INTO messages (payload) VALUES (?)')
    ins.run('one')
    ins.run('two')
    db.close()

    const c1 = readSqliteIncremental(path, { table: 'messages', rowidColumn: 'rowid', column: 'payload', fromRowid: 0 })
    expect(c1.rows).toEqual([
      { rowid: 1, value: 'one' },
      { rowid: 2, value: 'two' },
    ])
    expect(c1.nextRowid).toBe(2)
    expect(c1.truncated).toBe(false)

    const db2 = new DatabaseSync(path)
    db2.prepare('INSERT INTO messages (payload) VALUES (?)').run('three')
    db2.close()

    const c2 = readSqliteIncremental(path, { table: 'messages', rowidColumn: 'rowid', column: 'payload', fromRowid: c1.nextRowid })
    expect(c2.rows).toEqual([{ rowid: 3, value: 'three' }])
    expect(c2.nextRowid).toBe(3)

    const c3 = readSqliteIncremental(path, { table: 'messages', rowidColumn: 'rowid', column: 'payload', fromRowid: 3 })
    expect(c3.rows).toEqual([])
    expect(c3.nextRowid).toBe(3) // no rows ⇒ high-water unchanged
  })

  it('maxRows truncates the batch so the next scan resumes from nextRowid', async () => {
    await tmpDir()
    const { path, db } = makeDb('a.db')
    const ins = db.prepare('INSERT INTO messages (payload) VALUES (?)')
    for (let i = 1; i <= 5; i++) ins.run(`r${i}`)
    db.close()
    const opts = { table: 'messages', rowidColumn: 'rowid', column: 'payload', fromRowid: 0, maxRows: 2 }
    const c1 = readSqliteIncremental(path, opts)
    expect(c1.rows.map((r) => r.value)).toEqual(['r1', 'r2'])
    expect(c1.truncated).toBe(true)
    const c2 = readSqliteIncremental(path, { ...opts, fromRowid: c1.nextRowid })
    expect(c2.rows.map((r) => r.value)).toEqual(['r3', 'r4'])
  })

  it('rejects non-plain identifier names (no SQL injection through table/column)', async () => {
    await tmpDir()
    const { path, db } = makeDb('a.db')
    db.close()
    expect(() =>
      readSqliteIncremental(path, { table: 'messages; DROP TABLE messages', rowidColumn: 'rowid', column: 'payload', fromRowid: 0 }),
    ).toThrow(/invalid table/)
    expect(() =>
      readSqliteIncremental(path, { table: 'messages', rowidColumn: 'rowid', column: 'payload" --', fromRowid: 0 }),
    ).toThrow(/invalid column/)
  })

  it('opens read-only: a concurrent read-write holder keeps working, no lock is taken', async () => {
    await tmpDir()
    const { path, db } = makeDb('a.db')
    db.prepare('INSERT INTO messages (payload) VALUES (?)').run('x')
    // rw handle still open — a write-locking reader would deadlock or throw here
    const chunk = readSqliteIncremental(path, { table: 'messages', rowidColumn: 'rowid', column: 'payload', fromRowid: 0 })
    expect(chunk.rows).toEqual([{ rowid: 1, value: 'x' }])
    expect(() => db.prepare('INSERT INTO messages (payload) VALUES (?)').run('y')).not.toThrow()
    db.close()
  })

  it('does not create a missing database file and surfaces a cantopen error', async () => {
    await tmpDir()
    const path = join(dir, 'missing.db')
    expect(() =>
      readSqliteIncremental(path, { table: 't', rowidColumn: 'rowid', column: 'c', fromRowid: 0 }),
    ).toThrow(/unable to open|cantopen/i)
    expect(existsSync(path)).toBe(false)
  })

  it('ReadOnlyUnsupportedError is reserved for mode failures, thrown instead of opening read-write', () => {
    const err = new ReadOnlyUnsupportedError('/x.db', new Error('option not supported'))
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ReadOnlyUnsupportedError')
    expect(err.message).toContain('read-only')
  })

  it('refuses a WAL-mode store before connecting, and leaves no sidecar behind (§18 row 7)', async () => {
    await tmpDir()
    const { path, db } = makeDb('wal.db')
    db.exec('PRAGMA journal_mode = WAL')
    db.prepare('INSERT INTO messages (payload) VALUES (?)').run('foreign row')
    db.close() // a clean close checkpoints and removes -wal/-shm, the header stays at 2
    expect(journalModeOf(path)).toBe('wal')
    expect(existsSync(path + '-wal')).toBe(false)

    expect(() =>
      readSqliteIncremental(path, { table: 'messages', rowidColumn: 'rowid', column: 'payload', fromRowid: 0 }),
    ).toThrow(WalModeRefusedError)
    expect(existsSync(path + '-wal')).toBe(false)
    expect(existsSync(path + '-shm')).toBe(false)
  })

  it('reads a rollback-journal store, and calls a non-database neither', async () => {
    await tmpDir()
    const { path, db } = makeDb('plain.db')
    db.prepare('INSERT INTO messages (payload) VALUES (?)').run('row')
    db.close()
    expect(journalModeOf(path)).toBe('rollback')
    const notDb = join(dir, 'not-a-db.db')
    await writeFile(notDb, 'a jsonl file someone named .db')
    expect(journalModeOf(notDb)).toBe('not-a-database')
    expect(journalModeOf(join(dir, 'absent.db'))).toBe('not-a-database')
  })
})
