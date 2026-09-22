/**
 * §5.1 `discover` — one `kind:'sqlite'` source per table of `cli/db/db.sqlite`, plus one
 * `kind:'jsonl'` source per `cli/agents/…/agent_…/metadata.json` (§八·5a).
 *
 * WHY the SQLite ids salt the table name: §4.1 defines `source_id = hash(agent_id + path)`,
 * but ZCode keeps five collected tables in ONE file, so the path alone would collapse them
 * onto a single `sources` row with a single rowid high-water mark. The qualified path
 * `{db}#{table}` is the smallest honest extension. The agents tree needs no such salt: it is
 * already one file per run.
 *
 * WHY only five of the store's tables: `turn_usage`, `session_target` and the rest listed
 * in `NON_SOURCE_TABLES` are rollups (§三) — their numbers are sums of rows another source
 * already reports, so a source over them would be counted twice by any consumer. The agents
 * document IS §三's fifth copy, and is still a source: what is collected from it is the
 * parent key and the close, and the token figures are confined to `metadata.rollup` (§八·5a).
 *
 * WHY the file sources do not depend on the store: `cli/agents/` is plain JSON, so the
 * §18 row 7 posture that keeps the WAL database shut says nothing about it. Refusing the
 * store must not also hide the one piece of evidence that turns the subagent chains from
 * NULL parents into proved ones — that listing happens in its own loop below.
 */
import type { HostContext, SourceSpec } from '@agentlens/event-model'
import { deriveSourceId } from '@agentlens/event-model'
import { discoverAgentsSources } from './agents.ts'
import { resolveStore } from './paths.ts'
import { AGENT_ID, TABLES } from './record.ts'
import { assessReadOnly, withReadOnlyDb } from './safety.ts'

export async function* discover(ctx: HostContext): AsyncIterable<SourceSpec> {
  yield* discoverStoreTables(ctx)
  yield* discoverAgentsSources(ctx)
}

async function* discoverStoreTables(ctx: HostContext): AsyncIterable<SourceSpec> {
  const store = await resolveStore(ctx)
  if (store === null) return
  const { dbPath } = store
  let tables: string[]
  const safety = await assessReadOnly(dbPath)
  if (!safety.safe) {
    // §18 row 7: this store will not be opened, and neither will the collector's. Listing
    // the tables anyway keeps the agent on the map — the scan reports one refusal per
    // source, so the WAL state becomes a recorded fact — while returning nothing here would
    // make an installed ZCode look simply absent (§5.2 rule 1).
    tables = [...TABLES]
  } else {
    try {
      tables = await withReadOnlyDb(dbPath, (db) =>
        (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      )
    } catch {
      return
    }
  }
  const present = new Set(tables)
  for (const table of TABLES) {
    if (!present.has(table)) continue
    yield {
      id: deriveSourceId(AGENT_ID, `${dbPath}#${table}`),
      path: dbPath,
      kind: 'sqlite',
      sqliteTable: table,
      // Every row carries its own native session id, so no hint is needed.
      sessionHint: null,
    }
  }
}
