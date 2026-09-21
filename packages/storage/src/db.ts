import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export interface OpenDatabaseOptions {
  readonly?: boolean
}

/**
 * Opens the AgentLens SQLite database using Node's built-in driver (zero native deps, §13).
 * `node:sqlite` is synchronous end to end; callers must not wrap these calls in async.
 */
export function openDatabase(path: string | ':memory:', opts?: OpenDatabaseOptions): DatabaseSync {
  const db = new DatabaseSync(path, opts?.readonly ? { readOnly: true } : {})
  try {
    if (!opts?.readonly) db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
    // Read tuning, not semantics. The §18 stage-1 fold groups 343k events on a 64-char
    // key and stage 2 groups the folded rows again, so every token route spills two temp
    // B-trees per pass; on the measured store these three pragmas cut a full
    // `/api/projects` fold ~1.7x without changing a row or an order.
    db.exec('PRAGMA temp_store = MEMORY')
    db.exec('PRAGMA cache_size = -65536')
    db.exec('PRAGMA mmap_size = 268435456')
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

/** §6 — single-file default location. */
export function defaultDbPath(homedir: string): string {
  return join(homedir, '.agentlens', 'agentlens.db')
}
