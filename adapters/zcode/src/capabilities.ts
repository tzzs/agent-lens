/**
 * §5.1 `capabilities` — the static install surface, read from two places under
 * `~/.zcode/cli/plugins/` (docs/research/zcode.md §一):
 *  - `installed_plugins.json` — `{version: 1, plugins: [{id, name, marketplace, version, …}]}`,
 *    3 entries measured; the richer record, so it wins a name clash;
 *  - `data/<name>@<marketplace>/` — 8 directories measured
 *    (`browser-use`, `computer-use`, `document-skills`, `github`, `lark-cli`, `mimosa`,
 *    `skill-creator`, `zcode-guide`), which is the wider surface: a plugin can be unpacked
 *    here without an install-manifest entry.
 *
 * Deliberately absent, because ZCode cannot show it (§五's `session_entry` caveat):
 *  - **skills** — every skill invocation is visible in the data (`Skill` tool calls, and
 *    `state.input.skill` names them), but the store's `session_entry` table is empty on this
 *    machine, so there is no installed-but-never-used set to enumerate;
 *  - **MCP servers** — the `mcp__server__tool` names prove invocations, not a registry;
 *  - **hooks / connectors** — no measured surface at all.
 *
 * Reporting those would put an invented entity into the canonical catalog; invoked
 * capabilities reach the event stream through `normalize` instead.
 */
import { join } from 'node:path'
import type { CapabilityCatalog, HostContext } from '@agentlens/event-model'
import { installedPluginsFileOf, pluginDataDirOf, pluginsDirOf } from './paths.ts'
import { asRecord, str } from './record.ts'

interface Manifest {
  name: string
  provider: string | null
  source: string
}

export async function capabilities(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const byName = new Map<string, CapabilityCatalog>()
  for (const entry of await manifestEntries(ctx)) {
    if (byName.has(entry.name)) continue
    byName.set(entry.name, { type: 'plugin', name: entry.name, provider: entry.provider, source: entry.source })
  }
  for (const entry of await dataDirEntries(ctx)) {
    const existing = byName.get(entry.name)
    if (!existing) {
      byName.set(entry.name, { type: 'plugin', name: entry.name, provider: entry.provider, source: entry.source })
      continue
    }
    // Both surfaces saw it: fill any gap the manifest left (a missing `marketplace` key) and
    // say where each half came from, rather than picking one and hiding the other.
    byName.set(existing.name, {
      ...existing,
      provider: existing.provider ?? entry.provider,
      source: `${existing.source};${entry.source}`,
    })
  }
  return [...byName.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
  )
}

async function manifestEntries(ctx: HostContext): Promise<Manifest[]> {
  const file = installedPluginsFileOf(ctx)
  let text: string
  try {
    text = await ctx.readFile(file)
  } catch {
    return [] // no catalog at this root: an honest empty answer, not an error (§5.2 rule 1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const root = asRecord(parsed)
  const plugins = Array.isArray(root?.plugins) ? (root.plugins as unknown[]) : []
  const out: Manifest[] = []
  for (const raw of plugins) {
    const plugin = asRecord(raw)
    // Real entries carry both: `id` is `name@marketplace` and `name`/`marketplace` are
    // spelled out. Fall back to the id's halves so an entry that omits them is still named
    // the same way a `data/` directory of the same plugin would be.
    const id = str(plugin?.id)
    const at = id === null ? -1 : id.lastIndexOf('@')
    const split = id !== null && at > 0 ? { name: id.slice(0, at), provider: id.slice(at + 1) } : null
    const name = str(plugin?.name) ?? split?.name ?? id
    if (name === null || name === '') continue
    out.push({ name, provider: str(plugin?.marketplace) ?? split?.provider ?? null, source: file })
  }
  return out
}

async function dataDirEntries(ctx: HostContext): Promise<Manifest[]> {
  const dir = pluginDataDirOf(ctx)
  let names: string[]
  try {
    names = await ctx.readDir(dir)
  } catch {
    return []
  }
  const out: Manifest[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const at = name.lastIndexOf('@')
    // Measured: all 8 directories are `<name>@<marketplace>`. One without that shape is not
    // evidence of an installed plugin, and guessing from a bare directory name would put an
    // entity in the catalog that no install step ever declared.
    if (at <= 0 || at === name.length - 1) continue
    out.push({ name: name.slice(0, at), provider: name.slice(at + 1), source: join(dir, name) })
  }
  return out
}

/** Exported so `doctor` can name the directory a catalog claim came from. */
export function capabilitiesRootOf(ctx: HostContext): string {
  return pluginsDirOf(ctx)
}
