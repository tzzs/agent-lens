/**
 * §18 row 7 snapshot machinery: a WAL store is read through a copy we own, and the
 * copy is folded into an ordinary rollback-mode file. These tests pin the three
 * promises the fold depends on: the foreign store is only ever copyFile-d and stat-ed,
 * a torn copy is retried and then reported (never half-read), and an unchanged store
 * is never re-copied.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SnapshotError, snapshotPathFor, snapshotWalStore, type SnapshotDeps } from '../src/sqlite-snapshot.ts'
import { journalModeOf } from '../src/sqlite-source.ts'

let currentTmp: string | null = null

function tmpRoot(): string {
  if (!currentTmp) currentTmp = mkdtempSync(join(tmpdir(), 'collector-snap-'))
  return currentTmp
}

afterEach(() => {
  if (currentTmp) rmSync(currentTmp, { recursive: true, force: true })
  currentTmp = null
})

interface WalStore {
  dbPath: string
  foreignDir: string
  snapDir: string
  close(): void
}

/** A store exactly as a live app leaves it: WAL header, `-wal` and `-shm` on disk. */
function buildWalStore(rows = 2): WalStore {
  const foreignDir = join(tmpRoot(), 'foreign')
  mkdirSync(foreignDir, { recursive: true })
  const dbPath = join(foreignDir, 'app.db')
  // One connection that stays open, because that is what a running app is: its
  // committed rows live in `-wal` until it checkpoints, so a copy of the db alone
  // would be missing them.
  const writer = new DatabaseSync(dbPath)
  writer.exec('PRAGMA journal_mode = WAL')
  writer.exec('CREATE TABLE t (payload TEXT)')
  const ins = writer.prepare('INSERT INTO t (payload) VALUES (?)')
  for (let i = 1; i <= rows; i++) ins.run(`row-${i}`)
  const snapDir = mkdtempSync(join(tmpRoot(), 'snap-'))
  return { dbPath, foreignDir, snapDir, close: () => writer.close() }
}

function stamp(path: string): string {
  try {
    const s = statSync(path)
    return `${s.size}:${s.mtimeMs}:${s.ino}`
  } catch {
    return 'absent'
  }
}

describe('snapshotWalStore (§18 row 7)', () => {
  it('copies db + -wal (never -shm), folds to rollback mode, and keeps every committed row', () => {
    const host = buildWalStore(3)
    try {
      const before = [host.dbPath, `${host.dbPath}-wal`, `${host.dbPath}-shm`].map(stamp)
      const copy = snapshotWalStore(host.dbPath, { dir: host.snapDir })

      expect(copy).toBe(snapshotPathFor(host.dbPath, host.snapDir))
      expect(journalModeOf(copy)).toBe('rollback')
      expect(existsSync(`${copy}-wal`)).toBe(false)
      expect(existsSync(`${copy}-shm`)).toBe(false)
      // The -wal copy was folded in, so rows committed after the last checkpoint are there:
      const db = new DatabaseSync(copy, { open: true, readOnly: true })
      const rows = db.prepare('SELECT payload FROM t ORDER BY rowid').all() as { payload: string }[]
      db.close()
      expect(rows.map((r) => r.payload)).toEqual(['row-1', 'row-2', 'row-3'])
      // Nothing on the foreign side moved, and no new path appeared next to it.
      expect([host.dbPath, `${host.dbPath}-wal`, `${host.dbPath}-shm`].map(stamp)).toEqual(before)
      expect(readdirSync(host.foreignDir).sort()).toEqual(['app.db', 'app.db-shm', 'app.db-wal'])
      // Snapshot dir carries the single file + its signature, nothing else.
      expect(readdirSync(host.snapDir).sort()).toEqual([basename(copy), `${basename(copy)}.sig`])
    } finally {
      host.close()
    }
  })

  it('names a copy after the store itself, so one file per store and no path can escape', () => {
    const host = buildWalStore(1)
    // A store whose name is pure traversal bait: the copy is named by a digest of the
    // path, so nothing here can break out of `dir` regardless of what the path says.
    const weirdDir = mkdtempSync(join(tmpRoot(), 'weird-'))
    const weirdPath = join(weirdDir, '..%2F..snapshot.db')
    const weird = new DatabaseSync(weirdPath)
    weird.exec('PRAGMA journal_mode = WAL')
    weird.exec('CREATE TABLE t (payload TEXT)')
    weird.prepare('INSERT INTO t (payload) VALUES (?)').run('weird')
    try {
      const shared = mkdtempSync(join(tmpRoot(), 'snap-shared-'))
      const first = snapshotWalStore(host.dbPath, { dir: shared })
      const again = snapshotWalStore(host.dbPath, { dir: shared })
      expect(again).toBe(first) // one store, one file, whatever the caller
      expect(basename(first)).toMatch(/^[0-9a-f]{64}\.snapshot\.db$/)
      expect(first.startsWith(`${shared}/`)).toBe(true)
      const second = snapshotWalStore(weirdPath, { dir: shared })
      expect(second).not.toBe(first)
      expect(readFileSync(`${second}.sig`, 'utf8')).not.toBe(readFileSync(`${first}.sig`, 'utf8'))
      expect(readdirSync(shared)).toHaveLength(4) // two copies + two signatures
      expect(readdirSync(host.foreignDir).sort()).toEqual(['app.db', 'app.db-shm', 'app.db-wal'])
    } finally {
      weird.close()
      host.close()
    }
  })

  it('an unchanged store hits the signature cache: zero copy syscalls on the second call', () => {
    const host = buildWalStore(2)
    let copies = 0
    const deps: SnapshotDeps = {
      copyFileSync: (from, to) => {
        copies++
        writeFileSync(to, readFileSync(from))
      },
      statSync,
    }
    try {
      snapshotWalStore(host.dbPath, { dir: host.snapDir }, deps)
      expect(copies).toBeGreaterThan(0)
      const afterFirst = copies
      const again = snapshotWalStore(host.dbPath, { dir: host.snapDir }, deps)
      expect(copies).toBe(afterFirst) // cache: nothing copied at all
      const db = new DatabaseSync(again, { open: true, readOnly: true })
      expect((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(2)
      db.close()
    } finally {
      host.close()
    }
  })

  it('a store that moved mid-copy is retried once and then the fresh copy is used', () => {
    const host = buildWalStore(1)
    let attempts = 0
    const deps: SnapshotDeps = {
      copyFileSync: (from, to) => {
        attempts++
        writeFileSync(to, readFileSync(from))
        if (attempts === 1) appendFileSync(host.dbPath, 'torn') // only the db copy tears
      },
      statSync,
    }
    try {
      const copy = snapshotWalStore(host.dbPath, { dir: host.snapDir }, deps)
      expect(attempts).toBe(4) // attempt 1: db+wal, attempt 2: db+wal again
      expect(journalModeOf(copy)).toBe('rollback')
      // The signature file describes the attempt that succeeded intact:
      const live = deps.statSync(host.dbPath)
      expect(readFileSync(`${copy}.sig`, 'utf8')).toContain(`${live.size}:${live.mtimeMs}`)
    } finally {
      host.close()
    }
  })

  it('a store that tears twice is reported, never cached', () => {
    const host = buildWalStore(1)
    const deps: SnapshotDeps = {
      copyFileSync: (from, to) => {
        writeFileSync(to, readFileSync(from))
        if (from === host.dbPath) appendFileSync(host.dbPath, 'torn') // every attempt tears
      },
      statSync,
    }
    try {
      expect(() => snapshotWalStore(host.dbPath, { dir: host.snapDir }, deps)).toThrow(SnapshotError)
      const err = (() => {
        try {
          snapshotWalStore(host.dbPath, { dir: host.snapDir }, deps)
          return null
        } catch (e) {
          return e as Error
        }
      })()
      expect(err?.name).toBe('SnapshotError')
      expect(err?.message).toContain(host.dbPath)
      expect(err?.message).toMatch(/retry/i)
      // A torn copy must never masquerade as cache: the sig file is what gates reuse.
      expect(existsSync(`${snapshotPathFor(host.dbPath, host.snapDir)}.sig`)).toBe(false)
    } finally {
      host.close()
    }
  })

  it('a rolled-back cache (sig missing) re-copies instead of trusting a stale file', () => {
    const host = buildWalStore(1)
    try {
      const copy = snapshotWalStore(host.dbPath, { dir: host.snapDir })
      rmSync(`${copy}.sig`)
      const again = snapshotWalStore(host.dbPath, { dir: host.snapDir })
      expect(existsSync(`${again}.sig`)).toBe(true)
    } finally {
      host.close()
    }
  })
})
