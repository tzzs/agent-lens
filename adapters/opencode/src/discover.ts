/**
 * §5.1 `discover` — one `kind:'sqlite'` source per meaningful table.
 *
 * WHY the id salts the table name: §4.1 defines `source_id = hash(agent_id + path)`,
 * but OpenCode keeps three tables in ONE file, so the path alone would collapse
 * them onto a single `sources` row with a single rowid high-water mark. The
 * qualified path `{db}#{table}` is the smallest honest extension.
 */
import type { HostContext, SourceSpec } from '@agentlens/event-model'
import { deriveSourceId } from '@agentlens/event-model'
import { resolveStore } from './paths.ts'
import { AGENT_ID, TABLES } from './record.ts'
import { assessReadOnly, withReadOnlyDb } from './safety.ts'

export async function* discover(ctx: HostContext): AsyncIterable<SourceSpec> {
  const store = await resolveStore(ctx)
  if (store === null) return
  const { dbPath } = store
  let tables: string[]
  try {
    // §18 row 7: an unsafe store yields no sources at all, so the collector can
    // never walk into a WAL database we refused to open.
    if (!(await assessReadOnly(dbPath)).safe) return
    tables = await withReadOnlyDb(dbPath, (db) =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    )
  } catch {
    return
  }
  const present = new Set(tables)
  for (const table of TABLES) {
    if (!present.has(table)) continue
    yield {
      id: deriveSourceId(AGENT_ID, `${dbPath}#${table}`),
      path: dbPath,
      kind: 'sqlite',
      sqliteTable: table,
      // The db carries a native session id per row, so no hint is needed.
      sessionHint: null,
    }
  }
}
