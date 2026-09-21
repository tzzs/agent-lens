/**
 * §5.1 `capabilities` — the static catalog. OpenCode's 22 tables (measured:
 * `account, account_state, control_account, credential, data_migration, event,
 * event_sequence, message, migration, part, permission, project,
 * project_directory, session, session_context_epoch, session_input,
 * session_message, session_share, sqlite_sequence, todo, workspace,
 * __drizzle_migrations`) contain NO plugin/skill/MCP/agent registry, so this
 * adapter honestly returns `[]`: installed-but-never-used is not observable here.
 *
 * The one near-miss is `project.commands` (per-project slash commands). It is
 * deliberately not reported, because `CapabilityCatalog.type` has no `'command'`
 * member (§3.3 enum) — see the M5 report; inventing a `'plugin'` label for a
 * command would put a wrong entity into the canonical catalog.
 */
import type { CapabilityCatalog, HostContext } from '@agentlens/event-model'
import { resolveStore } from './paths.ts'
import { assessReadOnly, withReadOnlyDb } from './safety.ts'

export async function capabilities(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const store = await resolveStore(ctx)
  if (store === null) return []
  const dbPath = store.dbPath
  try {
    if (!(await assessReadOnly(dbPath)).safe) return []
    return await withReadOnlyDb(dbPath, (db) => {
      const names = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      )
      // If a future OpenCode build ships a real registry table, read it here.
      const registry = ['plugin', 'skill', 'agent', 'mcp', 'connector']
        .map((k) => [...names].find((t) => t.toLowerCase().includes(k)))
        .filter((t): t is string => t !== undefined)
      if (registry.length === 0) return []
      const out: CapabilityCatalog[] = []
      for (const table of registry) {
        try {
          const rows = db.prepare(`SELECT name FROM "${table}" LIMIT 500`).all() as { name?: unknown }[]
          for (const row of rows) {
            if (typeof row.name === 'string' && row.name !== '') {
              out.push({ type: 'plugin', name: row.name, provider: table, source: `${dbPath}#${table}` })
            }
          }
        } catch {
          // no `name` column: not a catalog we can describe, skip without guessing
        }
      }
      return out
    })
  } catch {
    return []
  }
}
