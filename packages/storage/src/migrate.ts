import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { backfillRequestFold } from './request-fold.ts'

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))

/** Numbered .sql files, applied in lexicographic order (§6). */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d.*\.sql$/.test(f))
    .sort()
}

/**
 * Applies pending migrations, each inside its own transaction.
 * A file-backed db is copied to `<db>.pre-migration-<id>.bak` before the first
 * pending migration runs (§6: 迁移前自动备份 DB).
 * Returns the ids applied (empty when already up to date → idempotent).
 */
export function migrate(db: DatabaseSync): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => String(r.id)),
  )
  const pending = migrationFiles().filter((f) => !applied.has(f))
  if (pending.length === 0) return []

  backupBeforeMigration(db, pending[0]!)
  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(file, Date.now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  // §6: an upgrade must not ask anybody to re-scan. Migration 007 only creates the table; the
  // fold that fills it is built here, from the one statement the write path also uses, so the
  // schema file and the data it seeds can never disagree about what stage 1 means. Called on
  // every migrate(): with the sentinel row already present it is one indexed read.
  backfillRequestFold(db)
  return pending
}

function backupBeforeMigration(db: DatabaseSync, firstPendingId: string): void {
  const location = db.location()
  if (!location || location === ':memory:') return
  if (!existsSync(location)) return // brand-new db: nothing to back up
  // The backup must contain committed pages only; flush the WAL first.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const id = firstPendingId.replace(/\.sql$/, '')
  copyFileSync(location, `${location}.pre-migration-${id}.bak`)
}
