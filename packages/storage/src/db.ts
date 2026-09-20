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
