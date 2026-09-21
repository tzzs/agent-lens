/**
 * §4.3 — a row store's high-water mark is only half the resume position: the other half is
 * WHICH TABLE the rowid counts. `last_offset` carries the number, so without the table name
 * a stored `sources` row cannot be read back without the adapter that minted it.
 */
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db.ts'
import { migrate } from '../src/migrate.ts'
import { updateSourceProgress, type SourceProgress } from '../src/write.ts'

function row(overrides: Partial<SourceProgress> = {}): SourceProgress {
  return {
    id: 'src-sqlite-messages',
    agentId: 'fake-sqlite-agent',
    path: '/fixture/store/opencode.db',
    kind: 'sqlite',
    inode: 7,
    size: 4096,
    mtimeMs: 1_750_000_000_000,
    lastOffset: 512,
    parserVersion: 1,
    sessionIdHint: null,
    status: 'active',
    rowsIngested: 3,
    scanStartedAt: 1_750_000_050_000,
    scanFinishedAt: 1_750_000_060_000,
    lastError: null,
    ...overrides,
  }
}

function tableColumn(db: ReturnType<typeof openDatabase>): string[] {
  return (db.prepare('PRAGMA table_info(sources)').all() as { name: string }[]).map((c) => c.name)
}

/** What a reader sees without the adapter that minted the row: id, path, table, watermark. */
function stored(db: ReturnType<typeof openDatabase>, id: string): { sqlite_table: string | null; last_offset: number } {
  return db
    .prepare('SELECT sqlite_table, last_offset FROM sources WHERE id = ?')
    .get(id) as { sqlite_table: string | null; last_offset: number }
}

describe('sources.sqlite_table (§4.3 extension column)', () => {
  it('the forward migration adds the column without touching the existing ones', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    expect(tableColumn(db)).toEqual(
      expect.arrayContaining([
        'id',
        'agent_id',
        'path',
        'kind',
        'last_offset',
        'session_id_hint',
        'sqlite_table',
      ]),
    )
    db.close()
  })

  it('a scan records which table the rowid watermark counts', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    updateSourceProgress(db, row({ sqliteTable: 'messages' }))
    expect(stored(db, 'src-sqlite-messages')).toEqual({ sqlite_table: 'messages', last_offset: 512 })
    db.close()
  })

  it('several tables of one store stay separate rows with their own watermarks', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    updateSourceProgress(db, row({ id: 'a', sqliteTable: 'messages', lastOffset: 10 }))
    updateSourceProgress(db, row({ id: 'b', sqliteTable: 'part', lastOffset: 99 }))
    const paths = db.prepare('SELECT path FROM sources').all().map((r) => String(r.path))
    expect(paths).toEqual(['/fixture/store/opencode.db', '/fixture/store/opencode.db'])
    expect(stored(db, 'a')).toEqual({ sqlite_table: 'messages', last_offset: 10 })
    expect(stored(db, 'b')).toEqual({ sqlite_table: 'part', last_offset: 99 })
    db.close()
  })

  it('a later commit that does not carry the table name does not erase it', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    updateSourceProgress(db, row({ sqliteTable: 'messages' }))
    updateSourceProgress(db, row({ lastOffset: 600 }))
    expect(stored(db, 'src-sqlite-messages')).toEqual({ sqlite_table: 'messages', last_offset: 600 })
    db.close()
  })

  it('a jsonl source records no table', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    updateSourceProgress(db, row({ id: 'jsonl-1', kind: 'jsonl', sqliteTable: null }))
    expect(stored(db, 'jsonl-1')).toEqual({ sqlite_table: null, last_offset: 512 })
    db.close()
  })

  it('a row stored before the column existed reads back as unknown, not as a guess', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    db.prepare('INSERT INTO agents (id) VALUES (?)').run('l')
    db.prepare(
      "INSERT INTO sources (id, agent_id, path, kind, last_offset, status) VALUES ('legacy', 'l', '/x.db', 'sqlite', 42, 'active')",
    ).run()
    expect(stored(db, 'legacy')).toEqual({ sqlite_table: null, last_offset: 42 })
    db.close()
  })
})
