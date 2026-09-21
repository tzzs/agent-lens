/**
 * §5.1 `capabilities` — the static catalog behind "installed but never used" (§11).
 *
 * What codex.md actually proves exists is only `~/.codex/hooks.json` (§3.2: the config file
 * is supported, while the session log records ZERO hook events — so a configured hook is
 * precisely an "installed, never observable" entry). Everything else Codex can call is
 * per-thread state: `session_meta.dynamic_tools[]` is discovered inside the rollout stream
 * and reaches the event layer through `normalize`, not through this catalog.
 *
 * There is therefore NO skill, MCP-server or plugin catalog for Codex, and none is
 * invented here: an empty catalog is a correct answer, a fabricated one is not.
 */
import type { CapabilityCatalog, HostContext } from '@agentlens/event-model'
import { hooksFileOf } from './paths.ts'
import { arr, asRecord, str, strList } from './record.ts'

export async function capabilities(ctx: HostContext): Promise<CapabilityCatalog[]> {
  const file = hooksFileOf(ctx)
  let text: string
  try {
    text = await ctx.readFile(file)
  } catch {
    return [] // no hooks file: the honest answer for Codex is an empty catalog
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const out = new Map<string, CapabilityCatalog>()
  for (const entry of hookEntries(parsed)) {
    if (!out.has(entry.name)) out.set(entry.name, { type: 'hook', ...entry, source: file })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Accepts the shapes seen in agent hook configs: `{hooks:{Event:[…]}}`, `{hooks:[…]}`, `[…]`. */
function* hookEntries(parsed: unknown): Generator<{ name: string; provider: string | null }> {
  const root = asRecord(parsed)
  const groups: unknown[] = [
    ...(Array.isArray(parsed) ? parsed : []),
    ...(Array.isArray(root?.hooks) ? [root?.hooks] : []),
    ...Object.values(asRecord(root?.hooks) ?? {}),
    ...(root && !('hooks' in root) ? Object.entries(root).map(([, v]) => v) : []),
  ]
  for (const group of groups) {
    const items = Array.isArray(group) ? group : [group]
    for (const item of items) {
      const rec = asRecord(item)
      if (!rec) {
        const name = str(item)
        if (name) yield { name, provider: null }
        continue
      }
      const name =
        str(rec.name) ?? str(rec.hookName) ?? str(rec.event) ?? str(rec.hookEvent) ?? str(rec.matcher) ?? null
      const provider = str(rec.hookEvent) ?? str(rec.event) ?? null
      if (name) yield { name, provider: provider && provider !== name ? provider : null }
      // Command-shaped entries (`{matcher, hooks:[{type:'command', command}]}`).
      for (const nested of arr(rec.hooks)) {
        const n = str(nested.name) ?? str(nested.command) ?? str(nested.matcher)
        if (n) yield { name: n, provider: provider ?? str(nested.type) ?? null }
      }
      for (const n of strList(rec.events)) yield { name: n, provider }
    }
  }
}
