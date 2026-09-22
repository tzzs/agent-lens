/**
 * §2 Machine tier, storage half: migration `005_machine.sql` plus the mint-on-first-read
 * in `machine.ts`. All databases are throwaway temp files; the ids are runtime UUIDs, so
 * nothing user-identifiable appears in this file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { ensureMachineId, getMachineId, migrate, openDatabase } from '../src/index.ts'
import { insertEvents } from '../src/write.ts'
import { makeEvent } from './helpers.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MIGRATIONS = fileURLToPath(new URL('../src/migrations/', import.meta.url))
const PRE_005 = [
  '001_init.sql',
  '002_measurement_round_two.sql',
  '003_aggregation_policy_per_agent.sql',
  '004_sqlite_table_in_sources.sql',
]

const DIR = mkdtempSync(join(tmpdir(), 'agentlens-machine-'))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

function freshDb(): { db: ReturnType<typeof openDatabase>; path: string } {
  const path = join(DIR, `agentlens-${Math.random().toString(36).slice(2)}.db`)
  const db = openDatabase(path)
  migrate(db)
  return { db, path }
}

describe('machine identity (§2)', () => {
  it('mints exactly once and is a random UUID', () => {
    const { db } = freshDb()
    expect(getMachineId(db)).toBeNull() // migrate alone does not mint; first READ does
    const first = ensureMachineId(db)
    expect(first.id).toMatch(UUID_RE)
    expect(ensureMachineId(db)).toEqual(first) // same id AND same minted_at: no re-mint
    expect((db.prepare('SELECT COUNT(*) AS n FROM machine').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('a reopened handle reads back the identical id', () => {
    const path = join(DIR, 'reopen.db')
    const db = openDatabase(path)
    migrate(db)
    const minted = ensureMachineId(db)
    db.close()
    const again = openDatabase(path)
    expect(getMachineId(again)).toBe(minted.id)
    expect(ensureMachineId(again).mintedAt).toBe(minted.mintedAt)
    again.close()
  })

  it('two handles racing on a fresh store converge on one id (singleton slot + DO NOTHING)', () => {
    const path = join(DIR, 'race.db')
    const a = openDatabase(path)
    migrate(a)
    const b = openDatabase(path)
    expect(ensureMachineId(a).id).toBe(ensureMachineId(b).id)
    expect((a.prepare('SELECT COUNT(*) AS n FROM machine').get() as { n: number }).n).toBe(1)
    b.close()
    a.close()
  })

  it('two independent databases get distinct ids — that is the whole merge argument', () => {
    const one = freshDb()
    const two = freshDb()
    const idA = ensureMachineId(one.db).id
    const idB = ensureMachineId(two.db).id
    expect(idA).not.toBe(idB)
    one.db.close()
    two.db.close()
  })

  it('005 applies cleanly to a populated pre-existing store and leaves its rows untouched', () => {
    const path = join(DIR, 'populated.db')
    // Build the pre-005 deployment exactly as migrations 001–004 would have left it.
    const db = openDatabase(path)
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
    for (const file of PRE_005) {
      db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, 0)').run(file)
    }
    insertEvents(db, [makeEvent({ type: 'message.user' }), makeEvent({ type: 'message.assistant' })])
    const before = {
      events: (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      sessions: (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
      agents: (db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n,
    }
    db.close()

    const reopened = openDatabase(path)
    expect(migrate(reopened)).toEqual(['005_machine.sql', '006_measured_read_paths.sql', '007_session_title_index.sql'])
    expect(existsSync(`${path}.pre-migration-005_machine.bak`)).toBe(true) // §6: backup before migrating real data
    const after = {
      events: (reopened.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      sessions: (reopened.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
      agents: (reopened.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n,
    }
    expect(after).toEqual(before)
    expect(after.events).toBeGreaterThan(0) // the "populated" in the test name is real
    expect(ensureMachineId(reopened).id).toMatch(UUID_RE)
    reopened.close()
  })
})
