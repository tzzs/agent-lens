/**
 * §5.1 `capabilities` — only the static catalogs the probe proves exist on a
 * Qoder install: `~/.qoder/skills/*` (skill directories, fork convention) and
 * `~/.qoder/mcp-router.json` (present on the measured machine). Per-session
 * observations (`mcp_instructions`, `deferred_tools`, `skill_listing`
 * attachments) are NOT static catalogs and reach the cube through normalize
 * instead (§2.6 analogue). Every read failure yields no entries, never a throw.
 */
import { extname, join } from 'node:path'
import type { CapabilityCatalog, HostContext } from '@agentlens/event-model'
import { asRecord, arr, str } from './record.ts'
import { mcpRouterFileOf, skillsDirOf } from './paths.ts'

export async function capabilities(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const out: CapabilityCatalog[] = []
  out.push(...(await skillDirs(ctx)))
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
    try {
      const entries = await ctx.readDir(join(dir, name))
      if (entries.length > 0) out.push({ type: 'skill', name, provider: 'userSettings', source: dir })
    } catch {
      // unreadable subdirectory: not evidence of an installed skill
    }
  }
  return out
}

function isLikelyFile(name: string): boolean {
  const ext = extname(name)
  return ext !== '' && ext !== '.md' && ext !== '.json' && ext !== '.ts' && ext !== '.js'
}

/**
 * The router file's exact schema was not readable in the survey (permission
 * boundary), so the parser accepts every shape a fork could plausibly use:
 * object map, array of entries, or `{servers: …}` wrapper. Unknown shapes
 * return [] — absence beats invention.
 */
async function mcpServers(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const file = mcpRouterFileOf(ctx)
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
  const root = asRecord(parsed)
  const servers =
    root && asRecord(root.servers)
      ? (root.servers as Record<string, unknown>)
      : root && Array.isArray(root.servers)
        ? Object.fromEntries(
            arr(root.servers)
              .map((s) => [str(s.name) ?? str(s.id), s] as const)
              .filter((e): e is [string, Record<string, unknown>] => e[0] !== null),
          )
        : Array.isArray(parsed)
          ? Object.fromEntries(
              arr(parsed)
                .map((s) => [str(s.name) ?? str(s.id), s] as const)
                .filter((e): e is [string, Record<string, unknown>] => e[0] !== null),
            )
          : root ?? {}
  const out: CapabilityCatalog[] = []
  for (const [name, value] of Object.entries(servers)) {
    if (typeof value === 'object' && value !== null) {
      const meta = value as Record<string, unknown>
      out.push({ type: 'mcp', name, provider: str(meta.transport) ?? str(meta.type) ?? null, source: file })
    }
  }
  return out
}
