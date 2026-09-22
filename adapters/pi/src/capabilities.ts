/**
 * §5.1 `capabilities` — the static install surface only (docs/research/pi.md §四):
 * `~/.pi/agent/skills/<name>/SKILL.md` (a directory without SKILL.md is not evidence of
 * an installed skill) and `~/.pi/agent/extensions/*.ts` (a Pi extension IS a TypeScript
 * file, so the file name is the entity).
 *
 * Deliberately absent: MCP. Pi has no MCP registry in the measured layout and the trace
 * census shows no MCP invocation marker, so reporting one would guess "installed but
 * never used" (§11). Invoked capabilities reach the catalog through `normalize()`
 * instead, as they do for every other adapter.
 */
import { join } from 'node:path'
import type { CapabilityCatalog, HostContext } from '@agentlens/event-model'
import { extensionsDirOf, skillsDirOf, SKILL_MARKER_FILE } from './paths.ts'

export async function capabilities(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const out: CapabilityCatalog[] = []
  out.push(...(await skillDirs(ctx)))
  out.push(...(await extensions(ctx)))
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
    if (name.startsWith('.')) continue
    try {
      const entries = await ctx.readDir(join(dir, name))
      if (entries.includes(SKILL_MARKER_FILE)) {
        out.push({ type: 'skill', name, provider: 'userSettings', source: dir })
      }
    } catch {
      // not a directory, or unreadable: not evidence of an installed skill
    }
  }
  return out
}

async function extensions(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const dir = extensionsDirOf(ctx)
  let names: string[]
  try {
    names = await ctx.readDir(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.ts') && !n.startsWith('.'))
    .map((n) => ({
      type: 'plugin' as const,
      name: n.slice(0, -'.ts'.length),
      provider: null,
      source: dir,
    }))
}
