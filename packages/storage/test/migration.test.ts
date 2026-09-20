import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { tempDir } from './helpers.ts'

describe('migrations', () => {
  it('applies every migration exactly once and is a no-op on the second run', () => {
    const db = openDatabase(':memory:')
    expect(migrate(db)).toEqual(['001_init.sql', '002_measurement_round_two.sql'])
    expect(migrate(db)).toEqual([])
    const applied = db.prepare('SELECT id FROM schema_migrations').all()
    expect(applied.map((r) => r.id)).toEqual(['001_init.sql', '002_measurement_round_two.sql'])
    db.close()
  })

  it('adds the §18 columns and thread index without disturbing 001 rows', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const cols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining(['thread_id', 'cost_reported', 'cost_source', 'credits']),
    )
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_thread'").all())
        .length,
    ).toBe(1)
    db.close()
  })

  it('enables foreign keys via openDatabase', () => {
    const db = openDatabase(':memory:')
    const fk = db.prepare('PRAGMA foreign_keys').get() as Record<string, number>
    expect(Object.values(fk)[0]).toBe(1)
    migrate(db)
    // FK enforcement is live, not just the pragma:
    expect(() =>
      db.prepare('INSERT INTO sessions (id, agent_id) VALUES (?, ?)').run('s1', 'ghost-agent'),
    ).toThrow()
    db.close()
  })

  it('rejects an unknown source kind through the CHECK constraint', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    db.prepare('INSERT INTO agents (id) VALUES (?)').run('a1')
    expect(() =>
      db.prepare('INSERT INTO sources (id, agent_id, kind) VALUES (?, ?, ?)').run('s1', 'a1', 'parquet'),
    ).toThrow(/CHECK/)
    db.close()
  })

  it('creates the five §3.1 indexes plus the capability index on events', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' ORDER BY name")
      .all()
      .map((r) => String(r.name))
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_events_ts',
        'idx_events_agent',
        'idx_events_project',
        'idx_events_session',
        'idx_events_request',
        'idx_events_capability',
      ]),
    )
    db.close()
  })

  it('creates all §3.1/§3.2/§4.3 tables', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => String(r.name))
      .filter((n) => !n.startsWith('sqlite_'))
    expect(tables).toEqual([
      'agents',
      'events',
      'models',
      'parse_errors',
      'payloads',
      'projects',
      'schema_migrations',
      'sessions',
      'sources',
    ])
    db.close()
  })

  it('backs up a file db before the first pending migration', () => {
    const dir = tempDir()
    const path = `${dir}/agentlens.db`
    const db = openDatabase(path)
    migrate(db)
    db.close()
    expect(existsSync(`${path}.pre-migration-001_init.bak`)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not re-back-up when migrate() finds nothing pending', () => {
    const dir = mkdtempSync('/tmp/al-mig2-')
    const path = `${dir}/agentlens.db`
    const db = openDatabase(path)
    migrate(db)
    rmSync(`${path}.pre-migration-001_init.bak`)
    expect(migrate(db)).toEqual([])
    expect(existsSync(`${path}.pre-migration-001_init.bak`)).toBe(false)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
