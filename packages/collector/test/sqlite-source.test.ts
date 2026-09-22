import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WalModeRefusedError, journalModeOf } from '../src/sqlite-source.ts'

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

describe('journalModeOf (§18 row 7)', () => {
  it('reads WAL from the header without connecting, so the check itself leaves no sidecar behind', async () => {
    await tmpDir()
    const { path, db } = makeDb('wal.db')
    db.exec('PRAGMA journal_mode = WAL')
    db.prepare('INSERT INTO messages (payload) VALUES (?)').run('foreign row')
    db.close() // a clean close checkpoints and removes -wal/-shm, the header stays at 2
    expect(journalModeOf(path)).toBe('wal')
    expect(existsSync(path + '-wal')).toBe(false)
    expect(journalModeOf(path)).toBe('wal')
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

  it('WalModeRefusedError names the store and the rule (§5.2)', async () => {
    await tmpDir()
    const err = new WalModeRefusedError(join(dir, 'x.db'))
    expect(err.name).toBe('WalModeRefusedError')
    expect(err.message).toContain('WAL mode')
    expect(err.message).toContain('§18 row 7')
  })
})
