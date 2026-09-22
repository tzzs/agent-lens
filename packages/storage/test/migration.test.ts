import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { tempDir } from './helpers.ts'

describe('migrations', () => {
  it('applies every migration exactly once and is a no-op on the second run', () => {
    const db = openDatabase(':memory:')
    expect(migrate(db)).toEqual([
      '001_init.sql',
      '002_measurement_round_two.sql',
      '003_aggregation_policy_per_agent.sql',
      '004_sqlite_table_in_sources.sql',
      '005_machine.sql',
      '006_measured_read_paths.sql',
    ])
    expect(migrate(db)).toEqual([])
    const applied = db.prepare('SELECT id FROM schema_migrations').all()
    expect(applied.map((r) => r.id)).toEqual([
      '001_init.sql',
      '002_measurement_round_two.sql',
      '003_aggregation_policy_per_agent.sql',
      '004_sqlite_table_in_sources.sql',
      '005_machine.sql',
      '006_measured_read_paths.sql',
    ])
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
      'machine',
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

  it('adds sources.sqlite_table to a database created before §4.3 without disturbing stored rows', () => {
    const db = openDatabase(':memory:')
    // A pre-004 deployment: migrations through 003 recorded, `sources` without the extension column.
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
    for (const id of ['001_init.sql', '002_measurement_round_two.sql', '003_aggregation_policy_per_agent.sql']) {
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, 0)').run(id)
    }
    db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY)')
    db.exec(`CREATE TABLE sources (
      id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id), path TEXT,
      kind TEXT CHECK (kind IN ('jsonl','sqlite','ndir')), inode INTEGER, size INTEGER, mtime_ms INTEGER,
      last_offset INTEGER, parser_version INTEGER, session_id_hint TEXT,
      status TEXT CHECK (status IN ('active','gone','error','rotated')), last_error TEXT,
      scan_started_at INTEGER, scan_finished_at INTEGER, rows_ingested INTEGER
    )`)
    // A real pre-004 deployment has the tables 001 created; 006 indexes `events`, so the
    // stand-in needs one (the test only inspects `sources`).
    db.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY, agent_id TEXT, project_id TEXT, request_id TEXT, timestamp INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, reasoning_tokens INTEGER, duration_ms INTEGER, metadata TEXT
    )`)
    db.prepare("INSERT INTO agents (id) VALUES ('a1')").run()
    db.prepare(
      "INSERT INTO sources (id, agent_id, path, kind, last_offset, status) VALUES ('s1','a1','/x/opencode.db','sqlite',512,'active')",
    ).run()

    expect(migrate(db)).toEqual(['004_sqlite_table_in_sources.sql', '005_machine.sql', '006_measured_read_paths.sql'])
    const cols = (db.prepare('PRAGMA table_info(sources)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('sqlite_table')
    const row = db.prepare("SELECT sqlite_table, last_offset FROM sources WHERE id = 's1'").get() as
      { sqlite_table: string | null; last_offset: number }
    expect(row.last_offset).toBe(512) // the stored row survives untouched
    expect(row.sqlite_table).toBeNull() // reads back as unknown, never a guess
    db.close()
  })

  /**
   * 006 exists because the Projects page scanned the whole store to group an expression.
   * An index the optimiser ignores is dead weight, so the plan is pinned, not just the name.
   *
   * The candidate that did NOT ship is on record here too: a covering index for the stage-1
   * fold (`events(timestamp, agent_id, request_id, id, <token cols>)`) measured 860 ms ->
   * 122 ms when the cube still re-folded the window ~24 times per request on a cold store.
   * With the fold running once per request and the tuned page cache, the same statement is
   * 100 ms with or without it (137 vs 115 ms with a deliberately tiny cache) — 33 MB for
   * noise. Re-measure before adding it back; the old number no longer describes this code.
   */
  it('006 gives the project cwd grouping an access path the planner actually takes', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_events_%'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('idx_events_cwd')
    expect(names, 'the fold-covering index measured as dead weight; see the note above').not.toContain('idx_events_fold')
    expect(
      (
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT project_id, json_extract(metadata,'$.cwd') c, COUNT(*) FROM events WHERE project_id IS NOT NULL GROUP BY project_id, c",
          )
          .all() as { detail: string }[]
      )
        .map((r) => r.detail)
        .join('\n'),
    ).toContain('idx_events_cwd')
    db.close()
  })
})
