/**
 * §5.1 `capabilities` — the static catalog behind "installed 62 / invoked 9" (§11).
 * Only the sources the report shows to be enumerable without a scan are used here:
 * `~/.claude/skills/*`, `plugins/installed_plugins.json`, `~/.claude.json#mcpServers`.
 * `attachment.skill_listing` / `attachment.deferred_tools_delta` are per-session
 * observations, so they reach the catalog through normalize instead (§2.6).
 */
import { extname, join } from 'node:path'
import type { CapabilityCatalog, HostContext } from '@agentlens/event-model'
import { asRecord, arr, str, strList } from './record.ts'
import { installedPluginsFileOf, skillsDirOf, userConfigFileOf } from './paths.ts'

export async function capabilities(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const out: CapabilityCatalog[] = []
  out.push(...(await skillDirs(ctx)))
  out.push(...(await installedPlugins(ctx)))
  out.push(...(await mcpServers(ctx)))
  return out.sort(
    (a, b) =>
      a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
  )
}

async function skillDirs(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const dir = skillsDirOf(ctx)
  let names: string[]
  try {
    names = await ctx.readDir(dir)
  } catch {
    return []
  }
  const out: CapabilityCatalog[] = []
  for (const name of names) {
    if (name.startsWith('.') || isLikelyFile(name)) continue
    let entries: string[]
    try {
      entries = await ctx.readDir(join(dir, name))
    } catch {
      continue // unreadable subdirectory: not evidence of an installed skill
    }
    if (entries.length === 0) continue
    out.push({ type: 'skill', name, provider: 'userSettings', source: dir })
  }
  return out
}

/** A skill is a directory holding SKILL.md; anything with a known extension is a stray file. */
function isLikelyFile(name: string): boolean {
  const ext = extname(name)
  return ext !== '' && ext !== '.md' && ext !== '.json' && ext !== '.ts' && ext !== '.js'
}

async function installedPlugins(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const file = installedPluginsFileOf(ctx)
  let text: string
  try {
    text = await ctx.readFile(file)
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const out: CapabilityCatalog[] = []
  const root = asRecord(parsed)
  const candidates: unknown[] = [
    ...(Array.isArray(parsed) ? parsed : []),
    ...(root ? arr(root.plugins) : []),
    ...(root && Array.isArray(root.repos) ? root.repos : []),
  ]
  for (const item of candidates) {
    const rec = asRecord(item)
    const name = rec ? str(rec.name) ?? str(rec.id) : null
    if (name) {
      out.push({ type: 'plugin', name, provider: rec ? str(rec.source) ?? null : null, source: file })
    }
  }
  if (out.length === 0 && root) {
    // Map-shaped file: { "<plugin-name>": {...} }
    for (const key of Object.keys(root)) {
      if (typeof root[key] === 'object' && root[key] !== null) {
        out.push({ type: 'plugin', name: key, provider: null, source: file })
      }
    }
  }
  return out
}

async function mcpServers(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const file = userConfigFileOf(ctx)
  let text: string
  try {
    text = await ctx.readFile(file)
  } catch {
    return []
  }
  try {
    const root = asRecord(JSON.parse(text))
    const servers = asRecord(root?.mcpServers)
    if (!servers) return []
    return strList(Object.keys(servers)).map((name) => ({
      type: 'mcp' as const,
      name,
      provider: name.startsWith('plugin_') || name.startsWith('plugin-') ? 'plugin' : 'userSettings',
      source: file,
    }))
  } catch {
    return []
  }
}
