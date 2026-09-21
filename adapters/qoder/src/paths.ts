/**
 * Data-root layout (§18: Qoder is a Claude Code fork writing JSONL, not SQLite).
 * `QODER_CONFIG_DIR` is the fork's analogue of `CLAUDE_CONFIG_DIR`; the probe
 * script defaults to `~/.qoder` and documents no env switch, so this override
 * is a convention, only honoured for absolute paths.
 */
import { isAbsolute, join } from 'node:path'
import type { HostContext } from '@agentlens/event-model'

export function rootOf(ctx: HostContext): string {
  const fromEnv = ctx.env.QODER_CONFIG_DIR
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv
  if (ctx.dataRoot) return ctx.dataRoot
  return join(ctx.homedir, '.qoder')
}

export function projectsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), 'projects')
}

/** `~/.qoder/mcp-router.json` exists on the measured machine (probed via directory listing). */
export function mcpRouterFileOf(ctx: HostContext): string {
  return join(rootOf(ctx), 'mcp-router.json')
}

export function skillsDirOf(ctx: HostContext): string {
  return join(rootOf(ctx), 'skills')
}
