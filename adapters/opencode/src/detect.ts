/**
 * §5.1 `detect` — presence, upstream version, and the §18 row 7 safety verdict,
 * without ever opening a database we cannot prove is side-effect free to read.
 */
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Detection, HostContext } from '@agentlens/event-model'
import { resolveStore, rootOf, DB_FILE } from './paths.ts'
import { TABLES } from './record.ts'
import { WAL_REASON, assessReadOnly, withReadOnlyDb } from './safety.ts'

/** §2.2: OpenCode's store always carries these three; anything else is a schema we have not met. */
const REQUIRED_TABLES: readonly string[] = TABLES

export async function detect(ctx: HostContext): Promise<Detection> {
  const store = await resolveStore(ctx)
  if (store === null) {
    const dataRoot = rootOf(ctx)
    return { present: false, agentVersion: null, dataRoot, reason: `no database at ${join(dataRoot, DB_FILE)}` }
  }
  const { dataRoot, dbPath } = store

  let fileSize = 0
  try {
    const s = await ctx.stat(dbPath)
    if (s === null) {
      return { present: false, agentVersion: null, dataRoot, reason: `no database at ${dbPath}` }
    }
    fileSize = s.size
  } catch (err) {
    return { present: false, agentVersion: null, dataRoot, reason: `unusable store: ${String(err)}` }
  }
  if (fileSize === 0) {
    return { present: true, agentVersion: null, dataRoot, reason: 'database file is empty' }
  }

  const safety = await assessReadOnly(dbPath)
  if (!safety.safe) {
    return { present: true, agentVersion: null, dataRoot, reason: WAL_REASON }
  }

  try {
    return await withReadOnlyDb(dbPath, (db) => {
      const names = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      )
      const missing = REQUIRED_TABLES.filter((t) => !names.has(t))
      if (missing.length > 0) {
        return {
          present: true,
          agentVersion: null,
          dataRoot,
          reason: `missing expected tables: ${missing.join(', ')}`,
        }
      }
      return {
        present: true,
        agentVersion: agentVersion(db),
        dataRoot,
        reason: null,
      }
    })
  } catch (err) {
    return { present: true, agentVersion: null, dataRoot, reason: `unreadable store: ${String(err)}` }
  }
}

/**
 * `session.version` is the product version stamped on every session (`1.18.31`
 * measured, plus `'local'` for dev builds); the newest real release wins, because
 * a single dev session in the store must not hide the version of everything else.
 */
function agentVersion(db: DatabaseSync): string | null {
  const read = (sql: string): string | null => {
    try {
      const row = db.prepare(sql).get() as { version?: unknown } | undefined
      const v = typeof row?.version === 'string' ? row.version.trim() : ''
      return v === '' || v === 'local' ? null : v
    } catch {
      return null
    }
  }
  return read(`SELECT version FROM "session" WHERE version <> 'local' ORDER BY rowid DESC LIMIT 1`)
    ?? read(`SELECT version FROM "session" ORDER BY rowid DESC LIMIT 1`)
}
