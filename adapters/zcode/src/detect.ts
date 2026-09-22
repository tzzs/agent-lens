/**
 * §5.1 `detect` — presence, upstream version, and the §18 row 7 safety verdict, without
 * ever opening a database we cannot prove is side-effect free to read.
 *
 * Presence is one file: `cli/db/db.sqlite`. §一 lists ten other paths under `~/.zcode`
 * and every one of them is either a second token dialect (`rollout/`), a log, an artifact
 * dump, or a credential file — none of which this adapter reads.
 */
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Detection, HostContext } from '@agentlens/event-model'
import { resolveStore, rootOf } from './paths.ts'
import { TABLES } from './record.ts'
import { WAL_REASON, assessReadOnly, withReadOnlyDb } from './safety.ts'

/** §一: the store is one file; a build missing any of these five tables is a schema we have not met. */
const REQUIRED_TABLES: readonly string[] = TABLES

export async function detect(ctx: HostContext): Promise<Detection> {
  const store = await resolveStore(ctx)
  if (store === null) {
    const dataRoot = rootOf(ctx)
    return {
      present: false,
      agentVersion: null,
      dataRoot,
      reason: `no database at ${join(dataRoot, 'cli', 'db', 'db.sqlite')}`,
    }
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
    // §18 row 7: `agentVersion` is null WITH a reason rather than a guess. The real engine
    // version (0.16.5 measured) is reachable two other ways — the collector's snapshot copy
    // at `detect` time is not available here, and every `session` row carries it in
    // `session.version`, which normalize reports per session.
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
      return { present: true, agentVersion: agentVersion(db), dataRoot, reason: null }
    })
  } catch (err) {
    return { present: true, agentVersion: null, dataRoot, reason: `unreadable store: ${String(err)}` }
  }
}

/**
 * §七: the engine version is `schema_migration.app_version` (measured `0.16.5` over 22
 * migrations). It is NOT the desktop app's `3.11.2 → 3.12.1`: those are two version lines
 * on one machine, so drift reporting must keep them apart, and this field answers only for
 * the writer of this store. `session.version` is the fallback because every session row
 * stamps it too; `'local'` dev builds lose to a real release rather than hiding it.
 */
function agentVersion(db: DatabaseSync): string | null {
  const scalar = (sql: string): string | null => {
    try {
      const row = db.prepare(sql).get() as Record<string, unknown> | undefined
      const first = row ? Object.values(row)[0] : undefined
      const v = typeof first === 'string' ? first.trim() : ''
      return v === '' || v === 'local' ? null : v
    } catch {
      return null
    }
  }
  return (
    scalar(`SELECT app_version FROM "schema_migration" WHERE app_version IS NOT NULL ORDER BY time_applied DESC, rowid DESC LIMIT 1`) ??
    scalar(`SELECT version FROM "session" WHERE version <> 'local' ORDER BY rowid DESC LIMIT 1`) ??
    scalar(`SELECT version FROM "session" ORDER BY rowid DESC LIMIT 1`)
  )
}
